import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LegionStore } from "@9thlevelsoftware/legion-cli-persist";
import { createLegionMcpServer } from "../dist/index.js";

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
  const dir = await mkdtemp(join(tmpdir(), "legion-mcp-"));
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

export async function withClient(dir, fn) {
  const server = createLegionMcpServer({ projectRoot: dir });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "legion-cli-mcp-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

export function parseTool(result) {
  const text = result.content?.map((item) => item.text).join("\n") ?? "";
  return { isError: Boolean(result.isError), text, json: tryJson(text) };
}

function tryJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
