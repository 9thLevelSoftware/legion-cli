import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
export const mockLspPath = join(pkgRoot, "test", "fixtures", "mock-lsp.js");

export const THREE_TS = {
  "src/auth.ts": `import { connect } from "./db.js";\nexport function login() {}\nexport function logout() {}\n`,
  "src/db.ts": `export function connect() {}\nexport const url = "sqlite";\n`,
  "src/index.ts": `import { login } from "./auth.js";\nexport function main() { login(); }\n`,
  "tsconfig.json": `{"compilerOptions":{"strict":true}}\n`,
};

export async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "legion-map-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function writeTree(root, files) {
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, ...rel.split("/"));
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, body, "utf8");
  }
}

function spawnMock(cwd, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  delete env.NODE_TEST_CONTEXT;
  return spawn(process.execPath, [mockLspPath], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
  });
}

export function spawnMockLsp(_command, _args, cwd) {
  return spawnMock(cwd);
}

export function spawnMockLspHangAfter(n) {
  return (_command, _args, cwd) => spawnMock(cwd, { LEGION_MOCK_LSP_HANG_AFTER: String(n) });
}

export async function writeManyTs(dir, count) {
  const src = join(dir, "src");
  await mkdir(src, { recursive: true });
  const body = "export function f() {}\n";
  const batch = 256;
  for (let i = 0; i < count; i += batch) {
    const jobs = [];
    const end = Math.min(count, i + batch);
    for (let j = i; j < end; j += 1) {
      jobs.push(writeFile(join(src, `f${j}.ts`), body));
    }
    await Promise.all(jobs);
  }
}
