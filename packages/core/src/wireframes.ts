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

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
