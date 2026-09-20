import { createLegionEngine } from "@9thlevelsoftware/legion-cli-core";
import { createLegionStore, fetchGithubZipball } from "@9thlevelsoftware/legion-cli-persist";

type ZipFetch = (source: string, opts?: Parameters<typeof fetchGithubZipball>[1]) => Promise<{ body: Buffer }>;

class Prefetched extends Error {
  constructor() {
    super("zipball prefetched");
    this.name = "Prefetched";
  }
}

/**
 * Run an installer that writes under `.legion-cli/` with engine.lock held only for the write.
 * For a `github:` source the installer runs once without the lock, up to its download: its own
 * validation happens in its normal order, the zipball is fetched, and it stops before writing
 * anything. It then runs again under the lock with the downloaded bytes, so signature checks and
 * the copy into `.legion-cli/` are locked but a slow network never holds engine.lock.
 */
export async function installWithLock<T>(
  projectRoot: string,
  remote: boolean,
  run: (fetchZip: ZipFetch | undefined) => Promise<T>,
  download: ZipFetch = fetchGithubZipball,
): Promise<T> {
  const store = createLegionStore(projectRoot);
  // Installs write under `.legion-cli/` (protected): refused while an agent run is live (KD-2).
  const engine = createLegionEngine(projectRoot, undefined);
  // Before the lock for a fast refusal, and again under it: a spawn starts with the lock free,
  // so only the inner check keeps an install out of the spawn window (R-22).
  await engine.assertNoLiveAgentRun();
  const locked = async <R>(fn: () => Promise<R>): Promise<R> =>
    store.withLock(async () => {
      await engine.assertNoLiveAgentRun();
      return fn();
    });
  if (!remote) return locked(() => run(undefined));
  let body: Buffer | undefined;
  try {
    await run(async (source, opts) => {
      body = (await download(source, opts)).body;
      throw new Prefetched();
    });
    throw new Error("github install finished without fetching (engine bug)");
  } catch (err) {
    if (!(err instanceof Prefetched)) throw err;
  }
  const downloaded = body as Buffer;
  return locked(() => run(async () => ({ body: downloaded })));
}
