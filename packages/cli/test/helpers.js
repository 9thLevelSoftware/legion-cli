import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
export const bin = join(pkgRoot, "dist", "bin.js");
export const transcriptsDir = join(pkgRoot, "test", "transcripts");

export function runCli(args, opts = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    encoding: "utf8",
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
    windowsHide: true,
    input: opts.input,
  });
}

export function normalize(text) {
  return (text ?? "").replaceAll("\r\n", "\n");
}

export function readGolden(name) {
  return readFile(join(transcriptsDir, name), "utf8").then((text) => normalize(text));
}

export function sanitizeDoctor(text) {
  return normalize(text)
    .replace(/^(ok  |FAIL)  Node >= 22 \(.+\)$/m, "$1  Node >= 22 (<version>)")
    .replace(/^(ok  |FAIL)  pnpm \(.+\)$/m, "$1  pnpm (<version>)")
    .replace(/^(ok  |FAIL)  git \(.+\)$/m, "$1  git (<version>)")
    .replace(/^  legion-cli\n(?:    .+\n)+/m, "  legion-cli\n    <paths>\n")
    .replace(/^  legion\n(?:    .+\n)+/m, "  legion\n    <paths>\n")
    .replace(/^Playwright  .+$/m, "Playwright  <playwright>")
    .replace(/^  claude       .+$/m, "  claude       <detect>")
    .replace(/^  grok         .+$/m, "  grok         <detect>")
    .replace(/^  openai       .+$/m, "  openai       <detect>")
    .replace(/^  codex        .+$/m, "  codex        <detect>")
    .replace(/^  mimo         .+$/m, "  mimo         <detect>")
    .replace(/^  minimax      .+$/m, "  minimax      <detect>")
    .replace(/\nWarnings\n(?:  .+\n?)*(?:\n)?/g, "\n");
}

export async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "legion-cli-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Omit {{pointer}} so PATH cannot green-light grok in CLI-override tests. */
export function withUnspawnableGrok(config) {
  return {
    ...config,
    adapter: {
      ...config.adapter,
      grok: { args: ["--model", "grok-4"] },
    },
  };
}

export function withNamedAdapter(config, name, id) {
  return {
    ...config,
    adapter: {
      ...config.adapter,
      named: { ...(config.adapter.named ?? {}), [name]: id },
    },
  };
}
