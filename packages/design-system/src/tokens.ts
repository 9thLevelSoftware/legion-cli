const VAR_RE = /(--[A-Za-z0-9-_]+)\s*:\s*([^;]+);/g;
const HEX_RE = /#(?:[0-9a-fA-F]{3,8})\b/g;

export type CssVars = Record<string, string>;

export function extractCssVars(css: string): CssVars {
  const out: CssVars = {};
  const re = new RegExp(VAR_RE.source, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(css))) {
    out[match[1]] = match[2].trim();
  }
  return out;
}

export function extractHexColors(text: string): string[] {
  const found = text.match(HEX_RE) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const color of found) {
    const key = color.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(color);
  }
  return out;
}

/** Brand vars overlay craft. Brand tokens win; craft covers the rest. */
export function mergeCssVars(craft: CssVars, brand: CssVars): { merged: CssVars; overridden: string[] } {
  const overridden: string[] = [];
  const merged: CssVars = { ...craft };
  for (const [key, value] of Object.entries(brand)) {
    if (key in craft && craft[key] !== value) overridden.push(key);
    merged[key] = value;
  }
  return { merged, overridden };
}

export function formatCssVars(vars: CssVars): string {
  const lines = Object.entries(vars).map(([key, value]) => `  ${key}: ${value};`);
  return `:root {\n${lines.join("\n")}\n}\n`;
}

export const DEFAULT_TOKENS = `:root {
  --legion-bg: #f5f5f0;
  --legion-ink: #222;
  --legion-accent: #c45c26;
  --legion-muted: #888;
}
`;
