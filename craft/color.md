# Color

Brand-agnostic color rules. When a package `tokens.css` exists, **brand tokens win**; craft covers the rest.

```css
:root {
  --legion-bg: #f5f5f0;
  --legion-ink: #222;
  --legion-accent: #c45c26;
  --legion-muted: #888;
}
```

- Semantic tokens only. Do not introduce a decorative sixth color.
- Body text meets WCAG AA against its background (AAA if the package says so).
- Do not rely on color alone for state.
- No rainbow palettes, no default purple-on-white “AI” look.
