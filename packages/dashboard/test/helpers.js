import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LegionStore } from "@9thlevelsoftware/legion-cli-persist";

const persistFixtures = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "persist",
  "test",
  "fixtures",
  "project",
);

export async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "legion-dashboard-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function copyFixtureProject(dir) {
  await cp(join(persistFixtures, "legion-cli"), join(dir, ".legion-cli"), { recursive: true });
}

export async function withStore(fn) {
  await withTempDir(async (dir) => {
    await copyFixtureProject(dir);
    const store = new LegionStore(dir);
    await store.rebuild();
    await fn({ dir, store });
  });
}

export function todoTask(overrides = {}) {
  const { contract, ...rest } = overrides;
  return {
    schemaVersion: "legion-cli-task/v1",
    id: "TSK-0003",
    title: "board column",
    status: "todo",
    type: "feature",
    priority: "P1",
    specId: "spec-checkin",
    blockedBy: ["TSK-0002"],
    blocks: [],
    assignee: "agent",
    notes: "",
    ...rest,
    contract: {
      filesAllowed: ["src/board.ts"],
      filesForbidden: [".git/**"],
      expectedArtifacts: ["src/board.ts"],
      verificationCommands: ["pnpm test"],
      maxFilesTouched: 20,
      ...contract,
    },
  };
}
