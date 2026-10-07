# Workflow implementation status - 2026-10-07

Scope: the AI-DLC Workflow Alignment and Planning Assistance plans in this
directory, implemented in the isolated workflow-planning checkout. This ledger
records implementation progress and verification boundaries. The two source
plans remain planning contracts and have not been rewritten as completion claims.

Implementation and targeted local verification are complete. All known local
failures are resolved; separate usability, packaging, and CI gates are listed below.

## Implemented subsystems

| Subsystem | Changes present in the checkout | Verification status |
| --- | --- | --- |
| Shared schema | New preparation/assistance contracts; policy marker; acceptance method/evidence fields; source and planning decision metadata; schema exports/emission registry | Schema generation and 48 cases pass |
| Preparation validation | Finite applicability stages, structured artifacts, input/digest binding, distinct spec/plan identity, acceptance coverage, strategy/knowledge/testing metadata | Targeted checks pass |
| Lifecycle engine | Preparation promotion under engine guards, approval binding, complete approved scope, acceptance evidence and handoff gates, preparation status; assistance wrappers and bounded proposal execution | Targeted core and challenge recovery checks pass |
| Intake and discovery | Local text proposal with provenance, imported missing decisions, singleton answer persistence with existing round limits, decision dependencies and human resolutions, safe project-aware input inventory | Unit and engine integration checks pass |
| Planning assistance | Guidance session/pause/resume/archive, recommendation proposals, explicit exploration rounds, two-option comparison with one revision, strategy/granularity preference | Targeted checks pass; live usability remains separate |
| Agent contract | Preparation and assistance proposals confined to run cache; proposal-only spawn handling; project-neutral skill instructions and canonical examples | Sandbox checks and three schema-validated examples pass |
| CLI | Existing spec/plan options and engine calls; explicit recommendation/selection controls; acceptance method/reference; read-only preparation output and actionable next commands | All 95 selected cases pass across initial run and scoped repairs |
| Documentation | README, canonical workflow guide, skills, implementation validation boundary, this ledger | Updated; tracked diff whitespace check passed |
| Regression tests | New CLI assistance, core assistance/proposal sandbox/preparation engine, schema preparation tests; existing intent/focused cases extended | Results below |

Implementation and verification were completed in the isolated checkout. The
user subsequently authorized committing the changes and opening a pull request.
No package publication, deployment, destructive cleanup, or production action
was performed. Existing work in the original checkout is preserved.

## Observed consolidated checks

Windows-local checks used Node 24.19.0 and pnpm 9.15.9. Counts are unique cases
across initial runs and targeted repairs, not the sum of repeated executions.

- Affected dependency graph build passed after repairing a core type signature.
  Affected packages were rebuilt after subsequent changes; schema emission passed.
- Workspace typecheck: all 14 packages passed.
- Schema: 48 passed, including emitted JSON parity and unmarked compatibility.
- Graph: 12 passed. Wiki: 37 passed.
- Core preparation, assistance, proposal sandbox, and challenge validation/sandbox:
  32 passed.
- Core lifecycle regressions: 142 passed, 7 platform skips. Includes real task
  proposal promotion, unapproved replanning, P1-only completion, and refusal of
  another specification's task changes.
- Additional assistance engine integration: 3 passed, covering complete import
  confirmation, source reconciliation, and cross-round human decision preservation.
- CLI selected suites: 95 passed across the initial run and scoped repairs.
- Authorized repair: all 24 affected challenge/recovery cases passed, including
  eight new cases for additive references, exact checkpoint recovery, and stale
  or unrelated changes. The other 16 cases overlap the earlier lifecycle count.
- Three bundled preparation examples parsed against the shared schema after
  substituting their explicitly marked placeholders.
- Independent source review: earlier findings repaired; generated-task promotion
  and the final challenge repair have no outstanding material findings. Review
  identified and confirmed correction of manual acknowledgement capitalization
  handling before the final CLI checks.
- Tracked diff/whitespace check passed with the checkout's Windows line-ending
  handling (`git -c core.whitespace=cr-at-eol diff --check`).

Final unique-case total: **377 passed, 7 skipped, 0 unresolved failures**. This is targeted verification,
not a full workspace test run or release certification. Logs are preserved in
`C:/Users/dasbl/.codex/tmp/workflow-planning-validation/`: `build.log`,
`core-repair2-build.log`, `typecheck.log`, `schema.log`, `graph.log`, `wiki.log`,
`core-preparation.log`, `core-lifecycle.log`, `core-repair1.log`,
`core-repair2.log`, `assistance-engine.log`, `assistance-engine-repair1.log`,
`cli.log`, `cli-repair1.log`, and `cli-repair2.log`. The final authorized repair
is recorded in `authorized-repair-build.log`, `authorized-repair-schema.log`,
`authorized-repair-core.log`, `authorized-repair-cli.log`, and
`authorized-repair-typecheck.log`. Initial failures remain in their original
logs; targeted reruns establish the repaired cases.

## Resolved local blocker and authorized repair

Three CLI scenarios failed after the second targeted repair attempt:

- `discuss + spec templates freeze without a model`
- `focused spec exposes pending challenge JSON, resumes manual answers, and guides status`
- `Checkin session key lines match the design-doc walkthrough (golden)`

All reached `Requirements must reference acceptance AC-CH-01`. Manual challenge
synthesis added an acceptance criterion to SPEC while preparation referenced the
earlier set. Approval correctly refused the mismatch. All three scenarios now
pass with the completed challenge and exact human responses preserved.

Read-only diagnosis confirms that merely regenerating the requirements document
would change the challenge context fingerprint and could repeat the challenge.
The implemented repair is an engine-owned additive update to the requirements'
acceptance-ID index using only the replay-validated challenge additions. Existing
document bytes, all other preparation fields, and original source identities are
retained. Before/after preparation fingerprints in the application checkpoint
prevent recovery from accepting unrelated changes. Plan coverage still must map
all new criteria. CLI output rereads the resulting preparation status.

The user authorized this targeted repair after escalation under the supplied
agent policy: "After two different failed repair attempts, return the evidence
and escalate." Verification passed for the three failing CLI scenarios,
challenge recovery and preparation tamper refusals, schema emission parity,
affected builds, and all 14 workspace typechecks. Recovery runs before any
preparation generation; repeating completed manual review is idempotent and
accepts the same acknowledgement capitalization as the engine. Independent
review has no outstanding findings.

This repair changed `packages/core/src/engine.ts`,
`packages/core/src/workflow-preparation.ts`, `packages/schema/src/schemas.ts`,
the emitted `packages/schema/json/spec-challenge.json`,
`packages/cli/src/spec.ts`, and `packages/cli/test/spec-challenge.test.js`.
It added `packages/core/test/challenge-preparation.test.js`. The implementation
ledger and `docs/design/workflow-focus-validation.md` record the final evidence.

The final targeted commands were:

```sh
pnpm --filter @9thlevelsoftware/legion-cli-schema run build
pnpm --filter @9thlevelsoftware/legion-cli-schema run emit
pnpm --filter @9thlevelsoftware/legion-cli-core run build
pnpm --filter @9thlevelsoftware/legion-cli run build
node --test --test-concurrency=2 packages/core/test/challenge-preparation.test.js packages/core/test/spec-challenge.test.js packages/core/test/spec-challenge-recovery.test.js
node --test --test-name-pattern='JSON Schema emit files match runtime schemas' packages/schema/test/schema.test.js
node --test --test-concurrency=2 --test-name-pattern='discuss \+ spec templates|focused spec exposes|Checkin session key' packages/cli/test/intent-spec.test.js packages/cli/test/spec-challenge.test.js packages/cli/test/transcripts.test.js
pnpm typecheck
git -c core.whitespace=cr-at-eol diff --check
```

## Separate acceptance and external gates

- Live-adapter and representative-user trials: guided rough idea, direct complete
  brief, partial brief, explain/recommend/edit/unsure/pause, resumed exploration,
  two-option selection/revision, and non-JavaScript refactor. Fake adapters verify
  orchestration; they do not establish explanation/design quality.
- Linux/native, Windows/native, Linux/Docker, and macOS sandbox CI; this local
  checkout cannot establish all platform behavior. Q-WIN-DOCKER remains the named
  existing deferral until its opt-in self-hosted evidence exists.
- Any approved provider/deployment/device/physical/rollout evidence remains an
  external requirement. Missing evidence is pending and cannot establish ship
  readiness. This task does not authorize release or deployment.
- Clean consumer packaging smoke has not been run for this revision.
- Executable exploration prototypes, ordered tasks sharing files, and external
  tracker publication remain explicitly outside these plans' implementation scope.

## Coordination notes and remaining review points

- CLI consumes engine-owned operations and never writes approval/preparation
  authority. Guidance/display positions are excluded from approval identity.
- Imported prose and agent proposals cannot approve, trust wiki pages, or claim
  verified execution. A complete import still passes the normal substantive gates.
- Granularity is coarse|balanced|fine; risk-first requires the probe and dependent
  task order, while expand-contract identifies evidenced retirement prerequisites.
- Comparison resumes the current stage's saved alternatives; one explicit human
  revision preserves history. Explicit adapter/profile routing is forwarded.
- No graph-contract, revert, or persistence-policy relaxation was introduced.
- The original `D:/legion-cli` checkout still has only its pre-existing untracked
  planning documents. Work is isolated on `codex/workflow-planning` at
  `C:/Users/dasbl/.codex/worktrees/workflow-planning/legion-cli`, based on `1c4c8464`.

First-run input inventory: spec/plan now accept repeatable --input repository
source paths and forward inputRoots to the engine. This lets nonstandard layouts
participate before a preparation record exists; no CLI file reads or configuration
changes are introduced. CLI help assertions passed in the targeted suite.
