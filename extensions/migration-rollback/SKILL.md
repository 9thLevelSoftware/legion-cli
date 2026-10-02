---
name: migration-rollback
description: Rehearse migrations and rollback on disposable data with restore and idempotency evidence.
compatibility: "Legion CLI >=0.0.0"
allowed-tools: Read, Write, Bash(node:*), Bash(npm run:*), Bash(pnpm run:*), Bash(python:*), Bash(cargo:*)
metadata:
  legion:
    extensionId: migration-rollback
    version: 1.0.0
    resources:
      references: [references/rehearsal.md]
    requiredTools: [node]
    checks: [disposable-target, forward, application, rollback, restore, idempotency]
    permissions:
      read: [package.json, migrations, prisma, supabase, db, database, test, tests]
      write: [.legion-cli/extensions/runs/**]
      commands: [node, npm run, pnpm run, python, cargo]
---

# Migration and rollback evidence

Follow `references/rehearsal.md`. Use disposable data and project-provided local
commands only. Never connect to production or a shared database. Capture the
starting fingerprint, forward migration result, application read/write check,
rollback or restore result, restored fingerprint, and second forward run.

Report destructive steps that lack a disposable target as unavailable. Report a
missing rollback or restore path as failed or unavailable with the reason; never
infer reversibility from a successful forward migration.

Write evidence to `evidence.json`. Put remediation ideas in
`recommendations.json` so they become governed tickets.
