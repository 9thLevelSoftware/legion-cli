/** Shipyard 4-colour palette. Wireframes must keep these tokens until spec freeze. */
export const WIREFRAME_PALETTE = {
  background: "#f5f5f0",
  ink: "#222",
  accent: "#c45c26",
  muted: "#888",
} as const;

export const WIREFRAME_CSS = `:root {
  --bg: ${WIREFRAME_PALETTE.background};
  --ink: ${WIREFRAME_PALETTE.ink};
  --accent: ${WIREFRAME_PALETTE.accent};
  --muted: ${WIREFRAME_PALETTE.muted};
}
html, body {
  background: var(--bg);
  color: var(--ink);
  font-family: Georgia, "Times New Roman", serif;
  margin: 0;
}
a { color: var(--accent); }
.muted { color: var(--muted); }
header, footer { padding: 1rem 1.5rem; border-bottom: 1px solid var(--muted); }
main { padding: 1.5rem; max-width: 52rem; }
.screen {
  border: 1px solid var(--ink);
  min-height: 24rem;
  padding: 1.5rem;
  background: var(--bg);
}
.btn {
  display: inline-block;
  background: var(--accent);
  color: var(--bg);
  padding: 0.5rem 1rem;
  text-decoration: none;
  border: 0;
}
`;

export function slugifyScreen(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "screen";
}

export type ScreenPage = {
  name: string;
  slug: string;
};

export function uniqueScreenPages(screens: string[]): ScreenPage[] {
  const used = new Set<string>();
  const pages: ScreenPage[] = [];
  for (const name of screens) {
    let slug = slugifyScreen(name);
    if (used.has(slug)) {
      let n = 2;
      while (used.has(`${slug}-${n}`)) n += 1;
      slug = `${slug}-${n}`;
    }
    used.add(slug);
    pages.push({ name, slug });
  }
  return pages;
}

export function renderWireframeScreen(opts: {
  specTitle: string;
  screen: string;
  slug: string;
  pages: ScreenPage[];
}): string {
  const nav = opts.pages
    .map((page) => {
      const href = `${page.slug}.html`;
      return page.slug === opts.slug
        ? `<span class="muted">${escapeHtml(page.name)}</span>`
        : `<a href="${href}">${escapeHtml(page.name)}</a>`;
    })
    .join(" · ");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(opts.screen)} · ${escapeHtml(opts.specTitle)}</title>
  <style>
${WIREFRAME_CSS}
  </style>
</head>
<body>
  <header>
    <p class="muted">${escapeHtml(opts.specTitle)} · v0 wireframe</p>
    <nav>${nav} · <a href="INDEX.html">Index</a></nav>
  </header>
  <main>
    <h1>${escapeHtml(opts.screen)}</h1>
    <div class="screen">
      <p>Primary action for <strong>${escapeHtml(opts.screen)}</strong>.</p>
      <p><a class="btn" href="INDEX.html">Continue</a></p>
      <p class="muted">Palette locked until spec freeze.</p>
    </div>
  </main>
</body>
</html>
`;
}

export function renderWireframeIndex(opts: { specTitle: string; specId: string; pages: ScreenPage[] }): string {
  const items = opts.pages
    .map((page) => `    <li><a href="${page.slug}.html">${escapeHtml(page.name)}</a></li>`)
    .join("\n");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Wireframes · ${escapeHtml(opts.specTitle)}</title>
  <style>
${WIREFRAME_CSS}
  </style>
</head>
<body>
  <header>
    <p class="muted">${escapeHtml(opts.specId)} · open in a browser or the dashboard /spec iframe</p>
    <h1>${escapeHtml(opts.specTitle)}</h1>
  </header>
  <main>
    <p>Click a screen. Palette: background ${WIREFRAME_PALETTE.background}, ink ${WIREFRAME_PALETTE.ink}, accent ${WIREFRAME_PALETTE.accent}, muted ${WIREFRAME_PALETTE.muted}.</p>
    <ul>
${items}
    </ul>
  </main>
</body>
</html>
`;
}

export function palettePresent(html: string): boolean {
  return (
    html.includes(WIREFRAME_PALETTE.background) &&
    html.includes(WIREFRAME_PALETTE.ink) &&
    html.includes(WIREFRAME_PALETTE.accent) &&
    html.includes(WIREFRAME_PALETTE.muted)
  );
}

const DENIED_TAGS = new Set(["script", "iframe", "object", "embed"]);
const JS_URL_ATTRS = new Set(["href", "src", "xlink:href", "action", "formaction"]);
const ATTR_RE = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

/** HTML5: comments also end at `<!-->`, `<!--->`, and `--!>`, not only `-->`. */
function stripHtmlComments(html: string): string {
  let out = "";
  let i = 0;
  while (i < html.length) {
    const start = html.indexOf("<!--", i);
    if (start === -1) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, start);
    const body = start + 4;
    if (html[body] === ">") {
      i = body + 1;
      continue;
    }
    if (html[body] === "-" && html[body + 1] === ">") {
      i = body + 2;
      continue;
    }
    const rest = html.slice(body);
    const endDash = rest.indexOf("-->");
    const endBang = rest.indexOf("--!>");
    if (endDash === -1 && endBang === -1) break;
    if (endBang !== -1 && (endDash === -1 || endBang < endDash)) {
      i = body + endBang + 4;
    } else {
      i = body + endDash + 3;
    }
  }
  return out;
}

function codePoint(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 0x10ffff) return "";
  try {
    return String.fromCodePoint(n);
  } catch {
    return "";
  }
}

const NAMED_ENTITY_TAIL = "(?:;|(?=[^a-zA-Z0-9=]|$))";

/** Named + numeric entities, then &amp; last. Repeat so `&#106;avascript&colon;` still decodes. */
function decodeHtmlEntities(value: string): string {
  let prev = value;
  for (let i = 0; i < 4; i++) {
    const next = prev
      .replace(new RegExp(`&colon${NAMED_ENTITY_TAIL}`, "gi"), ":")
      .replace(new RegExp(`&sol${NAMED_ENTITY_TAIL}`, "gi"), "/")
      .replace(new RegExp(`&tab${NAMED_ENTITY_TAIL}`, "gi"), "\t")
      .replace(new RegExp(`&newline${NAMED_ENTITY_TAIL}`, "gi"), "\n")
      .replace(/&#x([0-9a-fA-F]+);?/g, (_, hex) => codePoint(parseInt(hex, 16)))
      .replace(/&#([0-9]+);?/g, (_, dec) => codePoint(Number(dec)))
      .replace(new RegExp(`&lt${NAMED_ENTITY_TAIL}`, "gi"), "<")
      .replace(new RegExp(`&gt${NAMED_ENTITY_TAIL}`, "gi"), ">")
      .replace(new RegExp(`&quot${NAMED_ENTITY_TAIL}`, "gi"), '"')
      .replace(new RegExp(`&apos${NAMED_ENTITY_TAIL}`, "gi"), "'")
      .replace(new RegExp(`&amp${NAMED_ENTITY_TAIL}`, "gi"), "&");
    if (next === prev) break;
    prev = next;
  }
  return prev;
}

function compactUrl(value: string): string {
  return decodeHtmlEntities(value).replace(/[\s\u00a0\u200b\u200c\u200d\ufeff]+/g, "");
}

const DATA_IMAGE_ALLOW = /^data:image\/(?:png|jpeg|jpg|gif|webp)(?:[;,]|$)/i;

function deniedUrlScheme(value: string): "javascript:" | "data:" | null {
  const compact = compactUrl(value);
  if (/^javascript:/i.test(compact)) return "javascript:";
  if (/^data:/i.test(compact) && !DATA_IMAGE_ALLOW.test(compact)) return "data:";
  return null;
}

/** Slash outside quotes is a tag-name separator (`<img/onclick=`). */
function normalizeAttrSource(raw: string): string {
  let out = "";
  let quote: '"' | "'" | null = null;
  for (const ch of raw) {
    if (quote) {
      if (ch === quote) quote = null;
      out += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      continue;
    }
    out += ch === "/" ? " " : ch;
  }
  return out;
}

function parseHtmlAttrs(raw: string): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = [];
  const re = new RegExp(ATTR_RE.source, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(normalizeAttrSource(raw)))) {
    const name = match[1];
    if (!name || name === "/") continue;
    out.push({ name, value: match[2] ?? match[3] ?? match[4] ?? "" });
  }
  return out;
}

function relTokens(value: string): string[] {
  return value.trim().split(/\s+/).filter(Boolean);
}

/** Quote-aware: do not stop the tag at `>` inside attribute values. */
function forEachOpenTag(html: string, visit: (tag: string, attrSource: string) => void): void {
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) break;
    const next = html[lt + 1];
    if (next === "!" || next === "/" || next === "?" || next === undefined) {
      i = lt + 2;
      continue;
    }
    let j = lt + 1;
    if (!/[A-Za-z]/.test(html[j] ?? "")) {
      i = lt + 1;
      continue;
    }
    const tagStart = j;
    while (j < html.length && /[A-Za-z0-9:-]/.test(html[j] ?? "")) j += 1;
    const tag = html.slice(tagStart, j);
    let quote: '"' | "'" | null = null;
    const attrStart = j;
    while (j < html.length) {
      const ch = html[j] ?? "";
      if (quote) {
        if (ch === quote) quote = null;
        j += 1;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        j += 1;
        continue;
      }
      if (ch === ">") {
        j += 1;
        break;
      }
      j += 1;
    }
    const attrEnd = html[j - 1] === ">" ? j - 1 : j;
    visit(tag, html.slice(attrStart, attrEnd));
    i = j;
  }
}

/** Fail-closed HTML policy. Attribute names matching /^on/i, not substring `on` in values. */
export function assertWireframeHtml(html: string): void {
  forEachOpenTag(stripHtmlComments(html), (rawTag, attrSource) => {
    const tag = rawTag.toLowerCase();
    const attrs = parseHtmlAttrs(attrSource);
    if (DENIED_TAGS.has(tag)) {
      throw new Error(`wireframe HTML denies <${tag}>`);
    }
    if (tag === "link") {
      const rel = attrs.find((attr) => attr.name.toLowerCase() === "rel");
      if (rel && relTokens(rel.value).some((token) => token.toLowerCase() === "import")) {
        throw new Error("wireframe HTML denies <link rel=import>");
      }
    }
    for (const attr of attrs) {
      if (/^on/i.test(attr.name)) {
        throw new Error(`wireframe HTML denies ${attr.name.toLowerCase()}`);
      }
      if (JS_URL_ATTRS.has(attr.name.toLowerCase())) {
        const scheme = deniedUrlScheme(attr.value);
        if (scheme) {
          throw new Error(`wireframe HTML denies ${scheme} ${attr.name.toLowerCase()}`);
        }
      }
    }
  });
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
