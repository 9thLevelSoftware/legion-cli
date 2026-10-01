---
name: performance
description: Measure startup, interaction, resources, and memory against declared local baselines.
compatibility: "Legion CLI >=0.0.0"
allowed-tools: Read, Write, Bash(node:*), Bash(npm run:*), Bash(pnpm run:*)
metadata:
  legion:
    extensionId: performance
    version: 1.0.0
    resources:
      references: [references/measurements.md]
    requiredTools: [node]
    checks: [startup, interaction, resources, memory]
    permissions:
      read: [package.json, pnpm-lock.yaml, src, app, test, tests, .legion-cli/performance-baselines.json]
      write: [.legion-cli/extensions/runs/**]
      commands: [node, npm run, pnpm run]
---

# Performance evidence

Read `references/measurements.md` and the optional local baseline file. Measure
only deterministic entry points already configured by the project. Preserve raw
samples as run artifacts and report the median, sample count, environment, and
baseline comparison in each check detail.

Cover startup, a representative interaction, transferred or loaded resources,
and memory. Mark a measurement unavailable when the product, harness, or baseline
does not expose it. A missing baseline is not a pass.

Write evidence to `evidence.json` and proposed improvements to
`recommendations.json`. Do not change product code or baselines.
