import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rm, unlink } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { assertNoLinkInPath, atomicWriteFile } from "./atomic-write.js";
import { AuditTamperError, RestoreRefusedError, SymlinkRefusedError } from "./errors.js";
import { legionPaths } from "./layout.js";
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

async function walkFiles(projectRoot: string, relDir: string, out: string[]): Promise<void> {
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
    if (entry.isDirectory()) await walkFiles(projectRoot, posix, out);
    else if (entry.isFile()) out.push(posix);
  }
}

export async function listRestoreManifestPaths(
  projectRoot: string,
  extraRoots: readonly string[] = [],
): Promise<string[]> {
  const found: string[] = [];
  await walkFiles(projectRoot, ".legion-cli", found);
  const extraStarts = extraRoots
    .map(toPosixPath)
    .filter((root) => root.startsWith(".legion-cli/") && !isExcludedRestorePath(root.replace(/\/\*\*$/, "/")));
  for (const root of extraStarts) {
    const base = root.replace(/\/\*\*$/, "").replace(/\/\*$/, "");
    if (base.includes("*")) continue;
    await walkFiles(projectRoot, base, found);
  }
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
    await verifyAuditChain(projectRoot);
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
  let currentPaths = await listRestoreManifestPaths(projectRoot, extraRoots);
  for (const posix of currentPaths) {
    if (command.files[posix]) continue;
    if (!isPinnedEngineSot(posix)) continue;
    if (posix === ".legion-cli/STATE.md" || posix === ".legion-cli/config.yaml") continue;
    if (!isContractAllowed(posix, allowedRoots)) continue;
    const abs = toFsPath(projectRoot, posix);
    const bytes = await currentBytes(abs);
    if (!bytes) continue;
    await journaledWriteFile(projectRoot, abs, bytes);
  }
  const journal = (await listJournalEntries(projectRoot)).filter((entry) => entry.ts >= command.startedAt);
  currentPaths = await listRestoreManifestPaths(projectRoot, extraRoots);
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

export async function reconcileUnfinishedCommands(projectRoot: string): Promise<string[]> {
  const open = await listOpenCommandIds(projectRoot);
  const done: string[] = [];
  for (const id of open) {
    const rec = await readCommandRecord(projectRoot, id);
    if (!rec) continue;
    await restoreEngineState(projectRoot, id, { agentAlive: false, jailWritable: false });
    done.push(id);
  }
  return done;
}

const AUDIT_CHAIN_STORE = ".legion-cli/audit/chain.json";

export type AuditChainState = {
  lastDigest: string;
  length: number;
};

function auditChainAbs(projectRoot: string): string {
  return toFsPath(projectRoot, AUDIT_CHAIN_STORE);
}

export function auditLineDigest(prev: string, line: string): string {
  return sha256Content(`${prev}\n${line}`);
}

export async function readAuditChain(projectRoot: string): Promise<AuditChainState> {
  try {
    const parsed = JSON.parse(await readFile(auditChainAbs(projectRoot), "utf8")) as AuditChainState;
    if (parsed && typeof parsed.lastDigest === "string" && typeof parsed.length === "number") return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return { lastDigest: GENESIS_DIGEST, length: 0 };
}

export async function appendAuditChainLine(projectRoot: string, _line: string): Promise<AuditChainState> {
  const paths = legionPaths(projectRoot);
  await ensureStoreRoot(paths.auditDir, paths.root);
  const next = await verifyAuditChain(projectRoot, { allowExtend: true });
  await atomicWriteFile(auditChainAbs(projectRoot), `${JSON.stringify(next)}\n`, {
    root: paths.auditDir,
    symlinkMessage: "audit chain path is a symlink",
  });
  return next;
}

export async function verifyAuditChain(
  projectRoot: string,
  opts?: { allowExtend?: boolean },
): Promise<AuditChainState> {
  const jsonl = toFsPath(projectRoot, ".legion-cli/audit/events.jsonl");
  let raw = "";
  try {
    raw = await readFile(jsonl, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    const stored = await readAuditChain(projectRoot);
    if (stored.length > 0) throw new AuditTamperError("audit chain rewind refused");
    return stored;
  }
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  let digest = GENESIS_DIGEST;
  for (const line of lines) digest = auditLineDigest(digest, line);
  const stored = await readAuditChain(projectRoot);
  if (stored.length > lines.length) {
    throw new AuditTamperError("audit chain rewind refused");
  }
  let replay = GENESIS_DIGEST;
  for (let i = 0; i < stored.length; i++) replay = auditLineDigest(replay, lines[i] ?? "");
  if (stored.length > 0 && replay !== stored.lastDigest) {
    throw new AuditTamperError("audit chain gap or rewrite");
  }
  if (lines.length > stored.length) {
    if (!opts?.allowExtend) {
      throw new AuditTamperError("audit chain gap or rewrite");
    }
    return { lastDigest: digest, length: lines.length };
  }
  return stored.length === 0 && lines.length === 0 ? stored : { lastDigest: digest, length: lines.length };
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
