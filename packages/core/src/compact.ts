export const COMPACT_AUDIT_POINTER =
  "Closed task logs live in `.legion-cli/audit/`; do not reload them.";

const OUTCOME_CAP = 500;

export function outcomeFromTask(notes: string, body: string): string {
  const fromNotes = notes.trim();
  if (fromNotes.length > 0) return fromNotes.slice(0, OUTCOME_CAP);
  for (const line of body.replaceAll("\r\n", "\n").split("\n")) {
    const match = /^outcome\s*:\s*(.+)$/i.exec(line.trim());
    const extracted = match?.[1]?.trim();
    if (extracted) return extracted.slice(0, OUTCOME_CAP);
  }
  return "Done.";
}

export function compactTaskBody(title: string, outcome: string): string {
  const trimmed = outcome.trim() || "Done.";
  return `# ${title}\n\n${trimmed}\n\n${COMPACT_AUDIT_POINTER}\n`;
}
