import type { LegionStore } from "@9thlevelsoftware/legion-cli-persist";
import { loadWikiPages } from "./graph.js";
import { ensureWikiIndex } from "./brief.js";
import { showPage } from "./show.js";

export async function trustWikiPage(
  store: LegionStore,
  pageRef: string,
): Promise<{ path: string; title: string }> {
  await ensureWikiIndex(store);
  const shown = await showPage(store, pageRef);
  if (shown.kind !== "wiki") {
    throw new Error(`wiki trust requires a wiki page, got ${shown.kind}`);
  }
  const doc = await store.readWikiPage(shown.path);
  if (doc.data.trust !== "reviewed") {
    await store.writeWikiPage(
      shown.path,
      { ...doc.data, trust: "reviewed", updated: new Date().toISOString() },
      doc.body,
    );
    await store.rebuild();
  }
  const pages = loadWikiPages(store.projectRoot);
  const trusted = pages.find((page) => page.path === shown.path);
  return { path: shown.path, title: trusted?.title ?? doc.data.title };
}
