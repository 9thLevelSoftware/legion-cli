# Planning Assistance and Strategy Implementation Plan

> **For agentic workers:** Implement bounded tasks under the repository's agent policy. Use independent review for intake trust, approval identity, persistence, and task-contract changes. Do not commit, push, install referenced skill bundles, or publish project artifacts without authorization.

**Goal:** Help users with different experience levels and starting materials reach a sound, executable plan without requiring them to know the engineering process in advance.

**Architecture:** Add selectable assistance and planning methods inside Legion's five existing commands. All paths produce the same validated specification, preparation records, file contracts, acceptance mappings, and approvals defined by the [workflow alignment foundation](2026-10-07-aidlc-workflow-alignment.md). Assistance changes how the user gets there; the existing engine remains authoritative.

**Tech stack:** Existing TypeScript/NodeNext, Node.js 22+, pnpm 9.15.9, Zod, CLI prompts, local Markdown/YAML records, and `node:test`.

**Spec:** The proposed design contract below. This is a scope extension for review; no implementation has been authorized or performed by creating this document.

**Reference baseline:** `mattpocock/skills` at `f3fc5632f401156837ee3872f14fe33ccf1024ea`, inspected 2026-10-07. These are design references, not instructions to run the upstream skills or a proposed runtime dependency.

## Why extend the foundation

The foundation strengthens required stages and evidence. Users also need help deciding what to do within those stages: expressing an idea, understanding a trade-off, reusing a brief, investigating an unknown, and choosing a useful breakdown of work.

Current Legion has a persisted interview, decisions, generic wiki ingestion/trust, optional wireframes, and dependency-based execution. It lacks a user-selected assistance level, direct brief-to-spec intake, a durable map of unresolved planning questions, and explicit planning strategies. The current interview asks fixed pairs of questions and allows up to eight rounds; importing a document through `ingest` does not fill that interview or adopt a spec.

## Reference-to-feature mapping

| Reference | Useful principle | Proposed Legion feature |
| --- | --- | --- |
| [grilling](https://github.com/mattpocock/skills/blob/f3fc5632f401156837ee3872f14fe33ccf1024ea/skills/productivity/grilling/SKILL.md) | Work through decisions in dependency order; investigate facts instead of making the user retrieve them. | Guided discovery with concrete recommendations, saved answers, and bounded optional deeper exploration. |
| [to-spec](https://github.com/mattpocock/skills/blob/f3fc5632f401156837ee3872f14fe33ccf1024ea/skills/engineering/to-spec/SKILL.md) | Synthesize material already discussed. | Start from an existing brief or saved conversation; ask only about missing or conflicting requirements. |
| [domain-modeling](https://github.com/mattpocock/skills/blob/f3fc5632f401156837ee3872f14fe33ccf1024ea/skills/engineering/domain-modeling/SKILL.md) | Preserve terminology and consequential decisions. | Reuse the project's glossary and architecture decisions; retain reviewed additions across increments. |
| [Design It Twice](https://github.com/mattpocock/skills/blob/f3fc5632f401156837ee3872f14fe33ccf1024ea/skills/engineering/codebase-design/DESIGN-IT-TWICE.md) | Compare meaningfully different interfaces before committing. | An optional two-option design comparison with a recommendation and recorded selection. |
| [to-tickets](https://github.com/mattpocock/skills/blob/f3fc5632f401156837ee3872f14fe33ccf1024ea/skills/engineering/to-tickets/SKILL.md) | Decompose into verifiable outcomes; use expand/contract when a broad refactor needs it. | Outcome-based planning with explicit dependencies and a refactor strategy. |
| [tdd](https://github.com/mattpocock/skills/blob/f3fc5632f401156837ee3872f14fe33ccf1024ea/skills/engineering/tdd/SKILL.md) | Choose meaningful observable behavior and test boundaries before implementation. | A planned testing approach appropriate to the task, including test-first when useful. |
| [wayfinder](https://github.com/mattpocock/skills/blob/f3fc5632f401156837ee3872f14fe33ccf1024ea/skills/engineering/wayfinder/SKILL.md) and [research](https://github.com/mattpocock/skills/blob/f3fc5632f401156837ee3872f14fe33ccf1024ea/skills/engineering/research/SKILL.md) | Keep unresolved decisions distinct from implementation work and attach evidence to findings. | A local decision map for larger uncertain work; selected research records feed the next specification. |
| [wait-what](https://github.com/mattpocock/skills/blob/f3fc5632f401156837ee3872f14fe33ccf1024ea/skills/productivity/wait-what/SKILL.md) | Explain a confusing recommendation with missing context. | Inline explain/example controls in planning prompts. |

Legion-specific choices below deliberately adapt these ideas. They preserve local state, concrete file contracts, project-appropriate artifacts, and existing human delivery gates. They do not adopt automatic issue publication, upstream branch/commit routines, unrestricted interviews, or universal user-story/TDD requirements.

## Design contract

### 1. Separate assistance, preparation depth, and planning strategy

These answer different questions and must not be one beginner/expert switch:

- **Assistance:** how much explanation and interaction the user wants.
- **Preparation:** what the project and change require, determined by the foundation's applicability policy.
- **Strategy:** how the approved work should be decomposed and ordered.

Provide `guided`, `balanced`, and `direct` assistance. Balanced is the default; users can switch at any point without repeating settled answers. Guided uses plain language, one question at a time, examples, and a recommended answer with its consequence. Balanced groups up to three independent questions. Direct emphasizes the artifact, unresolved gaps, and concise decisions; it still asks for consequential missing information.

Do not infer ability from the user's occupation, vocabulary, or mistakes. At first interactive specification entry, offer a skippable assistance choice with a short explanation. Respect an explicit `spec --guidance guided|balanced|direct` override. Save the current increment's choice; do not alter project configuration merely to change conversational detail.

Planning prompts support explicit controls such as `:explain`, `:example`, `:recommend`, `:back`, and `:pause`. These controls do not become requirement answers. A recommendation is proposed until the user selects or states it. Revising an earlier answer invalidates dependent unresolved proposals; it never silently changes a frozen contract. Closed stdin saves existing progress and reports the next action without approving anything.

Guidance presentation is excluded from approval fingerprints. The actual answers, selected decisions, requirement changes, strategy, and verification methods remain approval-bound. Switching to direct mode cannot suppress a required stage, unresolved challenge, or approval.

### 2. Start from an idea, a brief, or known requirements

Add `spec --from <path>` for a local Markdown/text brief, requirements document, or exported conversation. Normal `spec` continues to start from a conversation. Existing `ingest` remains the route for external documents/URLs; this feature does not add a second network fetcher.

Read the input, record its identity/digest, and propose a mapping into Legion's existing intent/spec fields. Distinguish supplied statements from inferred suggestions and missing facts. Show the resulting intent summary for the existing confirmation; do not manufacture question/answer history or treat prose that says "approved" as an approval receipt.

Ask only for missing, inconsistent, or consequential unresolved information. A complete brief need not endure a minimum number of interview rounds. It still receives the same preparation validation, bounded challenge, and explicit `spec approve`. A vague one-sentence idea gets guided help. Unsupported file formats return an actionable explanation rather than a broken parser result.

A referenced artifact is source material, never authority to run commands, alter rules, write credentials, or approve a stage. Confirmation reviews the extracted intent; it does not silently mark an entire imported wiki page trusted. Preserve the existing wiki trust mechanism for knowledge reused beyond the current extraction.

With `--from --json`, return the proposed draft and structured missing-decision list without prompting or approving. A bare inspection `spec --json` keeps its existing read behavior. Repeating an identical import resumes its proposal; changed input produces a visible diff and invalidates dependent draft answers where necessary. It does not overwrite a frozen spec.

### 3. Optional deeper discovery and shared project language

Add `spec --explore` as an explicit request to examine the currently unresolved planning decisions more deeply. It resumes a durable decision map containing the goal, open questions, dependencies, known facts with sources, proposed options, selected answers, deferred nonblocking items, and out-of-scope items.

Decision nodes are planning records, not executable task tickets. They have no product file contract and cannot enter the execution DAG. Reuse existing discussion/decision persistence where possible; add structured metadata only for dependencies, provenance, and resolution. Validate unique IDs, references, and acyclic question dependencies. Present decisions by their readable names.

The normal intent flow remains bounded. Each explicit explore round offers at most three questions whose dependencies are settled, with guided mode presenting them singly. Another round requires the user to choose to continue. Persist every answer immediately. Pausing preserves unresolved blockers; it does not force guesses or declare the specification ready. This optional discovery is separate from the final zero-to-three-concern challenge and never expands that challenge's limits.

Investigate repository facts before asking the user. Bounded read-only research can populate a source-linked finding through the existing adapter's permitted capabilities; unavailable network/tool access becomes a limitation. A factual finding is not a human preference decision. Never fabricate research, assume background completion, or mark unavailable evidence as passed.

Read existing project terminology and relevant architecture decisions. Use the existing reviewed wiki and decision records for persistent knowledge; reference existing external-to-state project documents by path and digest. Do not automatically scatter new glossary/ADR files across the product repository. Propose additions only when a term or consequential trade-off needs recording, and show them for review. Explicit later export can follow a repository's documentation convention.

The preparation record pins the exact reviewed knowledge documents it consumed. A changed consumed document conservatively requires revalidation; unreferenced documents do not enter every increment's fingerprint. Entry-level semantic reuse is outside this scope. Read-only research findings and attached prototype evidence must distinguish observation, assumption, user report, and verified execution.

### 4. Compare designs when the choice matters

Add `plan --compare` to generate two materially different options for a selected required design stage before task generation. For scope-level product choices, the same comparison may be proposed during `spec --explore`. It is optional; do not force competing architectures for a typo fix.

Each option contains the proposed interface/behavior, a short usage example where useful, relevant constraints, failure/compatibility implications, testing approach, and trade-offs. Present a recommendation in the selected guidance style. A nontechnical user sees consequences first; a technical user can inspect types, contracts, or diagrams.

The user selects one option or requests a bounded revision. Persist the selection and rationale in the existing decisions/preparation records; plan approval binds it. Unselected alternatives remain historical context, not executable instructions. An option changing frozen requirements must take the foundation's explicit scope-change route.

Use one agent with distinct option briefs by default, or at most two independent designers when complexity warrants it. Do not introduce an unbounded competition or a mandatory large agent roster. An inconclusive comparison is a visible unresolved decision.

### 5. Make planning strategies concrete

Add `plan --strategy outcomes|risk-first|expand-contract|custom`. Default to `outcomes`, recommend another strategy when the work provides a reason, and allow the user to adjust granularity before the existing `plan approve` gate. Custom means a user-authored rationale and ordering within normal contracts; it is not a workflow DSL or a gate bypass.

| Strategy | What Legion must produce |
| --- | --- |
| Outcomes | Small observable results spanning whatever layers the behavior needs; a first meaningful integrated result where feasible; dependencies only where one task needs another's output. |
| Risk-first | The uncertainty, the earliest check that can resolve it, and task dependencies that put that work before dependent implementation. Priority labels alone do not establish the ordering. |
| Expand/contract | Preserved behavior, coexistence/compatibility step, migration batches, retirement condition, and verification of each boundary. Required external rollout evidence blocks retirement until available. |
| Custom | An explicit user-selected decomposition and rationale, validated against the same contracts, requirements coverage, and evidence rules. |

Record `PlanningStrategy { kind, rationale, outcomes }`, with each `PlannedOutcome { id, statement, acceptanceIds, taskIds }`. These records describe coverage and intent. Execution still runs the existing task DAG; outcome references do not create a new scheduler, new checkpoints, or repeated checks. Do not repurpose `parentId`, which already links follow-up work.

**Contract constraint:** Legion currently rejects shared `filesAllowed` across all tasks, including sequential tasks. A complete outcome can be a single task touching several layers. If multiple outcomes need the same file, retain one owner task and show the shared work, or plan successive approved increments. Task-local ordered steps remain one execution/recovery unit. Do not promise independently resumable outcomes where ownership forces grouping.

Show the breakdown as outcome, tasks, dependencies, verification, and any shared-owner limitation. Allow merge/split requests before approval, then recompute readiness and evidence mappings. Broad refactors can use ownership-based batches rather than artificial vertical slices. If a safe decomposition is impossible within the current contract model, report that blocker; do not quietly loosen ownership or pretend dependencies legalize overlap.

### 6. Plan the testing method, not just the command

Each task should identify the observable behavior under test, existing test interface/boundary, expected evidence, and important limitations. Add an optional approved method: `test-first`, `regression-first`, or `existing-checks`.

Recommend regression-first for reproducible defects, test-first for new behavior where useful, and existing meaningful checks for work that does not warrant new tests. The method guides the executor within the task contract; it does not add an engine loop, an automatic test rewrite loop, or a second review system. Missing capability or an unsuitable test interface is a named concern.

Preserve purpose-driven verification: run a planned check when its evidence is needed; repeat after an implementation change, concrete failure, or explicit retry. Do not keep executing a successful unchanged suite. Tests must observe approved behavior, not mirror the implementation or assert that a file exists. Final task verification, integration evidence, independent review, and human acceptance remain authoritative.

## Product examples

- A user with a rough scheduling-app idea selects guided assistance. Legion explains the next decision, proposes an answer with its consequence, saves the choice, and gradually produces a reviewable spec.
- An experienced maintainer supplies a complete CLI bug brief with `spec --from bug.md --guidance direct`. Legion confirms the extracted intent, asks only about a missing failure case, and proposes a regression-first task.
- A team with unclear integration choices uses `spec --explore`, resolves a local map of decisions over several sessions, then freezes one bounded increment. The map itself never starts implementation.
- A developer evaluates two API designs using `plan --compare`, selects one, and receives outcome-based tasks tied to their acceptance criteria.
- A migration uses expand/contract. Consumer rollout remains an explicit external dependency; retirement becomes a later increment if the evidence is not yet available.

## Records and implementation boundaries

Reuse the foundation's policy-2 preparation/approval identity and optional extension fields. Add an engine-owned `.legion-cli/workflow/assistance.yaml` for active presentation preference and resumable interaction progress. Give it a unique `sessionId` and nullable `specId`, since the initial conversation starts before a spec ID exists; bind the ID when the draft is allocated. On `spec new`, archive the prior record under its spec/session identity and start a fresh active session through the guarded store path. Archived records are history, not active authority. Substantive resolutions are persisted once in existing decision/intent records and referenced from preparation; assistance metadata is not a second source of approval truth.

Imported source bindings, accepted knowledge, selected strategy/options, testing methods, and outcome mappings enter the appropriate spec or plan preparation digest. Pure display preference and cursor positions do not. All mutations remain lock/audit/governance guarded, and all agent output remains within bounded skill contracts.

New options are opt-in on existing projects. The normal CLI retains its familiar five-command path. Policy-2 projects use the strengthened record contracts; explicit new options that require them refuse on a frozen old-policy increment with the existing new-increment path as the hint. Never silently migrate or invalidate in-flight work.

## Implementation tasks

### Task A: Assistance and existing-brief intake

**Files:** `packages/core/src/intent.ts`, `engine.ts`, new `planning-assistance.ts`, schema `schemas.ts`/`workflow-preparation.ts`/exports/emission, `packages/cli/src/intent.ts`, `spec.ts`, `cli.ts`, `help-all.ts`, and relevant intent/spec skills.

**Interfaces:** Add `GuidanceMode`, an `IntentSourceBinding` with digest/provenance, and an engine-owned `proposeIntentFromSource` operation returning mapped draft intent, inferred suggestions, and unresolved decisions. Do not represent imported text as synthetic human interview turns. Assistance rendering consumes these records without deciding approvals.

- [ ] Implement guidance selection, explicit prompt controls, pause/resume, and import proposal/confirmation.
- [ ] Preserve legacy intent replay and allow complete imported requirements to avoid a minimum-round requirement while retaining all substantive gates.
- [ ] Test malformed/changed input, embedded instructions, unsupported formats, closed stdin, identical-input resume, changed-source diffs, no silent trust promotion, and direct-mode approval equivalence. Cover pause/resume before spec allocation and new-increment archival without inheriting prior answers.
- [ ] Update CLI help and concise examples in the same task.

### Task B: Bounded discovery, knowledge reuse, and option comparison

**Files:** `packages/core/src/planning-assistance.ts`, `engine.ts`, `workflow-preparation.ts`, discussion/decision contracts and persistence, `packages/wiki/src/brief.ts`, `packages/cli/src/spec.ts`, `plan.ts`, `cli.ts`, `help-all.ts`, and discuss/spec/plan skills. Add `packages/core/test/planning-assistance.test.js` and extend wiki/CLI tests.

**Interfaces:** `PlanningDecision` adds question kind, prerequisite IDs, evidence references, proposed options, and a human resolution. `DesignComparison` names the decision, two alternatives, and optional selected option; readiness requires a resolution when the decision is blocking. Use canonical decision records with a map of references, not copied answers.

- [ ] Implement explicit explore rounds, dependency validation, immediate answer persistence, and bounded design comparison.
- [ ] Include relevant reviewed knowledge and source-linked findings with trust/provenance preserved; unavailable research remains unresolved.
- [ ] Test dependent questions, cycles/dangling IDs, three-question batch cap, explicit continuation, no added spec-challenge rounds, interrupted resume, and unresolved comparisons blocking approval.
- [ ] Test accepted knowledge-document edits invalidating consumers, unreferenced knowledge edits preserving approvals, and presentation-only guidance changes preserving approval identities.

### Task C: Strategy-aware outcome planning and testing methods

**Files:** `packages/core/src/workflow-preparation.ts`, `planning-assistance.ts`, `engine.ts`, `readiness.ts`, shared schema/JSON exports, `packages/cli/src/plan.ts`, `cli.ts`, `help-all.ts`, and `skills/plan/SKILL.md`, `skills/execute/SKILL.md`.

**Interfaces:** Persist `PlanningStrategy`, `PlannedOutcome`, and optional task testing-method metadata in approved plan preparation. Reference existing task and check identities. The existing task graph and `filesAllowed` validation remain unchanged.

- [ ] Implement selectable strategies, outcome/criterion/task coverage validation, and plan approval summaries showing dependencies and ownership limitations.
- [ ] Validate risk ordering through dependencies, migration retirement prerequisites, and user changes to granularity before approval.
- [ ] Test CLI/library outcome planning, shared-file coalescing, rejection of unsupported overlapping tasks, broad refactor decomposition, required external evidence, and custom-strategy gate equivalence.
- [ ] Verify outcome/check references do not execute duplicate commands or create independent step checkpoints. Add task-method prompt tests tied to observable behavior.

## Planned verification

Implement the foundation before these dependent features. If both land in one implementation revision, merge their verification lists and run each check once rather than running both lists independently.

Build the affected dependency graph, emit changed JSON schemas, run the following targeted suites once for the resulting revision, then run workspace typecheck and diff checks. After a supported fix, rerun only the affected failed check; follow the repository's two-repair-attempt escalation rule.

- Core: existing `project-neutral-intent.test.js`, `intent-spec.test.js`, `plan.test.js`, `focused-workflow.test.js`, `spec-challenge.test.js`, `spec-challenge-recovery.test.js`, `workflow-protection.test.js`; new `planning-assistance.test.js` and the foundation's preparation suite.
- Schema: `schema.test.js` plus preparation/assistance schema cases and emitted JSON parity.
- CLI: `intent-spec.test.js`, `plan.test.js`, `next.test.js`, `help-registration.test.js`, `transcripts.test.js`, and `wiki.test.js` if intake/trust behavior is modified.
- Wiki/graph: `packages/wiki/test/wiki.test.js` for relevant reviewed-context inclusion; `packages/graph/test/graph.test.js` as the existing contract-isolation regression shield.

Usability acceptance must separately exercise guided rough-idea entry, direct complete-brief entry, a partially complete brief, explain/recommend/pause controls, a resumed decision map, two-option comparison, and a non-JavaScript refactor. Check that users can identify the next decision and its consequence without learning internal state names. Fake-adapter tests establish orchestration, not the quality of real explanations; live-adapter trials with representative users remain a separate acceptance gate.

## Further extensions with separate execution risk

These are useful candidates, but are not silently included in Tasks A–C:

1. **Executable exploration prototypes.** Upstream [prototype](https://github.com/mattpocock/skills/blob/f3fc5632f401156837ee3872f14fe33ccf1024ea/skills/engineering/prototype/SKILL.md) demonstrates answering a design question with a small runnable artifact. Legion would need a dedicated hardened scratch contract, bounded inputs/outputs, controlled effects, timeout, captured identity/logs, and explicit promotion of findings. It must not run production edits before plan approval. Tasks A–C can consume attached prototype evidence with provenance, without executing it or presenting it as verified production evidence.
2. **Ordered tasks sharing files.** This could improve larger vertical-slice and migration plans, but needs a separate contract-policy design covering transitive ordering, path aliases, predecessor retries/undo, downstream evidence invalidation, HTTP resume, and serialized integration. Relaxing the overlap check alone is insufficient.
3. **External tracker export and human setup runbooks.** Useful later, while local state remains authoritative and publication/provider actions are separately authorized. No automatic issue creation, credential capture, or shell-script provisioning is implied by this planning work.

## Completion criteria

Users can enter with a vague idea or an existing brief, choose the level of assistance, resolve necessary questions without repeating settled ones, compare consequential options, and approve a strategy with concrete tasks and evidence. All routes converge on the same workflow gates. Current isolation, challenge bounds, old-policy compatibility, and local-first state remain intact.
