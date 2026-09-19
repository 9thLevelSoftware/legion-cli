import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import { copyFile, link, lstat, mkdir, readdir, readFile, readlink, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ensureQuarantineRoot,
  PersistError,
  quarantineRootPath,
  retryFsOp,
} from "@9thlevelsoftware/legion-cli-persist";

export type QuarantineReason = "new" | "changed" | "replaced" | "link" | "invalid-task" | "unrestorable";

export type QuarantineManifestEntry = {
  /** Where the entry was (project-relative, or absolute for a git dir outside the project). */
  path: string;
  reason: QuarantineReason;
  /** What was put back: "snapshot" (pre-spawn bytes), "directory", "link", or null (nothing). */
  restoredFrom: "snapshot" | "directory" | "link" | null;
  kind: "file" | "directory" | "link";
  /** sha256 of the quarantined bytes (files), or of the link target text (links). */
  sha256: string | null;
  /** Link target, for a quarantined link (the link itself is only unlinked, never followed). */
  linkTarget?: string;
  /** Location inside the quarantine folder, relative to it. */
  stored: string | null;
  at: string;
};

export const QUARANTINE_MANIFEST = "MANIFEST.json";

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function sha256File(abs: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((done, fail) => {
    const stream = createReadStream(abs);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", fail);
    stream.on("end", () => done());
  });
  return hash.digest("hex");
}

function storedRel(display: string): string {
  // Keep the original layout, but never let a name climb out of the folder.
  const parts = display
    .replaceAll("\\", "/")
    .replace(/^[A-Za-z]:/, (drive) => drive[0] ?? "")
    .split("/")
    .filter((part) => part && part !== "." && part !== "..");
  return join("files", ...parts);
}

/**
 * A per-run quarantine folder outside the project: `<userStateDir>/quarantine/<projectHash>/
 * <runId>-<random>/` (KD-1, R-17, R-40). Created lazily with an exclusive mkdir (a pre-planted
 * path is never reused), never through a link, never deleted by the engine. Moves never
 * overwrite: hard link + unlink, or (cross-volume) exclusive copy, verify sha, then delete.
 */
export class Quarantine {
  readonly projectRoot: string;
  readonly runId: string;
  #dir: string | null = null;
  readonly entries: QuarantineManifestEntry[] = [];

  constructor(projectRoot: string, runId: string) {
    this.projectRoot = projectRoot;
    this.runId = runId;
  }

  get dir(): string | null {
    return this.#dir;
  }

  async #ensureDir(): Promise<string> {
    if (this.#dir) return this.#dir;
    const root = await ensureQuarantineRoot(this.projectRoot);
    const dir = join(root, `${this.runId}-${randomBytes(6).toString("hex")}`);
    // Exclusive: fails when anything (a planted junction included) already sits at the name.
    await mkdir(dir, { mode: 0o700 });
    const st = await lstat(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new PersistError(`refusing quarantine folder ${dir}: not a real directory`);
    }
    this.#dir = dir;
    return dir;
  }

  async #dest(display: string): Promise<{ abs: string; rel: string }> {
    const dir = await this.#ensureDir();
    let rel = storedRel(display);
    let abs = join(dir, rel);
    // A later entry for the same path (e.g. a link, then a file) gets its own slot.
    for (let n = 1; ; n += 1) {
      try {
        await lstat(abs);
        rel = `${storedRel(display)}.${n}`;
        abs = join(dir, rel);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") break;
        throw err;
      }
    }
    await mkdir(dirname(abs), { recursive: true });
    return { abs, rel };
  }

  #record(entry: Omit<QuarantineManifestEntry, "at">): void {
    this.entries.push({ ...entry, at: new Date().toISOString() });
  }

  /** Record a link (symlink or junction) and remove the link itself; its target is never touched. */
  async quarantineLink(abs: string, display: string, restoredFrom: QuarantineManifestEntry["restoredFrom"]): Promise<void> {
    const target = await readlink(abs).catch(() => "");
    const { abs: dest, rel } = await this.#dest(`${display}.link`);
    await writeFile(dest, `${target}\n`, { encoding: "utf8", flag: "wx" });
    await retryFsOp(() => unlink(abs)).catch(async (err) => {
      // A Windows directory junction is removed with rmdir, which never recurses into the target.
      if (process.platform === "win32") return retryFsOp(() => rmdir(abs));
      throw err;
    });
    this.#record({ path: display, reason: "link", restoredFrom, kind: "link", sha256: sha256(target), linkTarget: target, stored: rel });
  }

  /** Move a file or directory tree into quarantine (links inside are recorded, never followed). */
  async move(abs: string, display: string, reason: QuarantineReason, restoredFrom: QuarantineManifestEntry["restoredFrom"]): Promise<void> {
    const st = await lstat(abs);
    if (st.isSymbolicLink()) return this.quarantineLink(abs, display, restoredFrom);
    if (st.isDirectory()) {
      const { rel } = await this.#dest(display);
      await this.#moveTree(abs, display);
      this.#record({ path: display, reason, restoredFrom, kind: "directory", sha256: null, stored: rel });
      return;
    }
    const { abs: dest, rel } = await this.#dest(display);
    const digest = await moveFileNoOverwrite(abs, dest);
    this.#record({ path: display, reason, restoredFrom, kind: "file", sha256: digest, stored: rel });
  }

  async #moveTree(abs: string, display: string): Promise<void> {
    const entries = await readdir(abs, { withFileTypes: true });
    for (const entry of entries) {
      const child = join(abs, entry.name);
      const childDisplay = `${display}/${entry.name}`;
      const st = await lstat(child);
      if (st.isSymbolicLink()) {
        await this.quarantineLink(child, childDisplay, null);
      } else if (st.isDirectory()) {
        await this.#moveTree(child, childDisplay);
      } else {
        const { abs: dest } = await this.#dest(childDisplay);
        await moveFileNoOverwrite(child, dest);
      }
    }
    await retryFsOp(() => rmdir(abs));
  }

  /** Copy a file's current bytes into quarantine (the caller then restores it in place). */
  async copy(abs: string, display: string, reason: QuarantineReason, restoredFrom: QuarantineManifestEntry["restoredFrom"]): Promise<void> {
    const { abs: dest, rel } = await this.#dest(display);
    const before = await sha256File(abs);
    await retryFsOp(() => copyFile(abs, dest, fsConstants.COPYFILE_EXCL));
    const after = await sha256File(dest);
    if (after !== before) throw new PersistError(`quarantine copy of ${display} did not verify`);
    this.#record({ path: display, reason, restoredFrom, kind: "file", sha256: before, stored: rel });
  }

  /** Write MANIFEST.json (exclusive) and return its path and sha256, or null when nothing was quarantined. */
  async finalize(): Promise<{ dir: string; manifestSha256: string } | null> {
    if (!this.#dir) return null;
    const body = `${JSON.stringify({ runId: this.runId, projectRoot: this.projectRoot, entries: this.entries }, null, 2)}\n`;
    await writeFile(join(this.#dir, QUARANTINE_MANIFEST), body, { encoding: "utf8", flag: "wx" });
    return { dir: this.#dir, manifestSha256: sha256(body) };
  }
}

/**
 * Move without ever overwriting: hard link + unlink (same volume), else exclusive copy, verify
 * the sha, then delete the source. A failed verify keeps the source and throws.
 */
export async function moveFileNoOverwrite(src: string, dest: string): Promise<string> {
  const digest = await sha256File(src);
  try {
    await retryFsOp(() => link(src, dest));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw err;
    await retryFsOp(() => copyFile(src, dest, fsConstants.COPYFILE_EXCL));
    if ((await sha256File(dest)) !== digest) {
      throw new PersistError(`quarantine copy of ${src} did not verify; the original was kept`);
    }
  }
  await retryFsOp(() => unlink(src));
  return digest;
}

export type RetainedQuarantine = {
  dir: string;
  runId: string;
  bytes: number;
  files: number;
  manifestSha256: string | null;
};

async function treeSize(abs: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;
  let entries;
  try {
    entries = await readdir(abs, { withFileTypes: true });
  } catch {
    return { bytes, files };
  }
  for (const entry of entries) {
    const child = join(abs, entry.name);
    if (entry.isDirectory()) {
      const sub = await treeSize(child);
      bytes += sub.bytes;
      files += sub.files;
    } else {
      try {
        bytes += (await lstat(child)).size;
        files += 1;
      } catch {
        // gone
      }
    }
  }
  return { bytes, files };
}

/** Retained quarantine folders for a project (doctor). The engine never deletes them. */
export async function listRetainedQuarantines(projectRoot: string): Promise<RetainedQuarantine[]> {
  const root = quarantineRootPath(projectRoot);
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const out: RetainedQuarantine[] = [];
  for (const name of names.sort()) {
    const dir = join(root, name);
    try {
      const st = await lstat(dir);
      if (!st.isDirectory() || st.isSymbolicLink()) continue;
    } catch {
      continue;
    }
    let manifestSha256: string | null = null;
    try {
      manifestSha256 = sha256(await readFile(join(dir, QUARANTINE_MANIFEST)));
    } catch {
      manifestSha256 = null;
    }
    const size = await treeSize(dir);
    out.push({ dir, runId: name.replace(/-[0-9a-f]{12}$/, ""), manifestSha256, ...size });
  }
  return out;
}
