/** Golden join: strip one trailing slash, then `/chat/completions`. */
export function completionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/chat/completions`;
}
