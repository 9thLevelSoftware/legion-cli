import type { FakeArtifact } from "@9thlevelsoftware/legion-cli-agents";

/** Test seam: fake adapter artifacts from LEGION_CLI_FAKE_ARTIFACTS, honored only when LEGION_CLI_ADAPTER=fake. */
export function fakeArtifactsFromEnv(): FakeArtifact[] | undefined {
  if (process.env.LEGION_CLI_ADAPTER !== "fake") return undefined;
  const raw = process.env.LEGION_CLI_FAKE_ARTIFACTS?.trim();
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as FakeArtifact[]) : undefined;
  } catch {
    return undefined;
  }
}
