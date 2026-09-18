import type { FingerprintFile } from "@9thlevelsoftware/legion-cli-schema";

export const GENERATED_START = "<!-- legion-cli:generated:start -->";
export const GENERATED_END = "<!-- legion-cli:generated:end -->";

const DEFAULT_NOTES = "## Notes\nHuman prose below this line is preserved across --refresh.\n";

export function renderArchitecture(file: FingerprintFile): string {
  const modules = file.modules.map((module) => {
    const exports = module.exports.join(", ");
    return `- \`${module.path}\` — exports: ${exports}`;
  });
  return [
    GENERATED_START,
    "# Architecture",
    `backend: ${file.backend}`,
    `rootHash: ${file.rootHash}`,
    "## Modules",
    ...modules,
    GENERATED_END,
    "",
  ].join("\n");
}

/** Replace only the generated markers; prose outside them is kept. */
export function mergeArchitecture(existing: string | undefined, generated: string): string {
  const block = generated.endsWith("\n") ? generated : `${generated}\n`;
  if (existing === undefined) return `${block}\n${DEFAULT_NOTES}`;
  const normalized = existing.replaceAll("\r\n", "\n");
  const start = normalized.indexOf(GENERATED_START);
  const end = normalized.indexOf(GENERATED_END);
  if (start === -1 || end === -1 || end < start) {
    const rest = normalized.replace(/^\n+/, "");
    return rest.length > 0 ? `${block}\n${rest}` : `${block}\n${DEFAULT_NOTES}`;
  }
  const before = normalized.slice(0, start);
  const after = normalized.slice(end + GENERATED_END.length).replace(/^\n/, "");
  return `${before}${block}${after}`;
}
