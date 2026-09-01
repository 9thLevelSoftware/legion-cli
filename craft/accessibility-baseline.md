# Accessibility baseline

Default target is WCAG AA. A design-system package may raise it to AAA; it must not lower it below A.

- Visible focus rings. Keyboard path through every action.
- Labels on inputs; do not use placeholder as the only label.
- Hit targets ≥ 24px.
- Honor `prefers-reduced-motion`.
- Images that convey meaning get alt text; decorative images get empty alt.
- Do not trap focus in a modal without a keyboard exit.
