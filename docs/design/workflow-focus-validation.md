# Focused workflow implementation record

Approved direction: five commands (`init`, `spec`, `plan`, `execute`, `ship`),
human spec/plan/ship approvals, sequential execution to completion or blocker,
brownfield scoped-change or audit starts, and project-specific evidence.

## Integration ownership

- Engine/schema: focused_engine; content-bound approvals, orchestrator, receipts, ship gate.
- CLI: focused_cli; help, onboarding, composed spec, approval/evidence commands, status.
- Documentation: focused_docs; README, agent instructions, canonical guide and skills.
- Neutral interview: project_neutral_intent; legacy replay and non-UI questions.
- Root: bounded discovery and audit selection, workflow receipt protection, integration checks.
- Independent inspection: focused_review; no test execution or mutations.

Existing untracked `.claude/` and `CLAUDE.md` are user work and are preserved.
No commits, pushes, releases, or publishing are part of this implementation.

## Decisions

- Preserve existing low-level engine and advanced command APIs. CLI execution uses
  the focused orchestrator. New CLI projects select the focused profile; existing
  projects adopt it explicitly with `plan approve`, including `ready_to_ship` runs.
- Existing frozen specs without a content-bound receipt are imported explicitly
  when their existing plan is approved. Their data is not regenerated.
- Audit orientation is bounded static evidence, not a comprehensive security audit.
  A saved, bounded remediation goal and affected area are required before drafting.
- Conservatively bind project checks to product source/configuration bytes so
  changes outside a task's write contract cannot silently preserve stale evidence.
  Ignore Legion bookkeeping and generated dependency/build trees. Git HEAD alone
  is not a verification input. Narrowing this snapshot requires explicit safe input
  coverage rather than guessing which imported files matter.
- No automatic repair or repeated review loop. Failed evidence returns a blocker.

## Verification

- Workspace dependencies built; the final affected core/dashboard/MCP/CLI build passed.
- Schema emission passed; schema and persistence suites passed (146 passed, 2 skipped).
- Workspace typecheck passed after the final engine changes.
- Core discovery, protected receipts, neutral interviews, contracts, HTTP host,
  intent/spec, review, and ship regressions passed. Old optional-wireframe readiness
  assertions were updated and the affected plan/lifecycle regressions passed.
- Focused tests cover approval epochs, stale evidence, retained planned checks,
  retry/resume, explicit reviewer verdicts, manual acceptance, safe legacy adoption,
  concurrent claims, and mutation during verification. Fourteen passed in the final
  focused run; the remaining refusal-message assertion passed after its correction.
- CLI help/registration, composed spec, onboarding, brownfield extras, next-command,
  ship, and fix regressions passed. Execute/status and transcript fixtures were
  updated for approvals and the deliberate missing-review blocker from the fake
  adapter; all final targeted reruns passed, including corrupt-receipt status and
  the focused Checkin walkthrough.
- Independent source review has no unresolved critical/high findings. Diff whitespace
  checks passed using the checkout's configured Windows line-ending handling.

Final recovery routing also passed an affected-package build and targeted adapter
and invalid-task CLI checks. Detailed command outputs are in the ignored logs:

- `scratchpad-workflow-persistence-tests.log`
- `scratchpad-workflow-core-tests.log` and `scratchpad-workflow-focused-tests.log`
- `scratchpad-workflow-gates-tests.log` and `scratchpad-workflow-adoption-final-tests.log`
- `scratchpad-workflow-cli-repaired-tests.log` and `scratchpad-workflow-execute-final-tests.log`
- `scratchpad-workflow-transcript-final-tests.log`
- `scratchpad-workflow-execute-recovery-tests.log` and `scratchpad-workflow-session-recovery-tests.log`
- `scratchpad-workflow-final-typecheck.log` and `scratchpad-workflow-recovery-build.log`

Earlier logs retain corrected failures; the scoped reruns above establish their
resolution. Checks were run once per relevant revision; reruns were limited to failures or
changed behavior. Logs are local ignored `scratchpad-workflow-*.log` files. No
live vendor-agent delivery run, release, or publishing was performed. Required
Linux/Docker CI cannot be claimed from the local Windows checkout.

## Follow-up limitations

- The execution environment receipt binds OS, architecture, and Node version.
  Product inputs include dependency manifests/lockfiles, but installed dependency
  and other toolchain changes without source changes are not fully fingerprinted.
- A hard-killed orchestrator can leave a verification child running; recovery does
  not persist that child's process identity. Normal signals and timeouts clean up
  process trees.
- Whole-repository product hashing is conservative and can be slow in large
  brownfield repositories. A future cache must preserve stale-evidence detection.
