# AI-DLC Workflow Alignment Implementation Plan

> **For agentic workers:** Use bounded implementation tasks and independent review for the approval, persistence, and delivery changes. The applicable execution skills are `superpowers:subagent-driven-development` or `superpowers:executing-plans`; repository authorization and verification rules take precedence over their defaults.

**Goal:** Make Legion's workflow consistently structured, project-aware, and enforceable while preserving its current onboarding, execution, and delivery capabilities.

**Architecture:** Keep `init → spec → plan → execute → ship` and the existing lifecycle engine. Add a small, versioned preparation policy whose stage decisions, artifacts, and acceptance mappings feed the existing approval and evidence chain. Stages describe required work within commands; they do not become a second scheduler or a replacement state machine.

**Tech stack:** Existing TypeScript/NodeNext, Zod, Node.js 22+, pnpm 9.15.9, Markdown/YAML project records, and `node:test`.

**Spec:** The proposed design contract in this document. This is a planning deliverable for review, not an approved implementation or a claim of completed validation.

**Planning baseline:** Legion commit `1c4c8464`; working tree was clean before this document. Upstream AI-DLC `main` was inspected on 2026-10-07 at `ef781be25523d42b11f092add8517b0e6676d6b4`.

**Scope extension, 2026-10-07:** The user also requested features inspired by `mattpocock/skills` to support different experience levels and planning strategies. The companion [Planning Assistance and Strategy plan](2026-10-07-planning-assistance.md) adds guidance levels, existing-brief intake, bounded deeper discovery, shared terminology/decisions, alternative-design comparison, and outcome/risk/refactor planning. Implement this workflow-policy foundation first; the companion uses its records and gates. The five-command interface remains the agreed direction.

## Recommendation and alternatives

Adopt AI-DLC's explicit applicability decisions, declared stage inputs/outputs, preparation before construction, and traceability. Preserve Legion's five commands and its spec, plan, and ship approval points. Documentation depth can vary; approval freshness, task contracts, verification, and independent review cannot become weaker because a task is small.

The user confirmed this direction: keep the five commands and strengthen the workflow inside them. Two alternatives were considered: prompt-only changes would improve agent guidance without enforcing completion; copying AI-DLC's complete phase/profile/agent system would substantially expand the product and conflict with the request for a targeted change.

The current upstream has five phases and 33 stages, with routes and depth selected for the work. Legion should adopt the useful workflow principles without taking on the entire upstream implementation. See [Workflow profiles](https://awslabs.github.io/aidlc-workflows/guide/workflow-profiles/), [Phases and stages](https://awslabs.github.io/aidlc-workflows/guide/04-phases-and-stages/), and [Stage contracts](https://awslabs.github.io/aidlc-workflows/harness-engineering/01-anatomy-of-a-stage/). The [pinned source revision](https://github.com/awslabs/aidlc-workflows/tree/ef781be25523d42b11f092add8517b0e6676d6b4) records the comparison baseline; upstream is not a runtime dependency.

## Existing strengths and concrete gaps

| Area | Current evidence | Proposed change |
| --- | --- | --- |
| Onboarding | Greenfield and brownfield change/audit converge on `spec`; audit selects bounded remediation. `packages/cli/src/spec.ts`, `packages/core/src/discovery.ts`. | Preserve all three paths; produce a reviewed context summary that subsequent stages actually consume. |
| Preparation | `spec` captures intent/decisions and runs a bounded challenge; `plan` creates task contracts. No finite, validated preparation-stage contract. | Make applicability and required preparation outputs explicit. |
| Project neutrality | `skills/discuss/SKILL.md` always asks about app platform and local data. Challenge source roots emphasize Node layouts. | Ask only relevant questions and admit declared, safe project inputs across languages and layouts. |
| Approval binding | `workflow.ts` binds spec, tasks, plan, config, discovery, and optional assurance. Discovery binding does not include every possible architecture/design input. | Bind the exact preparation artifacts consumed by approvals. |
| Acceptance planning | Outside optional assurance, criteria and checks are flat lists; a manual pass can omit a note. | Require a planned evidence method for every criterion and concrete manual evidence. |
| Readiness/completion | Readiness requires a P0 criterion and task. Focused execution works through all tasks, but status does not independently check the complete approved task set. | Treat priority as order/importance, and make complete approved scope the invariant. |
| Recovery and continuation | Task amendments, explicit retry, `abandon`, and `spec new` already exist. | Use these paths and report the earliest actionable blocker. Preserve historical evidence. |

These findings come from source inspection. No tests or live workflows were run during planning.

## Design contract

### 1. Preserve the public journey

| Command | Required responsibilities | Human gate |
| --- | --- | --- |
| `init` | Adapter, onboarding mode, workspace setup. | Existing adapter selection. |
| `spec` | Understand the workspace and requested change; settle scope, constraints, applicable risks, and measurable outcomes; record stage applicability; run the existing challenge. | `spec approve` binds requirements and the selected preparation route. |
| `plan` | Complete applicable design work; define dependencies and exclusive file contracts; map criteria to verification and acceptance; prepare delivery notes when relevant. | `plan approve` binds design, tasks, checks, and evidence methods. |
| `execute` | Execute approved tasks with their existing verification, then approved integration checks and independent review. Stop at a concrete blocker. | Existing approved-plan prerequisite; no new routine stage-by-stage prompts. |
| `ship` | Require complete approved scope, current verification/review, criterion-level acceptance, and applicable handoff information. | Existing explicit human delivery approval. |

No new top-level commands, Phase enum expansion, autonomous mode, automatic deployment, or new milestone execution loop. Keep `--step`, task recovery, `--retry`, HTTP resume, and opt-in bounded parallelism.

### 2. A finite preparation policy

Every new-policy specification has mandatory `context` and `requirements` stages. Its assessment also gives each of these conditional stages an explicit `required` or `not_applicable` decision:

- `user-experience`: user journeys, interaction, accessibility, and visual design when the requested change affects them. CLI interaction can apply; browser mockups do not automatically apply.
- `functional-design`: nontrivial behavior, domain rules, failure paths, or state transitions.
- `architecture`: new or changed component boundaries, interfaces, dependencies, or substantial structural choices.
- `nfr-design`: applicable security, privacy, reliability, performance, operational, or compliance requirements needing implementation decisions.
- `infrastructure-design`: hosting, infrastructure, deployment topology, environment, or infrastructure-as-code changes.
- `delivery-handoff`: installation, migration, rollout/rollback, operator actions, or external validation needed to use the result.

Requirements always include a brief applicability assessment of quality attributes; a tiny change can state that it introduces no relevant change and explain why. Do not require every project to create full NFR/design documents. A small bugfix can satisfy its required outputs with concise sections. A service migration may need separate design and rollout artifacts.

Each decision records a rationale and grounded references or explicitly labeled assumptions. Unresolved applicability or a consequential unanswered question blocks the relevant approval. The model proposes the assessment; it cannot grant approval or mark its own work accepted. A human-requested change to applicability updates the draft; after approval it follows the normal invalidation/reapproval rules. Required core stages cannot be disabled.

Selection and completion are separate: `not_applicable` is a reviewed decision; `missing`, `stale`, `blocked`, and `complete` describe validation results. File existence alone does not establish completion. Validate structured required content and its references, then rely on human approval for substantive design judgment. Do not claim machine validation proves design quality.

Minimum structured content is fixed by stage: context contains goal, affected paths, known constraints and unresolved assumptions; requirements references the SPEC's outcomes, invariants, acceptance IDs and quality-attribute applicability; each design stage records the decision, affected interfaces/behavior, failure or compatibility implications, and verification consequences; handoff records installation/rollout, recovery, required external checks and responsible operator role, with reasoned not-applicable entries where appropriate. Every design consumes the approved context and requirements. If a design declares another selected artifact as an input, missing or stale input blocks it; a skipped producer must have an explicit approved alternative input. No arbitrary user-programmable stage graph is introduced.

### 3. Project-aware context without universal toolchain assumptions

The context artifact records onboarding mode, goal, affected areas, relevant components/interfaces, existing behavior to preserve, known verification commands, delivery environment, constraints, and unresolved assumptions. Brownfield audit retains its selected remediation goal and backlog; the specialist audit and its PR worktrees remain separate.

Use existing discovery as evidence, not as a claim of exhaustive reverse engineering. Support multiple languages and subprojects. Unknown stack or layout means a visible limitation and a request for needed paths/commands, not an empty successful scan or a forced JavaScript workflow. Discovery does not install dependencies or execute project commands.

Expand challenge/preparation inputs through one validated input inventory. Include relevant manifests and explicit safe paths, such as `pyproject.toml`, `Cargo.toml`, `go.mod`, `pom.xml`, or selected infrastructure files. Preserve credential exclusions, concrete-path validation, path-alias/hard-link protections, and symlink refusal. Reuse the same inventory for agent-readable inputs, citations, and freshness checks so they cannot disagree.

Keep the challenge at zero to three concerns and at most one synthesis. Applicability questions belong to the existing interview/decision work and do not restart or enlarge the challenge. Preserve the recorded manual fallback and never use it to bypass successfully raised unresolved concerns.

### 4. Records and approval identity

Proposed new schema module: `packages/schema/src/workflow-preparation.ts`. Re-export its contracts through the package's public exports and register generated JSON schemas.

Use these bounded contracts:

- `WorkflowAssessment`: schema version, `policyVersion: 2`, spec ID, context input fingerprint, stage decisions, unresolved decisions, and optional predecessor spec reference.
- `PreparationArtifact`: stage ID, concrete repository-relative path, digest, declared consumed input paths/digests, and structured completion fields. Required sections can share one file; use whole-file content digests initially.
- `AcceptancePlanMapping`: criterion ID, responsible task IDs, evidence methods and expected observations, plus an optional condition under which the criterion does not apply. Methods reference existing task checks, plan integration commands, adopted assurance validator IDs, or a concrete manual/external procedure. Any non-applicability condition must already be part of the approved SPEC.
- `WorkflowPreparation`: assessment, specification-stage artifact bindings, plan-stage artifact bindings, and acceptance mapping. Approved input sections are immutable until their owning gate is revisited.

Canonical authority lives at `.legion-cli/workflow/<specId>/preparation.yaml`, written only by the engine through validated store APIs under mutation/audit/governance guards. Spec-stage drafts can use `.legion-cli/specs/<specId>/preparation/`; plan-stage drafts can use `.legion-cli/plans/<specId>/`. These are within existing skill write roots. Agents propose machine-readable draft records in their run cache; the engine validates and promotes them. Do not grant agents write permission to workflow receipts.

Add an optional `workflowPolicyVersion: 2` marker to new focused specs. Absence means existing behavior; do not supply a parser default that rewrites old identities. Bind a specification preparation digest into its approval and a complete preparation digest into the plan snapshot, alongside the existing assurance digest. The spec digest must exclude later plan-stage completion so finishing design cannot invalidate the already approved specification.

Missing records for a marked spec fail closed; deleting a sidecar cannot downgrade policy. Include marker and digest identity in approvals and audit records. Changes to stage choices or requirements invalidate spec approval and everything downstream; changes limited to plan design/mapping invalidate plan approval and downstream evidence. Never silently regenerate an approval.

Freshness has two timescales: before plan approval, revalidate the reviewed source inputs and preparation outputs; during execution, preserve the approved baseline while task changes intentionally evolve the product. Do not declare every task integration stale merely because a context input was legitimately edited. Existing product/evidence checks govern execution drift and final evidence; preparation artifact edits still stale approval. No broad change to existing product-fingerprint or selective assurance-reuse semantics is included.

### 5. Evidence and complete scope

Every acceptance criterion needs at least one valid planned evidence method. Each method names the actual check or procedure and expected observation; generic text such as "tested" is insufficient. All referenced tasks and checks must exist in the approved scope. Reject missing criteria, duplicate/conflicting criterion entries, unknown task/check IDs, and criteria attached only to removed work.

Use canonical command identities, scoped to task or integration, rather than array positions. A mapping points to existing verification; it does not enqueue another execution. A task check's historical completion is not reusable proof of final whole-product correctness. Final review, integration evidence when planned, and acceptance remain required. Do not automatically pass a criterion because an unrelated command exited successfully.

Assurance mappings reference the adopted manifest's validator IDs and authoritative results. They must not duplicate validator definitions, weaken a failed/unknown result, or create a second coverage authority. Reapproval and adoption/off continue to use existing epochs and trace rules.

Under policy 2, manual pass requires a nonempty observation tied to its approved procedure and a current evidence reference/record. A local evidence file is digest-bound; an external report records its identity and the operator's observation without claiming remote authenticity. Failure and not-applicable still require reasons. A missing external result is pending, not pass. All criteria are required by default: not-applicable is allowed only when a condition already approved in the SPEC and mapping is evidenced as unmet. A note cannot remove required behavior; changing that behavior means changing scope.

Keep meaningful task verification commands required. Plan-wide checks remain optional when they add no integration evidence. Documentation tasks can use documentation/link/format validation; hardware or deployment outcomes need explicit external evidence. This proposal does not invent a manual-only code executor or guarantee execution on every toolchain.

For policy 2, replace arbitrary P0-presence requirements with nonempty approved tasks and acceptance criteria plus complete coverage. Before reporting execution complete or permitting focused ship, independently confirm every approved task still exists, belongs to the active spec, and is `done` or validly `compacted`, with matching completed-task evidence. Preserve graph dependencies and all legacy numeric-QA/P0 rules. Priority still controls ordering and importance.

### 6. Recovery, compatibility, and delivery

Status and JSON expose the selected preparation route, missing/stale outputs, unmapped criteria, and one actionable next command. Status remains read-only; it neither completes stages nor refreshes approvals. Re-running `spec` or `plan` resumes incomplete preparation and preserves saved human answers.

Existing frozen specs and approved plans retain their current behavior and fingerprint identity. Existing unmarked drafts are not silently converted. Newly created focused specs use policy 2; `spec new` is the adoption path for subsequent work. Direct legacy core configurations retain legacy behavior. No new mid-flight migration command is included.

In-scope repairs continue through task amendment and renewed plan approval. Out-of-scope changes use the existing explicit `abandon --message ...` and `spec new` route; never unfreeze a contract implicitly. After delivery, `spec new` may link to the previous increment's delivery record, but cannot inherit its approvals or passing evidence. Project onboarding and historical records remain intact.

Applicable handoff content is approved during planning and confirmed at delivery. Distinguish locally verified completion from pending CI, provider, deployment, device, or physical validation. If an external result is required for the approved scope, it blocks ship until recorded; if deployment is explicitly outside this delivery, report that boundary without claiming deployment success.

## Global constraints

- Keep the five-command default, greenfield/brownfield modes, specialist audit, advanced recovery commands, and adapter routing.
- Keep the bounded challenge, sandbox policy, filtered environment, exclusive file contracts, live-run guards, and explicit human ship gate.
- Use existing store validation/journaling/locks and audit/governance boundaries. No second workflow database or independent scheduler.
- Preserve assurance adoption, information-flow controls, native checks, delivery snapshots, export/signing semantics, and consent rules.
- Keep Node.js `>=22`, pnpm `9.15.9`, public workspace package boundaries, and generated JSON schema parity.
- Do not commit, push, publish, deploy, reset, or remove user work without separate authorization. This plan adds no authorization for those actions.

## Review focus

1. A removed or edited preparation record must not silently restore old policy or preserve stale approval.
2. Approved task source changes must not accidentally stale the frozen preparation baseline after every successful task.
3. A source layout outside common Node paths must receive useful context without exposing credentials or following links.
4. Open P1/P2 tasks, missing mappings, or unknown external evidence must not yield ready-to-ship status.
5. Legacy projects and assurance-adopted projects must retain their prior identities, gates, and recovery semantics.

The tasks below assign a regression scenario to each of these conditions.

## Implementation tasks

### Task 1: Versioned preparation contracts and policy validation

**Files:** Create `packages/schema/src/workflow-preparation.ts`, `packages/core/src/workflow-preparation.ts`, and `packages/core/test/workflow-preparation.test.js`. Modify schema `schemas.ts`, `versions.ts`, `index.ts`, `json-schema.ts`, generated `json/*.json`, and the relevant schema tests.

**Interfaces:** Export `WorkflowAssessment`, `PreparationArtifact`, `AcceptancePlanMapping`, `WorkflowPreparation`, their Zod schemas, and `WorkflowStageId`. Core exposes `validateWorkflowPreparation(record, context): PreparationValidation` returning structured blockers and spec/plan preparation digests. `context` supplies the gate (`spec`, `plan`, or `ship`) and existing spec/task/check/assurance identities; the validator performs no command execution or mutation. Spec validation must not require future plan outputs or mappings.

- [ ] Implement the finite stage vocabulary, conditional decisions, required structured outputs, and policy marker without parser defaults for old records.
- [ ] Implement deterministic digest construction, concrete safe artifact references, complete acceptance mapping validation, and distinct spec/plan digest boundaries.
- [ ] Add tests for mandatory-stage omission, unknown stage, missing rationale, dangling references, malformed artifacts, stable legacy parsing, and plan-only changes leaving the spec preparation digest unchanged.

**Deliverable:** A validated preparation model usable by the existing engine without altering runtime behavior for unmarked specs.

### Task 2: Project-aware specification preparation

**Files:** Modify `packages/core/src/engine.ts`, `discovery.ts`, `spec-build.ts`, `spec-challenge-inputs.ts`, `workflow-preparation.ts`, `packages/cli/src/spec.ts`, and `skills/discuss/SKILL.md`, `skills/spec/SKILL.md`, `skills/spec-challenge/SKILL.md`. Extend discovery, intent/spec, challenge-input/recovery, and CLI specification tests.

**Interfaces:** Add engine-owned `readWorkflowPreparation(specId)` and `prepareWorkflowSpecification(specId)` methods. The latter validates/promotes bounded draft output through the existing guarded spawn/mutation flow and returns preparation status; it does not approve the spec. `approveSpec` consumes its validated specification digest.

- [ ] Record context and applicability with the existing interview/decision flow; eliminate unconditional mobile/native/local-storage questions.
- [ ] Use one protected readable-input inventory for context, challenge inputs, citations, and baseline fingerprints. Preserve unknown/truncated discovery limitations explicitly.
- [ ] Mark only newly allocated focused specs with policy 2; promote valid draft output to engine-owned preparation records and require complete preparation at spec approval.
- [ ] Add greenfield, brownfield change/audit, Python/Go/infra layout, custom path, credential/link refusal, interrupted generation, and existing bounded-challenge regression cases.
- [ ] Update the workflow guide's spec/onboarding behavior alongside this change.

**Deliverable:** `spec approve` binds a reviewed, project-appropriate route and context while preserving the existing challenge limits and onboarding paths.

### Task 3: Design preparation and acceptance mapping at plan approval

**Files:** Modify `packages/core/src/engine.ts`, `workflow.ts`, `workflow-preparation.ts`, `readiness.ts`, `contracts.ts` only if required for existing-root precision, `packages/cli/src/plan.ts`, and `skills/plan/SKILL.md`. Extend core/CLI plan tests and `focused-workflow.test.js`.

**Interfaces:** Add `prepareWorkflowPlan(specId)` using the existing plan skill and guarded lifecycle. Extend `createWorkflowPlanSnapshot` with optional `preparationFingerprint`; omit it entirely for old policy. `approvePlan` validates preparation, artifact bindings, and mappings before writing an approval epoch.

- [ ] Have `plan` complete required design outputs before constructing task contracts; allow concise sections for small work and separate artifacts for complex work.
- [ ] Capture task/check/manual/assurance mappings without duplicating command execution or assurance authority.
- [ ] Extend approval identity with preparation digests; maintain spec-vs-plan invalidation boundaries and existing assurance adoption/trace semantics.
- [ ] Add cases for missing design, changed architecture input, unmapped criterion, dangling check reference, failed approval leaving no partial adoption, and legitimate approved task edits preserving the preparation baseline.
- [ ] Remove policy-2 P0 minimums only together with Task 4's complete-scope invariant; retain meaningful per-task verification and legacy policy behavior.

**Deliverable:** An implementation-ready approved plan whose preparation and evidence methods are explicit and bound to its approval.

### Task 4: Complete-scope and acceptance enforcement

**Files:** Modify `packages/core/src/engine.ts`, `workflow.ts`, preparation helpers, acceptance schemas as needed, `packages/cli/src/plan.ts`, and focused/assurance tests.

**Interfaces:** `getWorkflowStatus` and the focused ship prerequisite consume the same complete-approved-task predicate. `recordAcceptance` validates the approved evidence method and records concrete observations/references; existing assurance validators remain authoritative.

- [ ] Require the full approved task set and matching completion evidence before complete/ship-ready status; treat missing or reopened tasks as blockers.
- [ ] Require substantive manual evidence for policy-2 pass and retain pending status for unavailable required external evidence.
- [ ] Add P1-only successful lifecycle, open P2, removed/reopened task, criterion evidence mismatch, stale local evidence reference, unknown external result, and assurance-failure-cannot-be-overridden cases.
- [ ] Verify a mapping to an existing task check does not schedule a duplicate check and does not automatically pass acceptance.
- [ ] Update acceptance and delivery documentation in the same task.

**Deliverable:** Ship readiness means the entire approved increment is complete and its criteria have current evidence.

### Task 5: Coherent status, recovery, and compatibility

**Files:** Modify `packages/core/src/engine.ts`, `packages/cli/src/status.ts`, `next.ts`, `spec.ts`, relevant JSON/result types, `README.md`, `docs/design/workflow-focus.md`, and `docs/design/workflow-focus-validation.md`. Update `help-all.ts`/registration tests only if existing command descriptions/options change.

**Interfaces:** Extend workflow status with a preparation summary and structured blocker details while retaining existing fields and the single `next` command. Read operations never generate artifacts or mutate receipts.

- [ ] Report the earliest missing decision/output/check with the owning command and resume saved preparation rather than repeating completed interviews.
- [ ] Preserve old focused/legacy lifecycles and fingerprint identities. Test policy-2 next increments without retrospective conversion of historical specs.
- [ ] Test missing sidecars, invalid records, interrupted approval recovery, amendment invalidation, abandon/new-spec continuation, and inability to reuse prior-increment evidence.
- [ ] Ensure assurance/governance mutations incorporate preparation authority and preserve no-write refusal behavior, approval epochs, undo/audit history, and protected paths.
- [ ] Document small bugfix, CLI/library, brownfield service change, infrastructure/migration, and docs-only examples with different required preparation and evidence.

**Deliverable:** One understandable workflow across supported project types, with actionable recovery and preserved compatibility.

## Planned verification

Plan checks before implementation. After Tasks 1–5, compile the affected dependency graph once, emit schemas once, then execute one consolidated targeted suite. Do not run overlapping package-wide suites again merely for reassurance. If a failure needs a supported repair, rerun only its affected failed check; after two different failed repair attempts, return the evidence and escalate.

Commands, run separately from the repository root:

1. `pnpm --filter @9thlevelsoftware/legion-cli... run build`
2. `pnpm --filter @9thlevelsoftware/legion-cli-schema run emit`
3. `node --test packages/schema/test/schema.test.js packages/schema/test/governed-records.test.js packages/core/test/workflow-preparation.test.js packages/core/test/focused-workflow.test.js packages/core/test/discovery.test.js packages/core/test/plan.test.js packages/core/test/intent-spec.test.js packages/core/test/spec-challenge.test.js packages/core/test/spec-challenge-validation.test.js packages/core/test/spec-challenge-sandbox.test.js packages/core/test/spec-challenge-recovery.test.js packages/core/test/workflow-protection.test.js packages/core/test/undo-audit.test.js packages/core/test/assurance-adoption.test.js packages/core/test/assurance-checks.test.js packages/core/test/assurance-flow.test.js packages/core/test/governance-faults.test.js packages/cli/test/intent-spec.test.js packages/cli/test/spec-challenge.test.js packages/cli/test/plan.test.js packages/cli/test/next.test.js packages/cli/test/help-registration.test.js packages/cli/test/transcripts.test.js`
4. `pnpm typecheck`
5. `git diff --check`

Add new schema cases to the named schema suite or include the new suite explicitly. Change the planned suite only when an implementation change introduces a concrete additional concern. The expected result is passing assertions with platform skips reported separately, not silently counted as exercised behavior.

The workflow fixture matrix must cover greenfield CLI/library, brownfield service change, bounded audit remediation, small P1-only repair, non-JavaScript multi-component work, infrastructure/migration, documentation, and an unknown/custom toolchain. Deterministic fake adapters prove orchestration and refusals; they do not prove real vendor-agent quality or availability of every external runtime.

Release verification remains separate: required CI for Linux/native, Windows/native, Linux/Docker, macOS sandbox, consumer packaging, and the existing native/assurance/governance jobs must pass for the eventual implementation revision. The current CI definition is authoritative. Windows/Docker remains its named deferral. Exercise a representative real greenfield and brownfield flow with a supported live adapter before claiming end-to-end product validation. Provider deployment, physical validation, publishing, and public attestation are outside this planning task.

## Scope boundary and completion criteria

This work is complete when the new-policy workflow enforces declared preparation and evidence across the fixture matrix; existing focused/legacy and assurance flows remain compatible; status identifies the right blocker; and changes to approved inputs reliably invalidate the affected evidence.

Defer a generic workflow DSL/plugin-stage engine, large profile catalogue, stage-specific agent roster, enterprise team orchestration, new deployment platform, autonomous repair loops, arbitrary frozen-spec revision, and a replacement scheduler. None is needed for the proposed alignment.

The companion assistance features are proposed additions to the product scope. Executable pre-spec prototypes and sequential tasks with shared file ownership remain separately scoped extensions because they change execution or contract guarantees; assistance and planning strategy alone must not enable them.

The result should make the process dependable for varied software projects while stating capability limits honestly. It should not claim that one workflow can automatically verify every possible project or environment.
