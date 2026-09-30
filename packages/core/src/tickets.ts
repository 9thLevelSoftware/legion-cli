import { normalizePathKey } from "@9thlevelsoftware/legion-cli-schema";
import { mergeFilesForbidden } from "@9thlevelsoftware/legion-cli-graph";
import {
  AdapterIdSchema,
  SCHEMA_VERSION,
  type AdapterId,
  type FileContract,
  type Task,
} from "@9thlevelsoftware/legion-cli-schema";
import type { NewTicket } from "./types.js";

export function defaultTicketContract(id: string, partial?: Partial<FileContract>): FileContract {
  const filesAllowed =
    partial?.filesAllowed && partial.filesAllowed.length > 0 ? [...partial.filesAllowed] : [`notes/${id}.md`];
  const expectedArtifacts =
    partial?.expectedArtifacts && partial.expectedArtifacts.length > 0
      ? [...partial.expectedArtifacts]
      : [...filesAllowed];
  const verificationCommands =
    partial?.verificationCommands && partial.verificationCommands.length > 0
      ? [...partial.verificationCommands]
      : ["pnpm test"];
  return {
    filesAllowed,
    filesForbidden: mergeFilesForbidden(partial?.filesForbidden ?? []),
    expectedArtifacts,
    verificationCommands,
    maxFilesTouched: partial?.maxFilesTouched ?? 20,
  };
}

export function ticketFromInput(id: string, specId: string, input: NewTicket): Task {
  return {
    schemaVersion: SCHEMA_VERSION.task,
    id,
    title: input.title.trim(),
    status: "todo",
    type: input.type ?? "feature",
    priority: input.priority ?? "P2",
    specId,
    adapter: input.adapter,
    parentId: input.parentId,
    blockedBy: input.parentId ? [input.parentId] : [],
    blocks: [],
    contract: defaultTicketContract(id, input.contract),
    assignee: input.fromAgent ? "agent" : "human",
    notes: input.notes ?? (input.fromAgent ? "Filed from agent extra work." : ""),
  };
}

export function parseExtraJson(raw: unknown): NewTicket[] {
  const items = Array.isArray(raw) ? raw : [raw];
  const tickets: NewTicket[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.title !== "string" || rec.title.trim().length === 0) continue;
    tickets.push({
      title: rec.title,
      parentId: typeof rec.parentId === "string" ? rec.parentId : undefined,
      fromAgent: true,
      type: rec.type === "fix" || rec.type === "bug" || rec.type === "feature" ? rec.type : undefined,
      priority: rec.priority === "P0" || rec.priority === "P1" || rec.priority === "P2" ? rec.priority : undefined,
      notes: typeof rec.notes === "string" ? rec.notes : undefined,
      adapter:
        typeof rec.adapter === "string" && AdapterIdSchema.safeParse(rec.adapter).success
          ? (rec.adapter as AdapterId)
          : undefined,
      contract: {
        filesAllowed: Array.isArray(rec.filesAllowed)
          ? rec.filesAllowed.filter((path): path is string => typeof path === "string")
          : undefined,
        expectedArtifacts: Array.isArray(rec.expectedArtifacts)
          ? rec.expectedArtifacts.filter((path): path is string => typeof path === "string")
          : undefined,
        // verificationCommands are never taken from agent output: an agent-filed ticket runs with
        // its parent's commands (engine.ts #fileTicketLocked), so the agent cannot certify itself.
      },
    });
  }
  return tickets;
}

const ENTRY_BASENAMES = new Set([
  "package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "pnpm-workspace.yaml",
  "yarn.lock", "bun.lock", "bun.lockb", ".npmrc", ".yarnrc", ".yarnrc.yml", "makefile", "gnumakefile",
  "justfile", "taskfile.yml", "taskfile.yaml", "pyproject.toml", "tox.ini", "pytest.ini", "setup.cfg",
  "setup.py", "conftest.py", "noxfile.py", "cargo.toml", "cargo.lock", "build.rs", "go.mod", "go.sum",
  "gemfile", "gemfile.lock", "rakefile", "build.gradle", "build.gradle.kts", "pom.xml", ".gitlab-ci.yml",
  "jenkinsfile", "dockerfile", "bunfig.toml", ".swcrc", "cmakelists.txt", "deno.json", "deno.jsonc",
  "deno.lock", "composer.json", "composer.lock", "requirements.txt", "constraints.txt", "pipfile", "pipfile.lock",
  "poetry.lock", "uv.lock", "directory.build.props", "directory.build.targets", "global.json",
  "nuget.config", "settings.gradle", "settings.gradle.kts", "gradlew", "mvnw", "flake.nix", "shell.nix", ".babelrc", ".mocharc.json", ".mocharc.js", ".mocharc.yml",
]);
const ENTRY_BASENAME_PATTERNS = [
  /^next\.config\..+$/,
  /^requirements[^/]*\.txt$/,
  /\.(csproj|vbproj|fsproj|sln|slnx|gemspec)$/,
  /^tsconfig(\..+)?\.json$/,
  /^(vitest|vite|jest|playwright|karma|babel|rollup|webpack|eslint|prettier|cypress|tsup|turbo)\.config\..+$/,
  /^\.eslintrc(\..+)?$/,
  /^\.prettierrc(\..+)?$/,
  /\.(test|spec)\.[^.]+$/,
];
const ENTRY_DIRS = new Set([
  "scripts", ".github", ".husky", ".githooks", ".circleci", ".gitlab", "test", "tests", "__tests__", "spec", "specs", "e2e",
]);

/**
 * True when a path is something a verification command runs or is configured by (F-039): package
 * manifests and lockfiles, build/test/lint config, scripts, CI and hook dirs, test files. An agent
 * ticket that may edit these could rewrite what its inherited command executes. Also true for any
 * path named by a token of the inherited commands.
 */
export function touchesVerificationEntryPoint(paths: readonly string[], commands: readonly string[] = []): boolean {
  const referenced = new Set(
    commands.flatMap((cmd) => cmd.split(/\s+/)).map((tok) => normalizeEntryPath(tok.replace(/^["']|["']$/g, ""))).filter(Boolean),
  );
  return paths.some((raw) => {
    const path = normalizeEntryPath(raw);
    if (!path) return false;
    const segments = path.split("/");
    const base = segments.at(-1) ?? "";
    return (
      ENTRY_BASENAMES.has(base) ||
      ENTRY_BASENAME_PATTERNS.some((pattern) => pattern.test(base)) ||
      segments.slice(0, -1).some((seg) => ENTRY_DIRS.has(seg)) ||
      referenced.has(path)
    );
  });
}

/** Backslashes to "/", then the shared segment-wise key (case, trailing dots/spaces, :streams). */
function normalizeEntryPath(raw: string): string {
  return normalizePathKey(raw.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, ""));
}

export function taskMarkdownBody(task: Task): string {
  const parent = task.parentId ? `Parent: ${task.parentId}.\n` : "";
  return `${parent}${task.title}\n`;
}
