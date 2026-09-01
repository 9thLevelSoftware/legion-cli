import { readdir } from "node:fs/promises";
import { basename } from "node:path";
import type { LegionStore } from "@9thlevelsoftware/legion-cli-persist";
import { loadWikiPages, type WikiPageRow } from "./graph.js";
import { ensureWikiIndex } from "./brief.js";

export type ShownPage = {
  kind: "wiki" | "spec" | "task" | "decision" | "assumption";
  path: string;
  title: string;
  trust?: "untrusted" | "reviewed";
  body: string;
};

function normalizeRef(page: string): string {
  return page.replaceAll("\\", "/").replace(/^\/+/, "").replace(/^\.\//, "");
}

async function listMarkdown(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((name) => name.toLowerCase().endsWith(".md"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

function matchWiki(pages: WikiPageRow[], ref: string): WikiPageRow | undefined {
  const needle = normalizeRef(ref);
  const withMd = needle.endsWith(".md") ? needle : `${needle}.md`;
  return pages.find((page) => {
    if (page.id === needle || page.id === needle.replace(/\.md$/i, "")) return true;
    if (page.path === needle || page.path === withMd) return true;
    if (page.path === `.legion-cli/wiki/${withMd}` || page.path === `.legion-cli/wiki/${needle}`) return true;
    if (page.path.endsWith(`/${withMd}`) || page.path.endsWith(`/${needle}`)) return true;
    if (page.title === ref) return true;
    return false;
  });
}

export async function showPage(store: LegionStore, pageRef: string): Promise<ShownPage> {
  const ref = normalizeRef(pageRef);
  await ensureWikiIndex(store);

  if (/^TSK-/i.test(ref) || ref.startsWith(".legion-cli/tasks/")) {
    const id = basename(ref).replace(/\.md$/i, "");
    const doc = await store.readTask(id);
    return { kind: "task", path: `.legion-cli/tasks/${id}.md`, title: doc.data.title, body: doc.body };
  }
  if (/^ASM-/i.test(ref) || ref.startsWith(".legion-cli/assumptions/")) {
    const id = basename(ref).replace(/\.md$/i, "");
    const doc = await store.readAssumption(id);
    return { kind: "assumption", path: `.legion-cli/assumptions/${id}.md`, title: doc.data.id, body: doc.body };
  }
  if (/^D-\d+/i.test(ref) || ref.startsWith(".legion-cli/decisions/")) {
    const files = await listMarkdown(store.paths.decisionsDir);
    const want = basename(ref).replace(/\.md$/i, "");
    for (const file of files) {
      const doc = await store.readDecision(file);
      if (doc.data.id === want || file.replace(/\.md$/i, "") === want || file === basename(ref)) {
        return {
          kind: "decision",
          path: `.legion-cli/decisions/${file}`,
          title: doc.data.summary || doc.data.id,
          body: doc.body,
        };
      }
    }
  }
  if (
    /^spec-/i.test(ref) ||
    ref.startsWith(".legion-cli/specs/") ||
    ref === "SPEC.md" ||
    ref.endsWith("/SPEC.md")
  ) {
    const specId = ref.includes("spec-")
      ? (ref.match(/spec-[^/]+/)?.[0] ?? ref)
      : (await store.readState()).data.activeSpecId;
    if (specId) {
      const doc = await store.readSpec(specId.replace(/\/SPEC\.md$/i, ""));
      return {
        kind: "spec",
        path: `.legion-cli/specs/${doc.data.id}/SPEC.md`,
        title: doc.data.title,
        body: doc.body,
      };
    }
  }

  const pages = loadWikiPages(store.projectRoot);
  const wiki = matchWiki(pages, ref);
  if (wiki) {
    const doc = await store.readWikiPage(wiki.path);
    return {
      kind: "wiki",
      path: wiki.path,
      title: doc.data.title,
      trust: doc.data.trust,
      body: doc.body,
    };
  }

  const prefixed = ref.startsWith(".legion-cli/wiki/") ? ref : `.legion-cli/wiki/${ref}`;
  const storePath = prefixed.endsWith(".md") ? prefixed : `${prefixed}.md`;
  if (await store.pathExists(storePath)) {
    const doc = await store.readWikiPage(storePath);
    return {
      kind: "wiki",
      path: storePath,
      title: doc.data.title,
      trust: doc.data.trust,
      body: doc.body,
    };
  }

  throw new Error(`unknown page ${pageRef}`);
}
