import { readFile, realpath, stat } from "node:fs/promises";
import { basename } from "node:path";
import {
  assertInsideProject,
  gitDiffRevision,
  MAX_INGEST_FILE_BYTES,
  resolveProjectPath,
  toStorePath,
  type IngestDocument,
} from "@9thlevelsoftware/legion-cli-persist";
import { excerptHtml, looksLikeHtml, titleFromHtml } from "./parser.js";
import { fetchPublicHttps, fileUrlToPath, isUrlSource } from "./ssrf.js";

export type MaterializedIngest = {
  files: string[];
  documents: IngestDocument[];
};

function titleFromPath(source: string): string {
  const base = basename(source.replace(/\/+$/, "") || source);
  return base.replace(/\.[^.]+$/, "") || source;
}

export async function materializeIngestSources(opts: {
  projectRoot: string;
  sources: string[];
  transcript?: string;
  diff?: string;
}): Promise<MaterializedIngest> {
  const files: string[] = [];
  const documents: IngestDocument[] = [];

  for (const source of opts.sources) {
    if (/^file:/i.test(source)) {
      files.push(fileUrlToPath(source));
      continue;
    }
    if (isUrlSource(source)) {
      const fetched = await fetchPublicHttps(source);
      let body = fetched.body;
      let title = titleFromPath(fetched.finalUrl);
      if (looksLikeHtml(body, fetched.contentType)) {
        title = titleFromHtml(body) ?? title;
        body = excerptHtml(body);
      }
      documents.push({ source, title, body });
      continue;
    }
    files.push(source);
  }

  if (opts.transcript) {
    const resolved = resolveProjectPath(opts.projectRoot, opts.transcript);
    const real = await realpath(resolved);
    const posix = assertInsideProject(opts.projectRoot, real);
    const info = await stat(real);
    if (info.size > MAX_INGEST_FILE_BYTES) {
      documents.push({ source: `transcript:${posix}`, title: titleFromPath(posix), body: "" });
    } else {
      const raw = await readFile(real, "utf8");
      documents.push({
        source: `transcript:${posix}`,
        title: titleFromPath(posix),
        body: raw,
      });
    }
  }

  if (opts.diff) {
    // Through persist's runGit: resolved binary, hardened config, and --end-of-options so a
    // revision like `--output=…` is never read as an option (F-096).
    const body = gitDiffRevision(opts.projectRoot, opts.diff) ?? "";
    documents.push({
      source: `diff:${opts.diff}`,
      title: `git diff ${opts.diff}`,
      body,
    });
  }

  return { files, documents };
}

export function toSourceLabel(source: string): string {
  return toStorePath(source);
}
