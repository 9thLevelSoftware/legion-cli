import { readFile, realpath, stat } from "node:fs/promises";
import { basename } from "node:path";
import {
  assertInsideProject,
  MAX_INGEST_FILE_BYTES,
  resolveProjectPath,
  runGit,
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
    // Capped like every other ingest source: an oversize diff gets an empty body (recorded as skipped).
    const result = runGit(opts.projectRoot, ["diff", "--end-of-options", opts.diff], { maxBuffer: MAX_INGEST_FILE_BYTES });
    const oversize = result.error?.includes("(ENOBUFS)") ?? false;
    if (result.status !== 0 && !oversize) {
      throw new Error(`git diff ${opts.diff} failed: ${result.error ?? (result.stderr.trim() || "no output")}`);
    }
    const body = oversize ? "" : result.stdout;
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
