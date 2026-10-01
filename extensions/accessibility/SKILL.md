---
name: accessibility
description: Collect automated and manual accessibility evidence without modifying product files.
compatibility: "Legion CLI >=0.0.0"
allowed-tools: Read, Write, Bash(npx axe:*), Bash(npx playwright:*)
metadata:
  legion:
    extensionId: accessibility
    version: 1.0.0
    resources:
      references: [references/checklist.md]
    requiredTools: [node, npx]
    checks: [axe, keyboard, focus, manual]
    permissions:
      read: [package.json, src, app, test, tests, playwright.config.ts, playwright.config.js, playwright.config.mjs, playwright.config.cjs]
      write: [.legion-cli/extensions/runs/**]
      commands: [npx axe, npx playwright]
---

# Accessibility evidence

Inspect the active product without changing product files. Use the checklist in
`references/checklist.md`. Run configured axe and Playwright checks when their
dependencies and a runnable target are available. Record keyboard order, visible
focus, focus restoration, and manual checks separately.

Write `evidence.json` using the schema in the run prompt. Every expected check
must be `passed`, `failed`, or `unavailable`, with a concrete detail. Never turn
a missing browser, dependency, page, or human judgment into a pass.

Write suggested changes to `recommendations.json`. Do not edit the product;
Legion CLI converts recommendations into normal tickets for contracted execution.
