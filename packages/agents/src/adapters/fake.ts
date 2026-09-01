import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AgentError } from "../errors.js";
import { assertRepoRelative, runCachePaths } from "../paths.js";
import {
  FAKE_ADAPTER_ENV,
  type AgentAdapter,
  type AgentHandle,
  type AgentJob,
  type AgentResult,
  type DetectResult,
  type FakeArtifact,
} from "../types.js";

function normalizeArtifact(entry: string | FakeArtifact): FakeArtifact {
  if (typeof entry === "string") return { path: entry, content: "\n" };
  return { path: entry.path, content: entry.content ?? "\n" };
}

class FakeHandle implements AgentHandle {
  readonly pid = process.pid;
  readonly #run: () => Promise<AgentResult>;
  #result: Promise<AgentResult> | undefined;

  constructor(run: () => Promise<AgentResult>) {
    this.#run = run;
  }

  wait(): Promise<AgentResult> {
    this.#result ??= this.#run();
    return this.#result;
  }

  async abort(): Promise<void> {
    // in-process; abort is n/a
  }
}

export class FakeAdapter implements AgentAdapter {
  readonly id = "fake" as const;
  readonly binary = "(in-process)";
  readonly #artifacts: FakeArtifact[];
  readonly #throwAfterWrite: boolean;

  constructor(artifacts: FakeArtifact[] = [], throwAfterWrite = false) {
    this.#artifacts = artifacts;
    this.#throwAfterWrite = throwAfterWrite;
  }

  async detect(): Promise<DetectResult> {
    if (process.env[FAKE_ADAPTER_ENV] === "fake") {
      return { ok: true, version: "fake" };
    }
    return { ok: false, reason: `set ${FAKE_ADAPTER_ENV}=fake` };
  }

  async spawn(job: AgentJob): Promise<AgentHandle> {
    return new FakeHandle(() => this.#run(job));
  }

  async #run(job: AgentJob): Promise<AgentResult> {
    const paths = runCachePaths(job.cwd, job.runId);
    await mkdir(paths.runDir, { recursive: true });
    try {
      await access(paths.skillMd);
      await readFile(paths.skillMd, "utf8");
    } catch (err) {
      throw new AgentError(`SKILL.md missing at ${paths.posix.skill}; stage the skill before spawn`, {
        cause: err,
      });
    }

    const artifacts = [...this.#artifacts, ...(job.expectedArtifacts ?? [])].map(normalizeArtifact);
    for (const artifact of artifacts) {
      const rel = assertRepoRelative(artifact.path.replaceAll("<id>", job.runId));
      const abs = join(job.cwd, ...rel.split("/"));
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, artifact.content ?? "\n", "utf8");
    }

    if (this.#throwAfterWrite) {
      throw new AgentError("fake adapter throwAfterWrite");
    }

    await writeFile(
      paths.summaryPath,
      `Fake adapter completed skill=${job.skillId} runId=${job.runId}\n`,
      "utf8",
    );
    await writeFile(paths.stdoutPath, "", "utf8");
    await writeFile(paths.stderrPath, "", "utf8");

    return {
      exitCode: 0,
      timedOut: false,
      aborted: false,
      stdoutPath: paths.stdoutPath,
      stderrPath: paths.stderrPath,
      summaryPath: paths.summaryPath,
    };
  }
}
