import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rm, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  gitDiscoverChanges,
  gitPathExistsAtRef,
  gitRestoreWorktree,
  gitRmWorktree,
  isGitRepo,
  isRestoreManifestPath,
  journaledRemove,
  openEngineCommand,
  restoreEngineState,
  RestoreRefusedError,
  toFsPath,
  toPosixPath,
  tryGitHead,
  writeTextFile,
} from "@9thlevelsoftware/legion-cli-persist";
import { atomicWriteFile } from "./atomic-write.js";
import { isAllowedPath, isEngineOwned, matchesGlob } from "./contracts.js";

export const HEAD_MOVED_WARNING =
  "agent committed; Legion CLI did not `reset`. `legion-cli ship` is the human commit gate.";

export type GitPolicySnapshot = {
  config: string | null;
  hooks: Record<string, string>;
};

export type RevertResult = {
  extrasReverted: string[];
  incident: boolean;
  headMoved: boolean;
  preSpawnRef: string | null;
  sandboxCopied?: string[];
  sandboxDropped?: string[];
  engineRestored?: string[];
  tamperIncident?: boolean;
  repoHalfRefused?: string;
  filesHashed?: number;
};

/** Pre-spawn bytes of `.legion-cli/tasks/*.md`, keyed by filename. */
export type TaskFileSnapshot = Map<string, { hash: string; bytes: Buffer }>;

function sha256Bytes(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

async function listTaskMarkdown(tasksDir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(tasksDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return names.filter((name) => name.toLowerCase().endsWith(".md"));
}

export async function snapshotTaskFiles(tasksDir: string): Promise<TaskFileSnapshot> {
  const out: TaskFileSnapshot = new Map();
  for (const fileName of await listTaskMarkdown(tasksDir)) {
    try {
      const bytes = await readFile(join(tasksDir, fileName));
      out.set(fileName, { hash: sha256Bytes(bytes), bytes });
    } catch {
      // missing between list and read
    }
  }
  return out;
}

/** Restore pre-spawn bytes for any existing task file that changed. Returns rewritten ids. */
export async function restoreChangedTaskFiles(
  tasksDir: string,
  before: ReadonlyMap<string, { hash: string; bytes: Buffer }>,
): Promise<string[]> {
  const rewritten: string[] = [];
  await mkdir(tasksDir, { recursive: true });
  for (const [fileName, snap] of before) {
    const abs = join(tasksDir, fileName);
    let currentHash: string | undefined;
    try {
      currentHash = sha256Bytes(await readFile(abs));
    } catch {
      currentHash = undefined;
    }
    if (currentHash === snap.hash) continue;
    rewritten.push(fileName.replace(/\.md$/i, ""));
    try {
      const st = await lstat(abs);
      if (st.isSymbolicLink() || st.isFile()) await unlink(abs);
      else await rm(abs, { recursive: true, force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    await writeTextFile(abs, snap.bytes, { root: resolve(tasksDir, "..", ".."), skipJournal: true });
  }
  rewritten.sort((a, b) => a.localeCompare(b));
  return rewritten;
}

export function recordPreSpawnRef(projectRoot: string): string | null {
  return tryGitHead(projectRoot);
}

export { openEngineCommand, restoreEngineState, RestoreRefusedError };

/** Worktree dirt at spawn start so engine writes (STATE, new tasks) are not extras. */
export function snapshotDirtyPaths(projectRoot: string, preSpawnRef: string | null): Set<string> {
  return new Set(gitDiscoverChanges(projectRoot, preSpawnRef));
}

export async function snapshotPaths(projectRoot: string): Promise<Set<string>> {
  const out = new Set<string>();
  await walk(projectRoot, "", out);
  return out;
}

export async function snapshotChatSessions(projectRoot: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const dir = join(projectRoot, ".legion-cli", "chat");
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const posix = `.legion-cli/chat/${entry.name}`;
    try {
      const st = await lstat(join(dir, entry.name));
      if (st.isSymbolicLink()) continue;
      out.set(posix, await readFile(join(dir, entry.name), "utf8"));
    } catch {
      // skip unreadable session files
    }
  }
  return out;
}

async function walk(root: string, rel: string, out: Set<string>): Promise<void> {
  const abs = rel ? join(root, rel) : root;
  let entries;
  try {
    entries = await readdir(abs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const posix = toPosixPath(rel ? `${rel}/${entry.name}` : entry.name);
    if (posix === ".git" || posix.startsWith(".git/")) continue;
    // Walk dist/node_modules too: gitignored extras there must still revert.
    if (isEngineOwned(posix)) continue;
    if (entry.isDirectory()) {
      await walk(root, posix, out);
    } else if (entry.isFile()) {
      out.add(posix);
    }
  }
}

export async function snapshotGitPolicy(projectRoot: string): Promise<GitPolicySnapshot> {
  const hooks: Record<string, string> = {};
  const hooksDir = join(projectRoot, ".git", "hooks");
  try {
    const entries = await readdir(hooksDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const posix = `.git/hooks/${entry.name}`;
      try {
        hooks[posix] = await readFile(join(hooksDir, entry.name), "utf8");
      } catch {
        hooks[posix] = "";
      }
    }
  } catch {
    // no .git/hooks
  }
  let config: string | null = null;
  try {
    config = await readFile(join(projectRoot, ".git", "config"), "utf8");
  } catch {
    config = null;
  }
  return { config, hooks };
}

async function gitPolicyIncidents(
  projectRoot: string,
  snapshot: GitPolicySnapshot | undefined,
): Promise<string[]> {
  if (!snapshot) return [];
  const now = await snapshotGitPolicy(projectRoot);
  const incidents: string[] = [];
  if (now.config !== snapshot.config) incidents.push(".git/config");
  const names = new Set([...Object.keys(now.hooks), ...Object.keys(snapshot.hooks)]);
  for (const name of names) {
    if (now.hooks[name] !== snapshot.hooks[name]) incidents.push(name);
  }
  return incidents;
}

function forbiddenByContract(posixPath: string, filesForbidden: readonly string[] | undefined): boolean {
  if (!filesForbidden || filesForbidden.length === 0) return false;
  return filesForbidden.some((pattern) => pattern === posixPath || matchesGlob(pattern, posixPath));
}

export async function revertExtras(opts: {
  projectRoot: string;
  preSpawnRef: string | null;
  allowedRoots: readonly string[];
  filesForbidden?: readonly string[];
  snapshot?: Set<string>;
  gitPolicy?: GitPolicySnapshot;
  dirtyAtStart?: ReadonlySet<string>;
  chatSessions?: ReadonlyMap<string, string>;
  commandId?: string;
  extraRoots?: readonly string[];
  agentAlive?: boolean;
  jailWritable?: boolean;
}): Promise<RevertResult> {
  const extrasReverted: string[] = [];
  const headNow = tryGitHead(opts.projectRoot);
  const headMoved = Boolean(opts.preSpawnRef && headNow && headNow !== opts.preSpawnRef);

  let engineRestored: string[] = [];
  let tamperIncident = false;
  let filesHashed = 0;
  if (opts.commandId) {
    const engine = await restoreEngineState(opts.projectRoot, opts.commandId, {
      agentAlive: opts.agentAlive,
      jailWritable: opts.jailWritable,
      allowedRoots: opts.allowedRoots,
    });
    engineRestored = [...engine.restored, ...engine.tampered, ...engine.reconciled];
    tamperIncident = engine.tampered.length > 0;
    filesHashed = engine.filesHashed;
  }

  let repoHalfRefused: string | undefined;
  let gitChanges: string[] = [];
  const git = isGitRepo(opts.projectRoot);
  if (opts.preSpawnRef && !git) {
    throw new RestoreRefusedError("git restore refused: not a git repository");
  }
  if (git) {
    try {
      gitChanges = gitDiscoverChanges(opts.projectRoot, opts.preSpawnRef);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new RestoreRefusedError(`git restore refused: ${message}`);
    }
  } else {
    repoHalfRefused = "git restore refused: not a git repository";
  }

  const candidates = new Set(gitChanges);
  if (opts.snapshot) {
    const after = await snapshotPaths(opts.projectRoot);
    for (const posix of after) {
      // New paths vs the pre-spawn filesystem snapshot (gitignored extras).
      // Pre-existing ignored files stay in `opts.snapshot` so they are not extras.
      if (!opts.snapshot.has(posix)) candidates.add(posix);
    }
  }
  if (opts.chatSessions) {
    const afterChat = await snapshotChatSessions(opts.projectRoot);
    for (const [posix, body] of afterChat) {
      const before = opts.chatSessions.get(posix);
      if (before !== undefined && before !== body) candidates.add(posix);
    }
  }

  const incidents = await gitPolicyIncidents(opts.projectRoot, opts.gitPolicy);
  for (const posix of incidents) candidates.add(posix);
  let incident = incidents.length > 0 || tamperIncident;

  const extraRoots = opts.extraRoots ?? opts.allowedRoots.filter((root) => root.startsWith(".legion-cli/"));

  for (const posix of candidates) {
    if (posix.startsWith(".git/") || posix === ".git") {
      incident = true;
      continue;
    }
    if (isRestoreManifestPath(posix, extraRoots)) {
      continue;
    }
    if (opts.dirtyAtStart?.has(posix)) {
      continue;
    }
    if (isAllowedPath(posix, opts.allowedRoots) && !forbiddenByContract(posix, opts.filesForbidden)) {
      continue;
    }
    extrasReverted.push(posix);
    await restoreOne(opts.projectRoot, opts.preSpawnRef, posix, opts.chatSessions?.get(posix));
  }

  return {
    extrasReverted,
    incident,
    headMoved,
    preSpawnRef: opts.preSpawnRef,
    engineRestored,
    tamperIncident,
    repoHalfRefused,
    filesHashed,
  };
}

async function restoreOne(
  projectRoot: string,
  preSpawnRef: string | null,
  posix: string,
  chatBody?: string,
): Promise<void> {
  const abs = toFsPath(projectRoot, posix);
  if (chatBody !== undefined) {
    await atomicWriteFile(abs, chatBody, { symlinkMessage: "chat session path is a symlink", root: projectRoot });
    return;
  }
  if (preSpawnRef && gitPathExistsAtRef(projectRoot, preSpawnRef, posix)) {
    try {
      gitRestoreWorktree(projectRoot, preSpawnRef, posix);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new RestoreRefusedError(`git restore refused: ${message}`);
    }
    return;
  }
  if (preSpawnRef) {
    try {
      gitRmWorktree(projectRoot, posix);
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/did not match|pathspec/i.test(message)) {
        throw new RestoreRefusedError(`git restore refused: ${message}`);
      }
    }
  }
  await journaledRemove(projectRoot, abs);
}
