import { createHash, randomBytes } from "node:crypto";
import { appendFile, lstat, mkdir, open, readdir, readFile, rm, stat, unlink } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { assertNoLinkInPath, atomicWriteFile } from "./atomic-write.js";
import { AuditTamperError, RestoreRefusedError, SymlinkRefusedError } from "./errors.js";
import { legionPaths } from "./layout.js";
import { clearLiveRun, listLiveRunMarkers, liveRunFromResume, liveRunState } from "./live-run.js";
import { isTaskMarkdownPath, persistWork } from "./markdown.js";
import { rememberTaskWrite } from "./tasks-list.js";
import { toFsPath, toPosixPath } from "./paths.js";

const GENESIS_DIGEST = "0".repeat(64);

export type JournalOp = "write" | "delete";
export type JournalKind = "pre" | "post";

export type JournalEntry = {
  id: string;
  ts: string;
  commandId: string | null;
  path: string;
  op: JournalOp;
  oldHash: string | null;
  newHash: string | null;
  kind: JournalKind;
};

export type EngineCommandRecord = {
  id: string;
  startedAt: string;
  extraRoots: string[];
  files: Record<string, string>;
  hashedFiles: number;
  closedAt?: string;
};

export type EngineRestoreResult = {
  restored: string[];
  kept: string[];
  tampered: string[];
  reconciled: string[];
  quarantined: string[];
  filesHashed: number;
};

export type IncidentRecord = {
  id: string;
  ts: string;
  type: "tamper" | "quarantine" | "audit-chain";
  path?: string;
  commandId?: string;
  reason: string;
};

function sha256Bytes(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

export function sha256Content(contents: string | Buffer): string {
  return sha256Bytes(Buffer.isBuffer(contents) ? contents : Buffer.from(contents, "utf8"));
}

function blobPath(preImageDir: string, digest: string): string {
  return join(preImageDir, digest.slice(0, 2), digest);
}

function commandPath(journalDir: string, commandId: string): string {
  return join(journalDir, "commands", `${commandId}.json`);
}

function posixUnderRoot(root: string, abs: string): string | null {
  const rel = toPosixPath(relative(resolve(root), resolve(abs)));
  if (!rel || rel === "." || rel.startsWith("../") || rel === ".." || /^[A-Za-z]:/.test(rel)) return null;
  return rel;
}

function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*" && pattern[i + 1] === "*") {
      const afterSlash = pattern[i + 2] === "/";
      out += ".*";
      i += afterSlash ? 2 : 1;
      continue;
    }
    if (ch === "*") {
      out += "[^/]*";
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      continue;
    }
    if ("\\^$+()[]{}|.".includes(ch)) out += `\\${ch}`;
    else out += ch;
  }
  return new RegExp(`^${out}$`);
}

function matchesGlob(pattern: string, posixPath: string): boolean {
  return globToRegExp(pattern).test(posixPath);
}

const EXCLUDED_PREFIXES = [
  ".legion-cli/audit/",
  ".legion-cli/index/",
  ".legion-cli/cache/",
  ".legion-cli/chat/",
  ".legion-cli/sandbox/",
  ".legion-cli/worktrees/",
  ".legion-cli/runs/",
];

function isExcludedRestorePath(posix: string): boolean {
  if (posix === ".legion-cli/audit" || posix === ".legion-cli/index") return true;
  if (posix === ".legion-cli/cache" || posix === ".legion-cli/chat") return true;
  if (posix === ".legion-cli/sandbox" || posix === ".legion-cli/worktrees") return true;
  if (posix === ".legion-cli/runs") return true;
  return EXCLUDED_PREFIXES.some((prefix) => posix.startsWith(prefix));
}

/** Pinned engine-SoT: restored even when a skill contract lists the same roots. */
export function isPinnedEngineSot(posixPath: string): boolean {
  const posix = toPosixPath(posixPath);
  if (posix === ".legion-cli/STATE.md" || posix === ".legion-cli/config.yaml") return true;
  if (posix === ".legion-cli/tasks" || posix.startsWith(".legion-cli/tasks/")) return true;
  if (posix === ".legion-cli/qa" || posix.startsWith(".legion-cli/qa/")) return true;
  return false;
}

/** Pinned restore manifest plus command contract write-paths under `.legion-cli/`. chat/** is out. */
export function isRestoreManifestPath(posixPath: string, extraRoots: readonly string[] = []): boolean {
  const posix = toPosixPath(posixPath);
  if (!posix.startsWith(".legion-cli/")) return false;
  if (isExcludedRestorePath(posix)) return false;
  if (posix === ".legion-cli/STATE.md" || posix === ".legion-cli/config.yaml") return true;
  if (posix === ".legion-cli/tasks" || posix.startsWith(".legion-cli/tasks/")) return true;
  if (posix === ".legion-cli/specs" || posix.startsWith(".legion-cli/specs/")) return true;
  if (posix === ".legion-cli/qa" || posix.startsWith(".legion-cli/qa/")) return true;
  return extraRoots.some((root) => {
    const r = toPosixPath(root);
    if (!r.startsWith(".legion-cli/")) return false;
    if (isExcludedRestorePath(posix)) return false;
    return posix === r || posix.startsWith(`${r}/`) || matchesGlob(r, posix);
  });
}

export function shouldJournalPath(posixPath: string): boolean {
  const posix = toPosixPath(posixPath);
  if (!posix.startsWith(".legion-cli/")) return false;
  return !isExcludedRestorePath(posix);
}

async function assertStoreRoot(storeRoot: string, parentRoot: string): Promise<void> {
  await assertNoLinkInPath(storeRoot, { root: parentRoot, message: "store root is a symlink" });
}

async function ensureStoreRoot(storeRoot: string, parentRoot: string): Promise<void> {
  await assertStoreRoot(storeRoot, parentRoot);
  await mkdir(storeRoot, { recursive: true });
  await assertStoreRoot(storeRoot, parentRoot);
}

async function putBlob(projectRoot: string, bytes: Buffer): Promise<string> {
  const digest = sha256Bytes(bytes);
  const paths = legionPaths(projectRoot);
  await ensureStoreRoot(paths.preImageDir, paths.indexDir);
  const abs = blobPath(paths.preImageDir, digest);
  try {
    const st = await lstat(abs);
    if (st.isFile() && !st.isSymbolicLink()) return digest;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  await atomicWriteFile(abs, bytes, { root: paths.preImageDir, symlinkMessage: "pre-image store is a symlink" });
  return digest;
}

export async function readBlob(projectRoot: string, digest: string): Promise<Buffer> {
  const paths = legionPaths(projectRoot);
  await assertStoreRoot(paths.preImageDir, paths.indexDir);
  const abs = blobPath(paths.preImageDir, digest);
  await assertNoLinkInPath(abs, { root: paths.preImageDir, message: "pre-image blob is a symlink" });
  try {
    return await readFile(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new RestoreRefusedError(`pre-image blob missing for digest ${digest}`);
    }
    throw err;
  }
}

async function writeJournalEntry(projectRoot: string, entry: JournalEntry): Promise<void> {
  const paths = legionPaths(projectRoot);
  await ensureStoreRoot(paths.journalDir, paths.indexDir);
  const abs = join(paths.journalDir, `${entry.ts.replace(/[:.]/g, "-")}-${entry.id}.json`);
  await atomicWriteFile(abs, `${JSON.stringify(entry)}\n`, {
    root: paths.journalDir,
    symlinkMessage: "journal store is a symlink",
  });
}

export async function listJournalEntries(projectRoot: string): Promise<JournalEntry[]> {
  const paths = legionPaths(projectRoot);
  let names: string[];
  try {
    names = await readdir(paths.journalDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: JournalEntry[] = [];
  for (const name of names) {
    if (!name.endsWith(".json") || name === "commands") continue;
    const abs = join(paths.journalDir, name);
    try {
      const st = await lstat(abs);
      if (!st.isFile() || st.isSymbolicLink()) continue;
      const parsed = JSON.parse(await readFile(abs, "utf8")) as JournalEntry;
      if (parsed && typeof parsed.path === "string" && typeof parsed.id === "string") out.push(parsed);
    } catch {
      continue;
    }
  }
  out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id.localeCompare(b.id)));
  return out;
}

async function writeCommandRecord(projectRoot: string, record: EngineCommandRecord): Promise<void> {
  const paths = legionPaths(projectRoot);
  await ensureStoreRoot(paths.journalDir, paths.indexDir);
  const commandsDir = join(paths.journalDir, "commands");
  await ensureStoreRoot(commandsDir, paths.journalDir);
  await atomicWriteFile(commandPath(paths.journalDir, record.id), `${JSON.stringify(record)}\n`, {
    root: paths.journalDir,
    symlinkMessage: "journal store is a symlink",
  });
}

export async function readCommandRecord(
  projectRoot: string,
  commandId: string,
): Promise<EngineCommandRecord | null> {
  const paths = legionPaths(projectRoot);
  try {
    await assertStoreRoot(paths.journalDir, paths.indexDir);
    const abs = commandPath(paths.journalDir, commandId);
    await assertNoLinkInPath(abs, { root: paths.journalDir });
    return JSON.parse(await readFile(abs, "utf8")) as EngineCommandRecord;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function listOpenCommandIds(projectRoot: string): Promise<string[]> {
  const paths = legionPaths(projectRoot);
  const dir = join(paths.journalDir, "commands");
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const open: string[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const rec = JSON.parse(await readFile(join(dir, name), "utf8")) as EngineCommandRecord;
      if (rec?.id && !rec.closedAt) open.push(rec.id);
    } catch {
      continue;
    }
  }
  return open.sort();
}

/** Optional visit hook: called with each posix path (file or directory) the walk touches. */
export type RestoreWalkVisit = (posix: string) => void;

async function walkFiles(
  projectRoot: string,
  relDir: string,
  out: string[],
  visit?: RestoreWalkVisit,
): Promise<void> {
  // Excluded subtrees (worktrees, index/journal, cache/runs, ...) hold nothing restorable: never enumerate.
  if (relDir && isExcludedRestorePath(relDir)) return;
  visit?.(relDir);
  const abs = relDir ? toFsPath(projectRoot, relDir) : projectRoot;
  try {
    const st = await lstat(abs);
    if (st.isSymbolicLink()) return;
    if (st.isFile()) {
      if (relDir) out.push(relDir);
      return;
    }
    if (!st.isDirectory()) return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  let entries;
  try {
    entries = await readdir(abs, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT" || (err as NodeJS.ErrnoException).code === "ENOTDIR") return;
    throw err;
  }
  for (const entry of entries) {
    const posix = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await walkFiles(projectRoot, posix, out, visit);
    else if (entry.isFile()) out.push(posix);
  }
}

/** Static directory prefix of a root or glob: the segments before the first wildcard segment. */
function staticRootPrefix(root: string): string {
  const kept: string[] = [];
  for (const seg of root.split("/")) {
    if (seg.includes("*") || seg.includes("?")) break;
    if (seg) kept.push(seg);
  }
  return kept.join("/");
}

const PINNED_WALK_ROOTS = [
  ".legion-cli/STATE.md",
  ".legion-cli/config.yaml",
  ".legion-cli/tasks",
  ".legion-cli/specs",
  ".legion-cli/qa",
];

export async function listRestoreManifestPaths(
  projectRoot: string,
  extraRoots: readonly string[] = [],
  visit?: RestoreWalkVisit,
): Promise<string[]> {
  const found: string[] = [];
  // Walk only roots isRestoreManifestPath can accept: the pinned roots plus each extra root's static prefix.
  const starts = new Set<string>(PINNED_WALK_ROOTS);
  for (const root of extraRoots.map(toPosixPath)) {
    if (!root.startsWith(".legion-cli/")) continue;
    const prefix = staticRootPrefix(root);
    if (prefix === ".legion-cli" || prefix.startsWith(".legion-cli/")) starts.add(prefix);
  }
  for (const start of [...starts].sort()) await walkFiles(projectRoot, start, found, visit);
  const unique = [...new Set(found)];
  return unique.filter((posix) => isRestoreManifestPath(posix, extraRoots)).sort();
}

async function snapshotFile(
  projectRoot: string,
  posix: string,
): Promise<{ digest: string; bytes: Buffer } | null> {
  const abs = toFsPath(projectRoot, posix);
  try {
    const st = await lstat(abs);
    if (st.isSymbolicLink() || !st.isFile()) return null;
    const bytes = await readFile(abs);
    const digest = await putBlob(projectRoot, bytes);
    return { digest, bytes };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function openEngineCommand(
  projectRoot: string,
  commandId: string,
  opts?: { extraRoots?: readonly string[] },
): Promise<EngineCommandRecord> {
  await assertStoreRootsNotLinked(projectRoot);
  const extraRoots = [...(opts?.extraRoots ?? [])];
  const files: Record<string, string> = {};
  let hashedFiles = 0;
  for (const posix of await listRestoreManifestPaths(projectRoot, extraRoots)) {
    const snap = await snapshotFile(projectRoot, posix);
    if (!snap) continue;
    files[posix] = snap.digest;
    hashedFiles += 1;
  }
  const record: EngineCommandRecord = {
    id: commandId,
    startedAt: new Date().toISOString(),
    extraRoots,
    files,
    hashedFiles,
  };
  await writeCommandRecord(projectRoot, record);
  return record;
}

export async function closeEngineCommand(projectRoot: string, commandId: string): Promise<void> {
  const existing = await readCommandRecord(projectRoot, commandId);
  if (!existing) return;
  await writeCommandRecord(projectRoot, { ...existing, closedAt: new Date().toISOString() });
}

function newEntryId(): string {
  return randomBytes(8).toString("hex");
}

async function currentBytes(abs: string): Promise<Buffer | null> {
  try {
    const st = await lstat(abs);
    if (st.isSymbolicLink() || !st.isFile()) return null;
    return await readFile(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

let journalTail: Promise<void> = Promise.resolve();

function withJournalLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = journalTail.then(fn, fn);
  journalTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export async function journalPreWrite(
  projectRoot: string,
  absPath: string,
  newBytes: Buffer,
  opts?: { commandId?: string | null; op?: JournalOp },
): Promise<JournalEntry> {
  return withJournalLock(async () => {
    const posix = posixUnderRoot(projectRoot, absPath);
    if (!posix) {
      throw new RestoreRefusedError(`journal path escaped project: ${absPath}`);
    }
    const old = await currentBytes(absPath);
    const oldHash = old ? await putBlob(projectRoot, old) : null;
    const op = opts?.op ?? "write";
    const newHash = op === "delete" ? null : await putBlob(projectRoot, newBytes);
    const entry: JournalEntry = {
      id: newEntryId(),
      ts: new Date().toISOString(),
      commandId: opts?.commandId ?? null,
      path: posix,
      op,
      oldHash,
      newHash,
      kind: "pre",
    };
    await writeJournalEntry(projectRoot, entry);
    return entry;
  });
}

export async function journalPostWrite(
  projectRoot: string,
  pre: JournalEntry,
): Promise<JournalEntry> {
  return withJournalLock(async () => {
    const entry: JournalEntry = {
      ...pre,
      id: newEntryId(),
      ts: new Date().toISOString(),
      kind: "post",
    };
    await writeJournalEntry(projectRoot, entry);
    return entry;
  });
}

export async function journaledWriteFile(
  projectRoot: string,
  absPath: string,
  contents: string | Buffer,
  opts?: { commandId?: string | null },
): Promise<void> {
  const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(contents, "utf8");
  const posix = posixUnderRoot(projectRoot, absPath);
  if (!posix || !shouldJournalPath(posix)) {
    await atomicWriteFile(absPath, bytes, { root: projectRoot });
    return;
  }
  const pre = await journalPreWrite(projectRoot, absPath, bytes, { commandId: opts?.commandId });
  await atomicWriteFile(absPath, bytes, { root: projectRoot });
  await journalPostWrite(projectRoot, pre);
}

export async function journaledRemove(
  projectRoot: string,
  absPath: string,
  opts?: { commandId?: string | null },
): Promise<void> {
  const posix = posixUnderRoot(projectRoot, absPath);
  if (!posix || !shouldJournalPath(posix)) {
    await rm(absPath, { recursive: true, force: true });
    return;
  }
  const pre = await journalPreWrite(projectRoot, absPath, Buffer.alloc(0), {
    commandId: opts?.commandId,
    op: "delete",
  });
  await rm(absPath, { recursive: true, force: true });
  await journalPostWrite(projectRoot, pre);
}

export async function writeIncident(projectRoot: string, incident: Omit<IncidentRecord, "id" | "ts">): Promise<IncidentRecord> {
  const paths = legionPaths(projectRoot);
  await ensureStoreRoot(paths.incidentDir, paths.indexDir);
  const record: IncidentRecord = {
    id: newEntryId(),
    ts: new Date().toISOString(),
    ...incident,
  };
  const abs = join(paths.incidentDir, `${record.ts.replace(/[:.]/g, "-")}-${record.id}.json`);
  await atomicWriteFile(abs, `${JSON.stringify(record)}\n`, {
    root: paths.incidentDir,
    symlinkMessage: "incident store is a symlink",
  });
  return record;
}

export async function listIncidents(projectRoot: string): Promise<IncidentRecord[]> {
  const paths = legionPaths(projectRoot);
  let names: string[];
  try {
    names = await readdir(paths.incidentDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: IncidentRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(await readFile(join(paths.incidentDir, name), "utf8")) as IncidentRecord);
    } catch {
      continue;
    }
  }
  out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id.localeCompare(b.id)));
  return out;
}

async function applyDigest(
  projectRoot: string,
  posix: string,
  digest: string | null,
): Promise<void> {
  const abs = toFsPath(projectRoot, posix);
  if (digest == null) {
    try {
      const st = await lstat(abs);
      if (st.isSymbolicLink() || st.isFile()) await unlink(abs);
      else await rm(abs, { recursive: true, force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    return;
  }
  const bytes = await readBlob(projectRoot, digest);
  await atomicWriteFile(abs, bytes, { root: projectRoot });
  // A restore is not a `writeTextFile`: keep the derived task-summary cache in step.
  if (isTaskMarkdownPath(abs)) await rememberTaskWrite(projectRoot, abs, bytes);
}

function currentHashOf(bytes: Buffer | null): string | null {
  return bytes ? sha256Bytes(bytes) : null;
}

function lastForPath(entries: JournalEntry[], posix: string): { pre?: JournalEntry; post?: JournalEntry } {
  let pre: JournalEntry | undefined;
  let post: JournalEntry | undefined;
  for (const entry of entries) {
    if (entry.path !== posix) continue;
    if (entry.kind === "pre") pre = entry;
    else post = entry;
  }
  return { pre, post };
}

function isContractAllowed(posix: string, allowedRoots: readonly string[]): boolean {
  return allowedRoots.some((root) => {
    const r = toPosixPath(root);
    return posix === r || posix.startsWith(`${r}/`) || matchesGlob(r, posix);
  });
}

export async function restoreEngineState(
  projectRoot: string,
  commandId: string,
  opts?: { agentAlive?: boolean; jailWritable?: boolean; allowedRoots?: readonly string[] },
): Promise<EngineRestoreResult> {
  if (opts?.agentAlive) {
    throw new RestoreRefusedError("restore refused while the agent process tree is alive");
  }
  if (opts?.jailWritable) {
    throw new RestoreRefusedError("restore refused while the jail is writable");
  }
  const command = await readCommandRecord(projectRoot, commandId);
  if (!command) {
    throw new RestoreRefusedError(`restore refused: unknown command ${commandId}`);
  }
  try {
    await healAuditChain(projectRoot);
  } catch (err) {
    if (err instanceof AuditTamperError) {
      try {
        await writeIncident(projectRoot, {
          type: "audit-chain",
          commandId,
          reason: err.message,
        });
      } catch {
        // still fail closed
      }
      throw err;
    }
    throw err;
  }
  const extraRoots = command.extraRoots;
  const allowedRoots = opts?.allowedRoots ?? command.extraRoots;
  const currentPaths = await listRestoreManifestPaths(projectRoot, extraRoots);
  const journal = (await listJournalEntries(projectRoot)).filter((entry) => entry.ts >= command.startedAt);
  const journaledPaths = journal.map((entry) => entry.path).filter((posix) => isRestoreManifestPath(posix, extraRoots));
  const union = new Set([...Object.keys(command.files), ...currentPaths, ...journaledPaths]);

  const restored: string[] = [];
  const kept: string[] = [];
  const tampered: string[] = [];
  const reconciled: string[] = [];
  const quarantined: string[] = [];

  for (const posix of [...union].sort()) {
    if (!isRestoreManifestPath(posix, extraRoots)) continue;
    const abs = toFsPath(projectRoot, posix);
    const bytes = await currentBytes(abs);
    const currentHash = currentHashOf(bytes);
    const { pre, post } = lastForPath(journal, posix);
    const incomplete = Boolean(pre && (!post || pre.ts > post.ts));

    if (incomplete && pre) {
      if (currentHash === pre.newHash) {
        kept.push(posix);
        continue;
      }
      await applyDigest(projectRoot, posix, pre.oldHash);
      reconciled.push(posix);
      continue;
    }

    if (post && !pre) {
      await writeIncident(projectRoot, {
        type: "quarantine",
        path: posix,
        commandId,
        reason: "post-op journal row without pre-op",
      });
      quarantined.push(posix);
      continue;
    }

    const intended = post?.newHash ?? (pre && currentHash === pre.newHash ? pre.newHash : undefined);
    if (intended !== undefined && (post || pre)) {
      if (currentHash === intended) {
        kept.push(posix);
        continue;
      }
      await writeIncident(projectRoot, {
        type: "tamper",
        path: posix,
        commandId,
        reason: "journaled path hash differs from engine bytes",
      });
      await applyDigest(projectRoot, posix, intended);
      tampered.push(posix);
      continue;
    }

    if (isContractAllowed(posix, allowedRoots) && !isPinnedEngineSot(posix)) continue;

    const preDigest = command.files[posix] ?? null;
    if (currentHash === preDigest) continue;
    await applyDigest(projectRoot, posix, preDigest);
    restored.push(posix);
  }

  await closeEngineCommand(projectRoot, commandId);
  return {
    restored,
    kept,
    tampered,
    reconciled,
    quarantined,
    filesHashed: command.hashedFiles,
  };
}

/** resume.json fallback for marker-less runs. Our own pid never counts (in-process fakes, dashboards). */
async function resumeRunIsForeignAndLive(projectRoot: string, runId: string): Promise<boolean> {
  try {
    const raw = await readFile(join(legionPaths(projectRoot).cacheDir, "runs", runId, "resume.json"), "utf8");
    const resume = JSON.parse(raw) as { runId?: string; skillId?: string; taskId?: string | null; pid?: number | null; enginePid?: number | null; startedAt?: string };
    if (typeof resume.runId !== "string" || typeof resume.skillId !== "string" || typeof resume.startedAt !== "string") return false;
    const marker = liveRunFromResume({ ...resume, runId: resume.runId, skillId: resume.skillId, startedAt: resume.startedAt });
    if (marker.agentPid === process.pid) marker.agentPid = null;
    if (marker.enginePid === process.pid) marker.enginePid = 0;
    return (await liveRunState(marker)).live;
  } catch {
    return false;
  }
}

/**
 * Restore every open command whose run is gone. A command whose live-run marker still has a live
 * engine or agent belongs to a running command: restoring under it would revert its writes
 * (F-016), so it is left open and skipped. A restored run's dead marker is cleared.
 */
export async function reconcileUnfinishedCommands(projectRoot: string): Promise<string[]> {
  const open = await listOpenCommandIds(projectRoot);
  const markers = new Map((await listLiveRunMarkers(projectRoot)).map((marker) => [marker.runId, marker]));
  const done: string[] = [];
  for (const id of open) {
    const rec = await readCommandRecord(projectRoot, id);
    if (!rec) continue;
    const marker = markers.get(id);
    if (marker) {
      const state = await liveRunState(marker);
      if (state.live) continue;
    } else if (await resumeRunIsForeignAndLive(projectRoot, id)) {
      // No marker (older binary): a recorded process other than us still holds its identity.
      continue;
    }
    await restoreEngineState(projectRoot, id, { agentAlive: false, jailWritable: false });
    if (marker) await clearLiveRun(projectRoot, id);
    done.push(id);
  }
  return done;
}

const AUDIT_CHAIN_STORE = ".legion-cli/audit/chain.json";

export type AuditChainState = {
  lastDigest: string;
  length: number;
  /** Bytes of events.jsonl the chain covers. Absent in the old format. */
  byteOffset?: number;
  /** 2 = byteOffset is trusted for tail-only verification. */
  format?: number;
  /**
   * sha256 of the last chained line: anchors `byteOffset` to the bytes it was taken from. A log
   * rewritten under the chain (git's CRLF conversion on checkout) moves the offset off a line end,
   * so the anchor no longer matches and the full replay runs instead of hashing line fragments.
   */
  lastLine?: string;
};

const AUDIT_REMEDY =
  "Review .legion-cli/audit/events.jsonl, then run `legion-cli doctor --rebaseline-audit` to accept it as the new baseline (recorded as an audit_rebaselined event).";

function auditTamper(reason: string): AuditTamperError {
  return new AuditTamperError(`${reason}. ${AUDIT_REMEDY}`);
}

/** chain.json layout that carries `byteOffset`. Older files lack it; newer ones are fully re-verified. */
const AUDIT_CHAIN_FORMAT = 2;

function auditChainAbs(projectRoot: string): string {
  return toFsPath(projectRoot, AUDIT_CHAIN_STORE);
}

function auditJsonlAbs(projectRoot: string): string {
  return toFsPath(projectRoot, ".legion-cli/audit/events.jsonl");
}

export function auditLineDigest(prev: string, line: string): string {
  return sha256Content(`${prev}\n${line}`);
}

export async function readAuditChain(projectRoot: string): Promise<AuditChainState> {
  let raw: string;
  try {
    raw = await readFile(auditChainAbs(projectRoot), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return { lastDigest: GENESIS_DIGEST, length: 0 };
  }
  let parsed: AuditChainState | null = null;
  try {
    parsed = JSON.parse(raw) as AuditChainState;
  } catch {
    parsed = null;
  }
  if (
    !parsed ||
    typeof parsed.lastDigest !== "string" ||
    typeof parsed.length !== "number" ||
    !Number.isInteger(parsed.length) ||
    parsed.length < 0
  ) {
    throw auditTamper("audit chain unreadable: .legion-cli/audit/chain.json is corrupt, empty or has the wrong shape");
  }
  return parsed;
}

/** Non-empty lines of a buffer, split like the original reader (`\n`, one trailing `\r` dropped). */
function auditLinesOf(buf: Buffer): string[] {
  const lines: string[] = [];
  let start = 0;
  while (start < buf.length) {
    let end = buf.indexOf(0x0a, start);
    if (end === -1) end = buf.length;
    let stop = end;
    if (stop > start && buf[stop - 1] === 0x0d) stop -= 1;
    const text = buf.toString("utf8", start, stop);
    if (text.trim().length > 0) lines.push(text);
    start = end + 1;
  }
  return lines;
}

function extendDigest(digest: string, lines: readonly string[]): string {
  let next = digest;
  for (const line of lines) {
    next = auditLineDigest(next, line);
    persistWork.auditLinesHashed += 1;
  }
  return next;
}

function chainTrusted(stored: AuditChainState): boolean {
  return (
    stored.format === AUDIT_CHAIN_FORMAT &&
    typeof stored.byteOffset === "number" &&
    Number.isInteger(stored.byteOffset) &&
    stored.byteOffset >= 0 &&
    (stored.length === 0 || typeof stored.lastLine === "string")
  );
}

function lastLineAnchor(lines: readonly string[]): { lastLine?: string } {
  const last = lines[lines.length - 1];
  return last === undefined ? {} : { lastLine: sha256Content(last) };
}

/** Longest audit line the anchor check reads back; a longer last line just takes the full replay. */
const AUDIT_ANCHOR_WINDOW = 256 * 1024;

/**
 * True when the bytes of events.jsonl just before `offset` end with a newline and with the line
 * the chain says it covered last. False means the offset no longer points at the chained prefix.
 */
async function anchorHolds(projectRoot: string, stored: AuditChainState, offset: number): Promise<boolean> {
  if (offset === 0) return stored.length === 0;
  const handle = await open(auditJsonlAbs(projectRoot), "r");
  try {
    // Read back from the offset, doubling the window until it holds the whole last line: the
    // routine cost stays proportional to one line, not to the log.
    for (let span = Math.min(offset, 256); ; span = Math.min(offset, span * 2)) {
      const window = Buffer.alloc(span);
      const { bytesRead } = await handle.read(window, 0, span, offset - span);
      persistWork.auditBytesRead += bytesRead;
      if (bytesRead !== span || window[span - 1] !== 0x0a) return false;
      const whole = span === offset || window.lastIndexOf(0x0a, span - 2) !== -1;
      if (whole) {
        const last = auditLinesOf(window).at(-1);
        return last !== undefined && sha256Content(last) === stored.lastLine;
      }
      if (span >= AUDIT_ANCHOR_WINDOW) return false;
    }
  } finally {
    await handle.close();
  }
}

async function writeAuditChain(projectRoot: string, state: AuditChainState): Promise<void> {
  const paths = legionPaths(projectRoot);
  await atomicWriteFile(auditChainAbs(projectRoot), `${JSON.stringify(state)}\n`, {
    root: paths.auditDir,
    symlinkMessage: "audit chain path is a symlink",
  });
}

/**
 * Tail-only verification: the stored chain is trusted for the first `byteOffset` bytes and only
 * bytes after it are hashed (a crash between the line and the chain write leaves such a tail,
 * which is healed here). The middle of the log is checked by the full replay in
 * {@link verifyAuditChain}, run at doctor, status and before ship. A file shorter than the offset,
 * or bytes at the offset that no longer end with the last chained line (line endings converted on
 * checkout), fall back to that full replay: it refuses a real rewind or rewrite and re-anchors a
 * log whose bytes changed but whose lines did not.
 */
async function extendAuditChainFromTail(projectRoot: string, stored: AuditChainState): Promise<AuditChainState> {
  const offset = stored.byteOffset as number;
  let size = 0;
  try {
    size = (await stat(auditJsonlAbs(projectRoot))).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (size < offset || !(await anchorHolds(projectRoot, stored, offset))) {
    return verifyAuditChain(projectRoot, { allowExtend: true });
  }
  const base: AuditChainState = {
    lastDigest: stored.lastDigest,
    length: stored.length,
    byteOffset: offset,
    format: AUDIT_CHAIN_FORMAT,
    ...(stored.lastLine !== undefined ? { lastLine: stored.lastLine } : {}),
  };
  if (size === offset) return base;
  const handle = await open(auditJsonlAbs(projectRoot), "r");
  let tail: Buffer;
  try {
    tail = Buffer.alloc(size - offset);
    const { bytesRead } = await handle.read(tail, 0, tail.length, offset);
    persistWork.auditBytesRead += bytesRead;
    tail = tail.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  const lines = auditLinesOf(tail);
  return {
    format: AUDIT_CHAIN_FORMAT,
    lastDigest: extendDigest(stored.lastDigest, lines),
    length: stored.length + lines.length,
    byteOffset: offset + tail.length,
    ...(lines.length > 0 ? lastLineAnchor(lines) : base.lastLine !== undefined ? { lastLine: base.lastLine } : {}),
  };
}

/**
 * Append one line to events.jsonl and advance chain.json. Caller holds the engine lock. Routine
 * cost is proportional to the unchained tail (normally empty), not to the log.
 */
export async function appendChainedAuditLine(projectRoot: string, line: string): Promise<AuditChainState> {
  const paths = legionPaths(projectRoot);
  await ensureStoreRoot(paths.auditDir, paths.root);
  const stored = await readAuditChain(projectRoot);
  const base = chainTrusted(stored)
    ? await extendAuditChainFromTail(projectRoot, stored)
    : await verifyAuditChain(projectRoot, { allowExtend: true });
  const offset = base.byteOffset ?? 0;
  let needNewline = false;
  if (offset > 0) {
    const handle = await open(auditJsonlAbs(projectRoot), "r");
    try {
      const last = Buffer.alloc(1);
      await handle.read(last, 0, 1, offset - 1);
      needNewline = last[0] !== 0x0a;
    } finally {
      await handle.close();
    }
  }
  const text = `${needNewline ? "\n" : ""}${line}\n`;
  await appendFile(auditJsonlAbs(projectRoot), text, "utf8");
  const next: AuditChainState = {
    format: AUDIT_CHAIN_FORMAT,
    lastDigest: extendDigest(base.lastDigest, [line]),
    length: base.length + 1,
    byteOffset: offset + Buffer.byteLength(text),
    ...lastLineAnchor([line]),
  };
  await writeAuditChain(projectRoot, next);
  return next;
}

/**
 * Full replay of events.jsonl against chain.json. A stored prefix that no longer matches its digest
 * (an edited or removed line) is tamper. With `allowExtend`, lines beyond the stored length are
 * accepted (a crash between the line and the chain write) and returned; without it they are a gap.
 */
export async function verifyAuditChain(
  projectRoot: string,
  opts?: { allowExtend?: boolean; /** test seam: runs between the chain read and the log read */ afterChainRead?: () => Promise<void> },
): Promise<AuditChainState> {
  // Chain first, log second: an append landing between the reads only makes the log longer than
  // the stored length (the accepted crash-gap shape), never shorter (a false rewind).
  const stored = await readAuditChain(projectRoot);
  if (opts?.afterChainRead) await opts.afterChainRead();
  let buf: Buffer;
  try {
    buf = await readFile(auditJsonlAbs(projectRoot));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    if (stored.length > 0) throw auditTamper("audit chain rewind refused");
    return stored;
  }
  persistWork.auditBytesRead += buf.length;
  const lines = auditLinesOf(buf);
  if (stored.length > lines.length) {
    throw auditTamper("audit chain rewind refused");
  }
  if (stored.length === 0 && lines.length > 1) {
    // A missing or reset chain.json must not quietly bless a log that may already be edited.
    throw auditTamper("audit chain missing or reset for a non-empty log");
  }
  const prefixDigest = extendDigest(GENESIS_DIGEST, lines.slice(0, stored.length));
  if (stored.length > 0 && prefixDigest !== stored.lastDigest) {
    throw auditTamper("audit chain gap or rewrite");
  }
  if (lines.length > stored.length && !opts?.allowExtend) {
    throw auditTamper("audit chain gap or rewrite");
  }
  const digest = extendDigest(prefixDigest, lines.slice(stored.length));
  return {
    format: AUDIT_CHAIN_FORMAT,
    lastDigest: digest,
    length: lines.length,
    byteOffset: buf.length,
    ...lastLineAnchor(lines),
  };
}

/**
 * Cheap pre-mutation check (no full replay): chain.json must be readable, the log must not be
 * shorter than the chain covers, and a reset chain must not sit over a multi-line log.
 */
export async function assertAuditChainUsable(projectRoot: string): Promise<void> {
  const stored = await readAuditChain(projectRoot);
  let size = 0;
  try {
    size = (await stat(auditJsonlAbs(projectRoot))).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (chainTrusted(stored) && size < (stored.byteOffset as number)) {
    // Shorter than the offset: a rewind, or the same lines with CRLF endings turned back into LF.
    // Only the line-level replay can tell them apart.
    await verifyAuditChain(projectRoot, { allowExtend: true });
    return;
  }
  if (stored.length > 0 && size === 0) throw auditTamper("audit chain rewind refused");
  if (stored.length === 0 && size > 0) {
    const lines = auditLinesOf(await readFile(auditJsonlAbs(projectRoot)));
    if (lines.length > 1) throw auditTamper("audit chain missing or reset for a non-empty log");
  }
}

/**
 * The exact check the next audit append would make, without writing: a trusted chain must not be
 * rewound, and an untrusted one is fully replayed. Call before a verb changes any state, so a
 * chain problem refuses up front instead of after the task or phase has moved.
 */
export async function assertAuditAppendable(projectRoot: string): Promise<void> {
  const stored = await readAuditChain(projectRoot);
  if (chainTrusted(stored)) await extendAuditChainFromTail(projectRoot, stored);
  else await verifyAuditChain(projectRoot, { allowExtend: true });
}

/**
 * Explicit re-baseline: re-chain the whole current log into a fresh chain.json. The caller (under
 * the engine lock) records an audit_rebaselined event afterwards. Returns what was replaced.
 */
export async function baselineAuditChain(projectRoot: string): Promise<{
  lines: number;
  unparseable: number;
  previous: { length: number; lastDigest: string } | null;
}> {
  let previous: { length: number; lastDigest: string } | null = null;
  try {
    const stored = await readAuditChain(projectRoot);
    previous = stored.length > 0 ? { length: stored.length, lastDigest: stored.lastDigest } : null;
  } catch {
    previous = null;
  }
  let buf = Buffer.alloc(0);
  try {
    buf = await readFile(auditJsonlAbs(projectRoot));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const lines = auditLinesOf(buf);
  let unparseable = 0;
  for (const line of lines) {
    try {
      JSON.parse(line);
    } catch {
      unparseable += 1;
    }
  }
  const paths = legionPaths(projectRoot);
  await ensureStoreRoot(paths.auditDir, paths.root);
  if (lines.length > 0) {
    await writeAuditChain(projectRoot, {
      format: AUDIT_CHAIN_FORMAT,
      lastDigest: extendDigest(GENESIS_DIGEST, lines),
      length: lines.length,
      byteOffset: buf.length,
      ...lastLineAnchor(lines),
    });
  } else {
    await rm(auditChainAbs(projectRoot), { force: true });
  }
  return { lines: lines.length, unparseable, previous };
}

/**
 * Full replay that also repairs a healable chain (a crash gap, an old-format or newer-format file)
 * by rewriting chain.json. Tamper still throws. Caller holds the engine lock.
 */
export async function healAuditChain(projectRoot: string): Promise<AuditChainState> {
  const stored = await readAuditChain(projectRoot);
  const verified = await verifyAuditChain(projectRoot, { allowExtend: true });
  const same =
    chainTrusted(stored) && verified.length === stored.length && verified.byteOffset === stored.byteOffset;
  if (verified.length > 0 && !same) await writeAuditChain(projectRoot, verified);
  return verified;
}

export async function assertStoreRootsNotLinked(projectRoot: string): Promise<void> {
  const paths = legionPaths(projectRoot);
  await assertStoreRoot(paths.preImageDir, paths.indexDir);
  await assertStoreRoot(paths.journalDir, paths.indexDir);
  await assertStoreRoot(paths.incidentDir, paths.indexDir);
}

export function posixFromAbs(projectRoot: string, abs: string): string | null {
  return posixUnderRoot(projectRoot, abs);
}
