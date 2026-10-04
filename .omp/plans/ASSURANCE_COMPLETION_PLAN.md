# Assurance integration completion

## Context
Complete the approved five-enhancement assurance plan (`local://assurance-integration-plan.md`, the authoritative design contract) in the Legion CLI repo at `D:/legion-cli`. Most of it is already implemented, but uncommitted. A six-way audit found these remaining gaps:

- **Governance modelling.** The Quint model is a narrow two-task abstraction. Engine frames are only chain-checked, never checked against the semantic rules. There is no cross-epoch anchor, and `context trace` is missing. Any refused precondition in an adopted project poisons the epoch.
- **Information flow.** Two label defects remain, and component checks are refused in `information-flow` mode.
- **Platforms and release.** There is no seven-target native release pipeline, and the sandbox barrel loads the component host eagerly.
- **Status surfaces.** Dashboard and MCP have no assurance projections.
- **Delivery.** Three gaps remain: there is no exact-predicate consent binding, CI attestation output is not composed back into the bundle, and the receipt field names differ from the plan.
- **Evidence.** There is no integrated installed smoke (`scripts/assurance-smoke.mjs`), and no CI, macOS, Linux, or public attestation evidence.

**End state:** every gap is implemented and proven by local runs. The work is committed on a pushed `assurance-integration` branch with a draft PR whose full CI matrix is green. One authorized public demo attestation is verified offline. Promotion to default behavior is not part of this work; it remains a separate explicit release decision.

## Approach

### 0. Branch and hygiene
- From the current `HEAD`, create local branch `assurance-integration`. It carries the 9 unpushed autoresearch commits plus the working tree. Do not commit yet; Step 15 commits.
- Delete root `_apalache-out/`, a local Apalache server artifact. Append `_apalache-out/` to `.gitignore`.
- Append `*.wasm binary` to `.gitattributes`, because `extensions/json-contract/assets/json-contract.wasm` is committed and hash-pinned by its `SKILL.md`.
- When you run Apalache locally later, start it with its working directory set to a temp directory, never the repo:
  `java -Xmx4096m -jar C:/Users/dasbl/.quint/apalache-dist-0.62.1/apalache/lib/apalache.jar server --port=8822`

### 1. Lazy component subsystem loading
- In `packages/sandbox/src/index.ts`, replace line 41 (`export { resolveComponentRuntime, runComponentValidator, snapshotComponentFiles } from "./component.js"`) with three exported async wrappers. Each one does a memoized `await import("./component.js")` and forwards its arguments.
  - Keep the identical public names and signatures, typed via `typeof import("./component.js")`.
  - The type-only re-exports on lines 42–43 stay.
- No other caller changes are needed. `packages/core/src/assurance.ts` and `packages/agents` import these through the barrel.

### 2. Information-flow corrections
1. **Unexplained source bytes become sealed, not refused.**
   - In `packages/core/src/assurance-flow-host.ts`, `readSource` (around line 1334) currently throws `stale-authority` when the digest matches neither the baseline nor generated provenance. Replace that throw with:
     `label = joinLabels([label, { origins: [namespacedOrigin("file", { sourceId: "unexplained-change", path })], integrity: "untrusted", confidentiality: "sealed" }])`
   - Extract the label derivation into an exported helper in `packages/core/src/assurance-flow-labels.ts`. It covers the policy-source lookup, the baseline match, the generated-provenance join, and the new unexplained case:
     `export function labelProductBytes(input: { policySources: readonly { id: string; path: string; classification: "public"|"workspace"|"sealed" }[]; baselineSources: readonly { path: string; sha256: string }[]; generated: { sha256: string; label: ProvenanceLabel } | undefined; path: string; digest: string }): ProvenanceLabel`
   - Call this helper from `readSource`. Step 2.4 calls it too.
   - A path missing from `policySources` is labeled sealed/untrusted with origin `namespacedOrigin("file", { sourceId: "unclassified", path })`. Keep the existing `policy-denied` for paths outside the task's `readPaths`.
   - Update the existing source-change rejection case in `packages/core/test/assurance-flow.test.js`. It must now assert:
     - a sealed, untrusted label that includes the `unexplained-change` origin;
     - that a provider sink permitting only `workspace` refuses that value;
     - that after `plan approve` (a new baseline) the same bytes read as their policy classification.
2. **Argv verification labels include unclassified readable bytes.**
   - In `packages/core/src/assurance-flow.ts`, `verificationLabel` (lines 304–318) builds origins only from `plan.security.sources`. Add one aggregate origin, `namespacedOrigin("file", { sourceId: "unclassified-readable", path: "." })`, for every product path the sandbox can read that is not a declared source. Confidentiality stays `sealed` and integrity stays `untrusted`.
   - Do not enumerate the product tree into the label.
   - Extend the existing label test in `assurance-flow.test.js` to assert that the aggregate origin is present.
3. **Governed checkpoint path reporting.** In `packages/http/src/governed.ts` (around lines 106–111), the result path reports `checkpoint.json`. Change it to the persisted file name, `http-governed-checkpoint.json`. That is the name of `.legion-cli/audit/http-governed/<sha256-run>/http-governed-checkpoint.json` in `assurance-flow-host.ts:53-55`.
4. **Component checks run in `information-flow` mode.**
   - Delete the refusal at `packages/core/src/assurance.ts:486`.
   - In `runAssuranceChecks`, when `plan.security.mode === "information-flow"`:
     - for every prepared input, compute `labelProductBytes(...)` using the approval's `baselineSources` and the current `.legion-cli/workflow/file-provenance.yaml`;
     - join them with `joinLabels`;
     - store the joined label on the receipt.
   - Add an optional `observationLabel: ProvenanceLabelSchema` to `CheckEvidenceSchema` in `packages/schema/src/assurance.ts`, then rebuild and emit the schema. `runAssuranceChecks` sets the label if and only if the mode is `information-flow`. `inspectAssuranceEvidence` treats an information-flow receipt that lacks the label as `unavailable` with reason `component receipt lacks its information-flow label`.
   - `observationLabel` is not part of the reuse key.
   - In `inspectAssuranceEvidence` and the CLI `plan evidence`/`status` renderers, omit observation `detail` text whenever `observationLabel.confidentiality !== "public"`. IDs, statuses, and codes remain visible.
   - The policy status is currently hard-coded to `blocked` for `information-flow`, at `assurance.ts:495` (`runAssuranceChecks`) and `:658` (`inspectAssuranceEvidence`). As a result, an information-flow execution can never reach `status: "passed"`. Fix this as follows:
     - Add a required parameter `informationFlowPosture: "not-enforced" | "pending" | "partial" | "enforced"` to both functions.
     - Derive the policy status from it: `adapter-default` → `not-enforced`; `information-flow` with posture `enforced` → `enforced`; otherwise → `blocked`.
     - The engine passes `#informationFlowPosture(...)` at both call sites. Find them with `grep -n "runAssuranceChecks(\|inspectAssuranceEvidence(" packages/core/src/engine.ts`. For `adapter-default`, pass `"not-enforced"`.
     - Leave line 593 (`state.status ? "blocked"`, the invalid-adoption path) unchanged.
   - Add a test in `packages/core/test/assurance-checks.test.js`, using the native-host-gated fixture pattern already in that file: an information-flow manifest with one JSON-contract validator executes the component stage, persists `observationLabel`, and reuses on an unrelated edit.

### 3. Component retry acceptance test
Add one test to `packages/core/test/assurance-checks.test.js` with three validators, v1 passing and v2/v3 checking separate assertions. Make v2's input fail. Then assert:
1. `executeWorkflow()` blocks at v2 and leaves v3 unexecuted (no receipt).
2. `executeWorkflow()` without retry is still blocked, with no new v2 `executionId`.
3. `executeWorkflow({ retry: true })` with v2's input unchanged:
   - v1 has decision `reused` with `reusedFrom` set;
   - v2 has a new `executionId` and is still failed;
   - v3 is still not executed.
4. After fixing v2's input, `executeWorkflow()` runs v2 fresh and v3 fresh.

Production code changes only if the test exposes divergence from these semantics. Those semantics come from the approved plan: retry reruns the first failed component stage, reuses eligible successes, and stops on another failure.

### 4. Governance runtime semantics (schema, persist, engine)
1. **Shared overlap predicate.**
   - Move the body of `overlappingFilesAllowed` (`packages/graph/src/contract.ts:80-108`) into `packages/schema/src/governance.ts` as:
     `export function overlappingWritePaths(entries: readonly { id: string; paths: readonly string[] }[]): string[]`
     It returns the same messages and uses `normalizePathKey` from schema.
   - Rewrite `overlappingFilesAllowed` to call it via `tasks.map((t) => ({ id: t.id, paths: t.contract.filesAllowed }))`.
   - The graph tests at `packages/graph/test/graph.test.js:79-292` must pass unchanged.
2. **`refused` outcome.**
   - In `packages/schema/src/governance-records.ts`, add `"refused"` to the frame `outcome` enum.
   - Add to `governance.ts`:
     `export function governanceOutcomeBlocks(outcome: GovernanceFrame["outcome"]): boolean { return outcome === "failed" || outcome === "incomplete"; }`
   - In `#appendGovernanceBoundary` (`packages/core/src/engine.ts:7229-7238`), when the operation throws `LegionRefuseError` and `canonicalJson(after) === canonicalJson(begin.before)`, append the end frame with outcome `"refused"`. Otherwise keep `"failed"`.
   - Replace every `frame.outcome !== "success"` blocking check with `governanceOutcomeBlocks(frame.outcome)` in `engine.ts` around lines 7032, 7049, 7210, and 7406. Find them with `grep 'outcome !== "success"' packages/core/src/engine.ts`. The `ship-complete` success checks at 4543 and 4682 stay exact.
   - Update the test at `packages/core/test/assurance-adoption.test.js:475-492`. It must now assert:
     - the refused amend records `outcome: "refused"`;
     - a following valid `amendTask` succeeds;
     - `ship({ confirm })` refuses for its real gate reason, not `/failed operation/`.
   - The poisoning behavior of a genuine post-mutation failure is covered in Step 6.
3. **Vacuous integration pass.** In `#governanceProjection` (`engine.ts:7091-7097`), when the receipt is current, `integrationCount === 0`, and `receipt.status !== "running"`, project `integration: "passed"`.
4. **Explicit retry marker on frames.**
   - Add a required `explicitRetry: z.boolean()` to `GovernanceFrameSchema`. The schema is unreleased, so keep the version literal.
   - Add `explicitRetry?: boolean` (default `false`) to `GovernanceBeginInput`/`GovernanceEndInput` in `packages/persist/src/governance-trace.ts`.
   - Give `#governanceMutation(action, operation, options?: { explicitRetry?: boolean })` a third parameter, threaded to `#appendGovernanceBoundary` and both frames.
   - Pass `{ explicitRetry: true }` at every `integration-start`/`review-start` (and component-stage) boundary reached with `opts.retry === true`. Find them with `grep '#governanceMutation("(integration-start|review-start)"' packages/core/src/engine.ts`.
5. **Semantic trace validator.** Add to `packages/schema/src/governance.ts`:
   ```ts
   export type GovernanceViolationCode =
     | "advisory-execution" | "duplicate-claim" | "overlapping-active-writes" | "completion-without-checks"
     | "stale-authority-use" | "implicit-retry" | "preview-mismatch" | "rollback-claims-delivery"
     | "illegal-phase-transition" | "illegal-task-transition" | "refused-changed-state";
   export type GovernanceViolation = { sequence: number; code: GovernanceViolationCode; detail: string };
   export function validateGovernanceFrames(frames: readonly GovernanceFrame[]): GovernanceViolation[];
   ```
   Pair each end frame with its begin by `correlationId`. Define "active" as status `in_progress|verifying`. Apply these rules:
   - **advisory-execution:** any end `after` with `controlMode === "advisory"` and an active task; or a `task-start` end `success` whose begin `before.controlMode === "advisory"`.
   - **duplicate-claim:** a `claim-acquire` end `success` where `before.claim.liveness === "live"` and `after.claim.owner !== before.claim.owner`.
   - **overlapping-active-writes:** `overlappingWritePaths` over the active tasks in any end `after` is non-empty.
   - **completion-without-checks:** either
     - a `task-complete` success where some task becomes `done` from a `before` status other than `verifying`; or
     - any success end whose `after.phase === "shipped"` while the begin's `before.integration !== "passed"`, or some `before.components[].status !== "passed"`, or `before.review !== "passed"`.
   - **stale-authority-use:** either
     - a success end of `task-start|integration-start|review-start|acceptance-record|ship-prepare|ship-confirm|ship-complete` whose begin `before.approval.freshness !== "current"`; or
     - an `acceptance-record` success whose begin `before.integration !== "passed"` or `before.review !== "passed"`; or
     - a `ship-complete`/`ship-confirm` success reaching `shipped` with any `before.acceptance` entry that is `failed|not-recorded` or not `current`.
   - **implicit-retry:** a success or failed end of `integration-start` where `before.integration === "failed"` or any `before.components[].status === "failed"`, or of `review-start` where `before.review === "failed"`, and `explicitRetry === false`.
   - **preview-mismatch:** track the last `ship-prepare` success `after.ship`. Each `ship-confirm`/`ship-complete` success must have `after.ship.confirmed === true` (confirm only), and the same `confirmationId` and `previewFingerprint` as the tracked prepare. A confirm or complete with no tracked prepare is also a violation. `ship-complete` frames recorded without confirmation (legacy unconfirmed paths) are exempt only when the trace has no `ship-prepare`.
   - **rollback-claims-delivery:** a `ship-rollback` success with `after.ship.status === "complete"` or `after.phase === "shipped"`.
   - **illegal-phase-transition:** a success end whose phase changed and neither `canTransition(before, after)` holds nor (`action === "undo"` and `UNDO_ONLY_PHASE_TRANSITIONS` allows it).
   - **illegal-task-transition:** for each task present in both projections whose status changed, neither `canTransitionTaskStatus` holds nor (`action === "undo"` and `statusAfterUndoDependency(from) === to`).
   - **refused-changed-state:** a `refused` end whose `after` is not canonically equal to its begin's `before`.

   Export these from the schema barrel. Do not duplicate them in core.
6. **Persist applies the validator.**
   - In `packages/persist/src/governance-trace.ts`, after chain validation in `readSegment`, run `validateGovernanceFrames`. Any violation makes the envelope `status: "invalid"`.
   - Add and export from the persist barrel:
     `export async function inspectGovernanceTrace(store, approvalId, modelDigest): Promise<{ trace: GovernanceTrace; violations: GovernanceViolation[] }>`
   - Have `readGovernanceTrace` delegate to it.
   - `reconcileGovernanceTrace` must also return `invalid` on violations.
   - Add persist tests in `packages/persist/test/governance-trace.test.js`. Write chains through the real writer, then corrupt them semantically: insert an active advisory task, an overlap, a stale `acceptance-record`, an implicit retry, a preview change, a rollback with complete, and a refused frame with changed state. Each must report `invalid` with the exact code.
7. **Ship-confirm projection ordering.**
   - In `engine.ship` (`engine.ts:4500-4502`), delete the pre-boundary assignment `this.#shipProjection = { ...this.#shipProjection, confirmed: true }`.
   - Make the first statement inside the `ship-confirm` operation callback set `confirmed: true`, so the begin `before` records `false` and the end `after` records `true`.
   - In the existing `.catch` path, reset `confirmed` to `false` before appending abort records.

### 5. Cross-epoch anchor and startup validation
1. **Schema.** In `governance-records.ts`, add:
   ```ts
   GovernanceEpochsSchema = boundedRecord(z.strictObject({
     schemaVersion: z.literal(SCHEMA_VERSION.governanceEpochs),
     epochs: z.array(z.strictObject({
       sequence: z.number().int().nonnegative(),
       approvalId: OpaqueIdSchema.nullable(),
       adopted: z.boolean(),
       recordedAt: UtcTimestampSchema,
       previousDigest: AssuranceSha256Schema.nullable(),
       digest: AssuranceSha256Schema,
     })).min(1).max(10_000),
   }), 4 * 1024 * 1024)
   ```
   - Add `governanceEpochs: "legion-cli-governance-epochs/v1"` to `SCHEMA_VERSION` (`packages/schema/src/versions.ts`).
   - Register it in `json-schema.ts`, export it, and run the schema build plus `emit`.
   - Compute each digest as `sha256("legion-cli-governance-epoch/v1\n" + canonicalJson(entryWithoutDigest))`.
2. **Persist.** In `governance-trace.ts`, add and export:
   - `readGovernanceEpochs(store): Promise<GovernanceEpochs | null>`. It does a strict parse and verifies sequence, chain, and digests. Malformed input throws `GovernanceEpochError`.
   - `appendGovernanceEpoch(store, { approvalId, adopted, recordedAt }, lock)`. It does an atomic rewrite of `.legion-cli/audit/governance/epochs.json` using the same `atomicWriteFile` as `writeHead`, with lock-ownership assertion.
3. **Engine writes.** Inside the approval mutation, append the epoch record before `#governanceMutationForApproval` writes its begin frame:
   - `{ approvalId: newApprovalId, adopted: true }` when adopting or preserving adoption;
   - `{ approvalId: newApprovalId, adopted: false }` for a non-adopted approval only when `epochs.json` already exists.

   Legacy projects that never adopted never create the file.
4. **Startup guard.**
   - In `#withLockOrRefuse` (`engine.ts:8308-8345`), immediately after `this.store.reconcileUnfinished()` and before `#recoverDeadInProgressLocked()`, call a new `#assertGovernanceEpochCurrentLocked(opts)`. Run it for writer entries only (`!opts?.allowLive`).
     - **Epochs file absent:** refuse `"adopted governance epoch anchor is missing"` (hint `legion-cli plan approve`) if `loadAssurance` shows an adopted approval; otherwise return.
     - **Epochs file present:** take the latest entry `L`. The current identity is `(loadAssurance().approval?.approvalId ?? readPlanApproval()?.approvalId ?? null, adopted)`. If `L.approvalId`/`L.adopted` differ, refuse with `"governance epoch ${L.approvalId} was interrupted; review and approve the current plan"` (hint `legion-cli plan approve`).
   - Add `allowInterruptedEpoch?: boolean` to `LockEntryOptions`. Only `approvePlan`'s lock entry passes `true`.
   - Contingency: if the full core suite shows a legitimate public operation that rewrites or removes the approval receipt and therefore trips this guard, make that operation append the matching epoch record in its own lock section. Never weaken the guard. Find such operations with `grep -n "invalidateAssuranceApproval\|writeAssuranceApproval\|writePlanApproval" packages/core/src`.
5. **Test.** Add to `assurance-adoption.test.js`:
   - adopt, then reapprove;
   - delete the new approval sidecar and restore the old sidecar bytes, which simulates journal restore after an interrupted reapproval;
   - assert `amendTask` refuses with the interrupted-epoch message;
   - assert `approvePlan` succeeds and opens a third epoch;
   - assert both earlier segments are preserved.

### 6. Governance fault injection
1. Add a test-only seam, `fakeGovernanceFault?: (point: GovernanceFaultPoint) => Promise<void>`, to `LegionEngineOptions` (`packages/core/src/types.ts:40-75`). Define `GovernanceFaultPoint = "after-begin-frame" | "after-begin-head" | "after-mutation" | "after-end-frame" | "after-end-head"`.
2. Add an optional `faults?: { afterFrame?: () => Promise<void>; afterHead?: () => Promise<void> }` parameter to `appendGovernanceBegin`/`appendGovernanceEnd`. The engine's `#appendGovernanceBoundary` passes the seam. `after-mutation` runs between `operation()` and the end frame.
3. Add `packages/core/test/fixtures/governance-fault-child.mjs`. It takes argv `<projectRoot> <point>`, builds an engine from `../../dist/index.js` whose seam calls `process.kill(process.pid, "SIGKILL")` at the requested point, and runs `amendTask` on `TSK-0001`.
4. Add `packages/core/test/governance-faults.test.js`, with one test per point. Each test:
   - seeds an adopted project with the existing fixture helpers from `assurance-adoption.test.js`;
   - spawns the child, which is killed at the point;
   - opens a fresh engine and asserts the outcome below.

   | Point | Required outcome |
   | --- | --- |
   | `after-begin-frame` / `after-begin-head` | Task file unchanged; trace `incomplete`; mutation refuses until `approvePlan`; old segment stays `incomplete` after reapproval. |
   | `after-mutation` | Journal recovery restores pre-image or keeps the mutation per existing journal semantics; either way the trace is `incomplete` and refuses until reapproval. |
   | `after-end-frame` | Exactly one valid orphan beyond a stale head is reconciled to `valid`, and the next mutation succeeds. |
   | `after-end-head` | `valid`. |

   Add a further in-process test: an `after-mutation` seam that throws an `Error` (not a refusal) records outcome `failed`, and later mutations refuse with `/failed operation/`.
5. Extend `packages/core/test/ship.test.js` with an adopted ship using `prCreate: () => ({ error: "pr failure" })`. Assert:
   - the snapshot is `aborted`;
   - the trace contains a `ship-rollback` success frame and validates with no violations;
   - `exportDeliverySnapshot` refuses.

### 7. `context trace` commands
1. **Core.**
   - Add `async inspectGovernance(): Promise<GovernanceInspection>` to `LegionEngine`. It is read-only and must never reconcile or write.
   - Export from `packages/core/src/types.ts`:
     ```ts
     export type GovernanceInspection = {
       current: { approvalId: string | null; adopted: boolean; status: "valid" | "incomplete" | "invalid" | "not-adopted" | "interrupted-epoch" };
       epochs: Array<{ sequence: number; approvalId: string | null; adopted: boolean; recordedAt: string;
         status: "valid" | "incomplete" | "invalid" | "not-adopted"; frames: number; headDigest: string | null;
         lastAction: GovernanceAction | null; lastOutcome: GovernanceFrame["outcome"] | null; violations: GovernanceViolation[] }>;
     };
     ```
   - Read epochs via `readGovernanceEpochs` and each adopted epoch via `inspectGovernanceTrace` with `#governanceModelDigest(config)`.
   - `current.status` is `interrupted-epoch` under the Step 5 mismatch condition.
2. **CLI.** In `packages/cli/src/context.ts`, add `runContextTrace(opts)` and `runContextTraceValidate(opts)`:
   - **`context trace` text:** one line per epoch, plus the current status and one next command (`legion-cli plan approve` when the status is not `valid|not-adopted`, else `legion-cli status`).
   - **`context trace` `--json`:** prints the inspection object.
   - **`context trace validate`:** prints each epoch's status and violations. It exits 0 iff `current.status` is `valid` or `not-adopted`, otherwise 1. `--json` prints `{ ok, current, epochs }`.
3. **Registration.**
   - In `packages/cli/src/cli.ts:960-967`, register `context trace` (action) with a nested `validate` subcommand. Both use `addGlobalOptions` and `allowExcessArguments(false)`.
   - Update the `requireSub("context", ...)` hint so it lists `compact` and `trace`.
   - Add rows `context trace [--json]` and `context trace validate [--json]` to `packages/cli/src/help-all.ts`. `packages/cli/test/help-registration.test.js` enforces parity.
4. **Test.** Add a CLI test in `packages/cli/test/` that adopts a project, runs `context trace validate --json`, and expects exit 0 and `valid`. Then delete one frame and expect exit 1 and `invalid`.

### 8. Boundary model and validator conformance
1. Create `models/governance-boundaries.qnt`, module `governance_boundaries`. Its state is the abstract projection:
   - `phase ∈ {plan_ready, executing, ready_to_ship, shipped}`, `controlMode ∈ {guarded, advisory}`;
   - `Tasks = {0,1,2}` with fixed writes T0 `src/model`, T1 `src/other.ts`, T2 `src/model/child.ts` (T0/T2 overlap by directory);
   - `taskStatus`, `taskOwner ∈ {none, w1, w2}`;
   - `approvalId ∈ {1,2}`, `approvalFresh`;
   - `claimOwner ∈ {none, c1, c2}`, `claimLive`;
   - `integration`/`review` ∈ {not-run, running, passed, failed, stale}; one component `c0` with the same domain;
   - acceptance `a0 ∈ {not-recorded, passed, failed}` with freshness;
   - ship status, `preview ∈ {none, p1, p2}`, `confirmed`, `preparedPreview`;
   - a nondet `explicitRetry` per step.

   Define one action per governance vocabulary verb, with guards exactly equal to the Step 4.5 rules. Each action also records `mbt::actionTaken`. `Safety` conjoins the Step 4.5 state invariants: no active task under advisory, no overlapping active writes, shipped implies passed checks and current passed acceptance, and rollback never complete.
2. Add `scripts/check-governance-boundaries.mjs`, usage:
   `--directory <itf-dir> --expected-traces <n>`
   - Decode each ITF state, using the same strict decoding approach as `scripts/replay-governance-itf.mjs:96-181`.
   - Map it to schema-valid `GovernanceProjection` objects. Abstract IDs map to fixed opaque IDs; previews map to fixed SHA-256 constants. Emit begin/end frame pairs with `explicitRetry` and a valid hash chain built with persist's `canonicalJson`.
   - Assert `validateGovernanceFrames` returns `[]` for every trace.
   - Then, for each trace, append one synthetic violating step per counterexample class, built from the trace's last projection: stale acceptance, overlapping contracts, advisory execution, duplicate claim, implicit retry, changed preview, and rollback-with-complete. Assert exactly the expected violation code.
   - Print counts and exit non-zero on any mismatch.

### 9. Expanded public-operation model and engine replay
1. **Model.** Rewrite `models/governance.qnt` (module `governance`) per the approved domain.

   Variables:
   - `phase ∈ {plan_ready, executing, shipped, abandoned}`, `advisory`;
   - `approvalId ∈ {0,1,2}` (0 = none; approve alternates 1↔2), `approvalFresh`;
   - `taskStatus: Tasks → {todo, ready, in_progress, done, blocked}` over `Tasks = {0,1,2}`;
   - `taskOutcome: Tasks → {pass, fail}`, `amendmentCount ∈ 0..6`;
   - `executionFresh`, `reviewVerdict ∈ {pass, fail}`, `blockedAtReview`;
   - `acceptance ∈ {none, passed, failed}`, `acceptanceFresh`;
   - `productEdits ∈ 0..2`, `shipped`, `shippedApprovalId`.

   Remove `terminalGateRefused` and `contractAmendmentCount`.

   Actions, with each one's engine dispatch:

   | Action | Guard / effect | Engine dispatch |
   | --- | --- | --- |
   | `approvePlan` | phase ∈ {plan_ready, executing}, ¬advisory, ¬approvalFresh → toggle `approvalId`, `approvalFresh`, `executionFresh := false`, `acceptanceFresh := false` | `approvePlan(actor)` |
   | `setAdvisory` / `setGuarded` | Current guards/effects, with `setGuarded` restoring `approvalFresh := true` | `setControlMode` |
   | `amendTask(t, o)` | nondet t, o; requires `taskStatus(t) ≠ in_progress` and `amendmentCount < 6` → `taskOutcome(t) := o`, freshness reset, todo→ready, count+1 | `amendTask` with `maxFilesTouched: BASE + count + 1` and pass/fail content command, as today |
   | `amendTaskOverlapDenied` | Refusal; state unchanged | `amendTask(task2, filesAllowed: [task0 path, task2 path])`, expect `/^overlapping filesAllowed /` |
   | `executeWorkflow(jobs ∈ {1,2})` | Hypothesis H1 below | `executeWorkflow({ jobs, untilBlocked: true })` |
   | `executeRetry` | guard `blockedAtReview`, approvalFresh, ¬advisory → review rerun with `reviewVerdict` | `executeWorkflow({ retry: true })` |
   | `executeFailureUnchanged` | guard `blockedAtReview` or a blocked task; state unchanged | assert the loopback review/task request counters did not change |
   | `setReviewVerdict(v)` | Loopback stimulus only | none |
   | `unblockTask(t)` | | `unblockTask` |
   | `undoTask(t)` | phase executing, `taskStatus(t) = done` → todo, `approvalFresh := false` | `undoLastTask({ taskId })` |
   | `executeWithoutApproval`, `executeAdvisoryDenied` | Existing refusals | existing |
   | `recordAcceptance(s ∈ {passed, failed})` | guard executionFresh ∧ approvalFresh | `recordAcceptance` |
   | `acceptanceDenied` | guard ¬executionFresh | expect `/^complete, fresh workflow evidence is required before acceptance$/` |
   | `shipStaleApprovalDenied` | guard ¬approvalFresh ∧ phase executing | `ship({ commit: true, confirm: yes })` refused; calibrate the exact adopted message once, then pin that regex |
   | `shipDeniedNotReady` | guard ¬shipReady ∧ approvalFresh | any `LegionRefuseError` |
   | `shipPreviewChangedDenied` | guard shipReady, productEdits < 2 → refusal; productEdits+1, `executionFresh := acceptanceFresh := false` | the confirm callback writes `docs/replay-note-${n}.md`, runs `git add` on it, returns `true`; expect the `SHIP_STAGED_CHANGED` refusal |
   | `shipPrFailureRollback` | guard shipReady → state unchanged (calibrate whether evidence freshness survives) | `ship({ commit: true, pr: true, confirm: yes, prCreate: () => ({ error: "replay PR failure" }) })`; expect rejection; assert the governance trace ends in `ship-rollback` success |
   | `shipConfirmed` | guard shipReady → `phase := shipped`, `shippedApprovalId := approvalId` | `ship({ commit: true, confirm: yes })` |
   | `interruptTask` | guard as executeWorkflow ∧ `taskStatus(0) ∈ {ready, todo}` | Hypothesis H2 below |
   | `abandon`, `readStatus` | Existing | existing |

   `shipReady` ≡ phase executing ∧ ¬advisory ∧ approvalFresh ∧ executionFresh ∧ acceptance = passed ∧ acceptanceFresh.

   **H1** (`executeWorkflow`), guard phase ∈ {plan_ready, executing} ∧ ¬advisory ∧ approvalFresh ∧ no blocked/in_progress task ∧ ¬executionFresh ∧ ¬blockedAtReview:
   - Runnable tasks (`ready|todo`) are processed in id order: one at a time for jobs = 1, in batches of 2 for jobs = 2.
   - A failing task becomes blocked and the run stops after its batch.
   - When all tasks are done, integration reruns every task's command. The lowest-index failing task becomes blocked.
   - Otherwise review runs: `pass` → `executionFresh`, phase executing; `fail` → `blockedAtReview`.

   **H2** (`interruptTask`):
   - The replay spawns `scripts/governance-replay-child.mjs <projectRoot> <baseUrl>`. The child runs `executeWorkflow({ taskId: task0, step: true })`.
   - The loopback provider holds task0's request open. The parent kills the child with SIGKILL once that request arrives, then calls `engine.recoverStaleInProgress()`.
   - Before encoding the effect, run one probe:
     - If the task ends `blocked`, the effect is `taskStatus(0) := blocked`.
     - If it stays `in_progress` with an `execute --resume` hint, the effect is `in_progress`. Also add `resumeInterrupted` (guard `taskStatus(0) = in_progress`), dispatched as `executeWorkflow({ resume: runId })` with the provider no longer holding, effect task0 `done`.

   **Calibration:** generate 50 traces and replay them. On a mismatch, compare the engine behavior with `docs/design/workflow-focus.md`:
   - documented behavior → fix the model rule and record it in a QNT comment;
   - undocumented or unsafe behavior → fix the engine.

   `Safety` covers:
   - domains;
   - `advisory ⇒ phase ≠ executing`;
   - `executionFresh ⇒ approvalFresh ∧ ¬advisory ∧ phase ∈ {executing, shipped}`;
   - `acceptanceFresh ⇒ executionFresh ∨ shipped`;
   - `shipped ⇔ phase = shipped`;
   - `shipped ⇒ shippedApprovalId = approvalId ∧ acceptance = passed`;
   - `¬(blockedAtReview ∧ executionFresh)`.
2. **Replay script** (`scripts/replay-governance-itf.mjs`):
   - Update `ACTIONS`, `MODEL_FIELDS`, and `decodeModelState` for the three-task maps and the new vars. Map approval IDs to 1/2 by order of first occurrence.
   - `taskOutcome` comes from whether each task's `verificationCommands` equals the passing command.
   - `blockedAtReview` = `workflowStatus.execution === "blocked"` and the blocker starts with `independent review`.
   - Setup (`prepareProject`):
     - `git init` with an initial commit, using the `initGitRepo` pattern from `scripts/consumer-smoke.mjs:44-54`;
     - three `TASK_OUTPUTS`;
     - after plan readiness, adopt assurance with `approvePlan(actor, { assuranceManifestPath })`. The manifest is an `adapter-default` manifest written to a temp file outside the project, adapted from `manifest()` in `packages/core/test/assurance-adoption.test.js:13`, with this spec/acceptance/task IDs and no validators or knowledge.
   - The loopback provider answers the review prompt by calling `write_file` on the review-notes path given in the review prompt. When the stimulus is `pass`, the notes are `Verdict: PASS` plus one non-empty findings line; when `fail`, `Verdict: FAIL`. Before coding, confirm the exact notes path and prompt marker from `packages/core/src/engine.ts` around `REVIEW_NOTES_PATH`.
   - After every ship action and at the end of every trace, call `inspectGovernanceTrace` through the persist dist for the current approval. Require `status === "valid"` and `violations.length === 0`.
   - Add `--shard <index>/<count>`, which replays only trace indices where `index % count === shard` while still validating the complete corpus names.
   - Remove the usage text that claims "No synthetic review PASS". The review verdict is a deterministic provider-stimulus seam, like `fakeArtifacts`.

### 10. CI governance jobs
In `.github/workflows/ci.yml`, replace `governance-model` with two jobs.

1. **`governance-model`.** Keep the existing Java/Apalache install steps. Then:
   - run `quint verify` (both models: `models/governance.qnt` and `models/governance-boundaries.qnt`) with `--apalache-version=0.62.1 --max-steps=20 --invariant=Safety`;
   - generate 1,000 boundary ITF traces: `--backend=typescript --seed=20261002 --max-steps=40 --max-samples=1000 --n-traces=1000 --mbt`;
   - run `node scripts/check-governance-boundaries.mjs --directory "$RUNNER_TEMP/boundary-itf" --expected-traces 1000`.
2. **`governance-replay`.** Matrix `shard: [0..7]`, `timeout-minutes: 300`.
   - Build, install bwrap, and apply the userns sysctl.
   - Generate the same 1,000 public-model traces (same seed).
   - Run `node scripts/replay-governance-itf.mjs --directory "$RUNNER_TEMP/governance-itf" --expected-traces 1000 --jobs 4 --shard ${{ matrix.shard }}/8`.

### 11. Delivery gaps
1. **Receipt shape.** In `packages/core/src/types.ts:411-413`, change `ShipBundleStatus` to:
   - `{ status: "exported"; path: string; manifestSha256; snapshotDigest; warning? }`;
   - `{ status: "failed"; path: string; reason: string; recoveryHint: string }`.

   Update the producers at `engine.ts:4577-4608`, the consumer at `packages/cli/src/ship.ts:82-87`, and the tests at `packages/core/test/ship.test.js:89-122`. Find any remaining uses with `grep -rn "bundle\?*\.\(directory\|error\)" packages`.
2. **Profile/model tokens.** In the predicate assembly (`engine.ts:7607-7611`), add:
   - `{ token: addToken("profile", name), kind: "profile", digest: null }` for each configured profile name in `config.adapter.profiles`;
   - one `{ token: addToken("model", `${adapterId}:${modelName}`), kind: "model", digest: null }` per configured model name.

   Names stay only in `tokenMapping`.
3. **Predicate digest in verification output.**
   - Add `predicate: { sha256: string } | null` to `DeliveryVerificationReport` in `packages/persist/src/delivery.ts`. It is the SHA-256 of the exact `predicate.json` bytes, or null if the member is invalid.
   - `ship verify` text prints `Public predicate SHA-256: <hex> (predicate.json)`.
   - `ship export` also prints that line.
4. **Consent-bound reusable workflow** (`.github/workflows/delivery-attest.yml`):
   - Add inputs `predicate-sha256` (required string) and `bundle-run-id` (string, default `''`).
   - Grant `actions: read` in the verify and attest jobs.
   - Pass `run-id`/`github-token: ${{ github.token }}` to both downloads when `bundle-run-id != ''`.
   - In the verify step, compute the SHA-256 of `predicate.json` and fail unless it equals the input.
   - In the attest job, also download the full caller bundle, copy `ci.sigstore.json` into it, and upload it as `attested-delivery-bundle`.

### 12. Dashboard and MCP assurance projections
1. **Dashboard** (`packages/dashboard/src/snapshot.ts`):
   - Add `workflow: { assurance: WorkflowStatus["assurance"] | null; blocker: string | null; next: string } | null` and `workflowError: string | null` to `DashboardSnapshot`.
   - Populate them in the snapshot builder via `createLegionEngine(store.projectRoot).getWorkflowStatus()`, only when the CLI status path would (mirror the guard used in `packages/cli/src/status.ts`). Catch errors into `workflowError`.
   - Render an "Assurance" section in `packages/dashboard/src/html.ts`: mode, information-flow posture, trace status, coverage counts, and per-check decision and reason.
2. **MCP:**
   - Add `"@9thlevelsoftware/legion-cli-core": "workspace:*"` to `packages/mcp/package.json` and run `pnpm install`.
   - `readStatus` (`packages/mcp/src/reader.ts:203-232`) returns the same `workflow` and `workflowError` fields, using the same guard. Take the project root from the reader's store; if `LegionReader` lacks `projectRoot`, thread the root from where `packages/mcp/src/server.ts` constructs the reader.
3. **Tests.** Extend `packages/cli/test/dashboard.test.js` and `packages/mcp/test/mcp.test.js`. An adopted fixture exposes `workflow.assurance.mode` and `traceStatus`; a legacy fixture returns `assurance: null`.

### 13. Native release pipeline
1. **Assembly mode.** Extend `scripts/build-wasi-host.mjs` with `--assemble <dir>`.
   - `<dir>/<target>/` must contain the host binary (`legion-wasi-host` or `legion-wasi-host.exe`) and `smoke.json` for all seven `targets`.
   - Validate each `smoke.json`: `{ target, sha256, status: "passed", guardKind, cases: [{ id, status }] }`, where `sha256` equals `describe()` of the binary.
   - Copy the binaries to `packages/sandbox/dist/native/<target>/`. Write a `scope: "release"` manifest with all seven hosts, then run the existing `--validate-release` logic.
   - Update the usage error to list the new flag.
2. **Smoke script.** Add `scripts/native-host-smoke.mjs --expect-target <t> --out <file>`, which imports `packages/sandbox/dist/index.js` and checks:
   - `resolveComponentRuntime()` resolves and `identity.target === t`;
   - JSON-contract cases with `extensions/json-contract/assets/json-contract.wasm`: pass, wrong value fails, missing pointer fails, and a 2 MiB input file passes;
   - the run writes `smoke.json` with the binary's SHA-256 and the probe's guard kind.

   Build component inputs as `packages/sandbox/test/component.test.js` does.
3. **Reusable workflow `.github/workflows/native-host.yml`** (`on: workflow_call`, `permissions: contents: read`).
   - **Job `native-host`.** Matrix tuples:

     | Runner | Target |
     | --- | --- |
     | `windows-latest` | `x86_64-pc-windows-msvc` |
     | `ubuntu-24.04` | `x86_64-unknown-linux-gnu` |
     | `ubuntu-24.04-arm` | `aarch64-unknown-linux-gnu` |
     | `ubuntu-24.04` | `x86_64-unknown-linux-musl` |
     | `ubuntu-24.04-arm` | `aarch64-unknown-linux-musl` |
     | `macos-26-intel` | `x86_64-apple-darwin` |
     | `macos-26` | `aarch64-apple-darwin` |

     Steps:
     - Install with `pnpm install --frozen-lockfile`.
     - Install the Rust toolchain: `rustup toolchain install 1.96.0 --profile minimal --target <t> --target wasm32-unknown-unknown`.
     - Build with `node scripts/build-wasi-host.mjs --target <t>`.
     - On the `x86_64-unknown-linux-gnu` job only, run `git diff --exit-code extensions/json-contract` (the guest reproducibility gate) and `cargo +1.96.0 test --locked -p legion-json-contract` from `packages/sandbox/native`.
     - On all other jobs, run `git checkout -- extensions/json-contract`.
     - Run `pnpm --filter @9thlevelsoftware/legion-cli-sandbox test`.
     - Smoke: on gnu, msvc, and darwin targets run `node scripts/native-host-smoke.mjs` directly. On musl targets run it inside `docker run --rm -v "$PWD:/w" -w /w node:22-alpine`.
     - Upload `legion-wasi-host-<t>` containing `<t>/<binary>` and `<t>/smoke.json`.
   - **Job `native-assemble`** (needs `native-host`, ubuntu-24.04):
     - download all seven artifacts into `native-artifacts/`;
     - build;
     - run `node scripts/build-wasi-host.mjs --assemble native-artifacts`;
     - run the smoke on the host (expects gnu), in `node:22-bullseye` (glibc 2.31; expects `x86_64-unknown-linux-musl`), and in `node:22-alpine` (expects musl);
     - upload `legion-native-release` (`packages/sandbox/dist/native/**`).
4. **Callers.**
   - `ci.yml` adds a job `native: uses: ./.github/workflows/native-host.yml`.
   - `publish.yml` adds `native-assemble: uses: ./.github/workflows/native-host.yml`, and job `publish` gets `needs: native-assemble`. After `Install`, it downloads `legion-native-release` into `packages/sandbox/dist/native` and runs `node scripts/build-wasi-host.mjs --validate-release` before Typecheck. Leave the trigger, permissions, allowlist, and publish steps unchanged.

### 14. Integrated installed assurance smoke
1. **Shared helper.**
   - Extract the pack/install logic from `scripts/consumer-smoke.mjs:55-90` into `scripts/lib/packed-consumer.mjs`:
     `export async function installPackedConsumer(root, temporary): Promise<{ consumer: string; bin: string; run: Function; runOk: Function; runRefused: Function; initGitRepo: Function }>`
     Keep the `run` environment handling from lines 10–54.
   - Make `consumer-smoke.mjs` use it with no behavior change.
2. **`scripts/assurance-smoke.mjs [--evidence <file>] [--demo-bundle-out <dir>]`.**
   - If `hardenedSandboxAvailable(config.sandbox)` is false, exit with code 2 and print `assurance smoke requires a hardened sandbox (bwrap/seatbelt/docker)`.
   - Start an in-process OpenAI-compatible loopback server that counts planner and quarantined requests separately. Build its governed planner/quarantine responses from the server in `packages/core/test/governed-engine.test.js`.
   - Start a loopback streamable-HTTP MCP server, using that test's MCP server pattern.
   - Create a project with `git init` and use the installed CLI for every lifecycle command.
   - **Fixture files:**
     - `config/input.json` (workspace);
     - `secrets/canary.txt` (sealed; random canary);
     - `docs/notes.md` (workspace) containing injection text that instructs writing `src/forbidden.ts`, calling a shell, and sending the canary;
     - `src/rules.ts` exporting `computeStatus`.
   - **Manifest:** `information-flow` mode; the provider sink permits `workspace`; one MCP grant whose external call requires approval; knowledge unit `rules` bound to `src/rules.ts` function `computeStatus`; validator `output-contract` (`extension:json-contract`) asserting `/status eq "ok"` in `dist/output.json`, linked to the first acceptance ID; delivery artifact `dist/output.json`.
   - **Approval:** `plan approve --assurance <manifest> --check "<argv>"`. The argv check is a Node one-liner that exits 0 only if connecting to the loopback server port fails, which proves the hardened verification network is denied.
   - **Flow, with assertions:**
     1. `execute` writes `dist/output.json`. The run blocks on the MCP action pending approval.
     2. Get the pending action from `status --json`. If status does not expose pending governed actions, add `pendingActions` from `engine.getPendingGovernedActions()` to the CLI status JSON as part of this step.
     3. `execute approve-action --run … --action … --value-digest … --sink … --reason smoke`, then `execute --resume <run>`. The MCP server receives exactly one call.
     4. No provider request body contains the canary, `src/forbidden.ts` does not exist, and planner requests contain none of the `docs/notes.md` text.
     5. The component check passes. An unrelated edit (`docs/other.md`) then `execute` yields check decision `reused` in `plan evidence --json`.
     6. Change `config/input.json` so the assertion fails: the check fails, `status` is blocked, and `ship` refuses. Restore it, then `execute` passes.
     7. Record acceptance pass via `plan acceptance --pass <id>`. `context trace validate --json` returns `valid`.
     8. Ship with piped `y`: `ship --bundle <tmp>/bundle --commit`.
     9. Generate an Ed25519 PKCS8 key outside the project with `node:crypto`. Run `ship sign`. Write a trust policy pinning the SPKI.
     10. Copy the bundle to an empty directory and run `ship verify <copy> --require local-key --trust-policy <p> --source <project> --expect-approval <id>`, which passes.
     11. Tamper one member byte in a second copy; verify then exits 1.
   - **`--demo-bundle-out <dir>`:** also copy the exported, unsigned bundle there. Use only synthetic fixture names.
   - **`--evidence`:** write JSON containing:
     - component first-execution ms and reuse ms;
     - planner and quarantined request counts;
     - native package bytes (sum of `dist/native` files);
     - end-to-end ms;
     - full-rerun oracle ms (rerun after `plan approve`, which forces fresh checks);
     - `unsafeReuse: 0`, asserting that no reuse occurred when any keyed input changed.
3. **CI.** Add job `assurance-smoke` to `ci.yml` (ubuntu-latest, bwrap plus sysctl, Rust 1.96.0):
   - `node scripts/build-wasi-host.mjs`
   - `pnpm build`
   - `node scripts/assurance-smoke.mjs --evidence "$RUNNER_TEMP/assurance-evidence.json"`
   - upload the evidence file.

### 15. Local verification, commit, push, draft PR
1. Run the Verification local block. Fix failures at their root.
2. Run an independent security review: spawn a `security-reviewer` subagent over the working tree. Scope it to the controller (`packages/http/src/governed.ts`, `packages/core/src/assurance-flow*.ts`), native host (`packages/sandbox/native/src/**`, `packages/sandbox/src/component.ts`), verification (`packages/core/src/verify.ts`, `packages/sandbox/src/sandbox.ts`), governance (`packages/persist/src/governance-trace.ts`, `packages/schema/src/governance.ts`), and delivery (`packages/persist/src/delivery*.ts`). Fix every confirmed finding and re-run the affected suites.
3. Commit everything with `git add -A` on `assurance-integration`. This includes `.omp/plans/ASSURANCE_INTEGRATION_PLAN.md`; `.omp/plans/*` is a tracked convention. Commit message: `Integrate evidence-governed assurance (opt-in): contracts, component validators, knowledge reuse, information flow, governance traces, delivery bundles`.
4. Run `git push -u origin assurance-integration`, then `gh pr create --draft --base main --title "Opt-in evidence-governed assurance integration" --body-file <tmp summary>`. The summary lists scope, opt-in status, and the evidence still pending.
5. Watch with `gh pr checks --watch`. For each failing job, fetch logs with `gh run view <id> --log-failed`, fix, commit, and push. Repeat until all required jobs are green.
   - The existing `Q-WIN-DOCKER` deferral stays.
   - If a macOS target's memory-limit probe is non-enforcing on hosted runners, stop and report the evidence to the user rather than drop the target. Dropping it changes the approved seven-target release contract.

### 16. Public demo attestation (point-of-risk confirmation required)
1. Add a temporary `.github/workflows/delivery-attest-demo.yml`. It triggers on `push` to branch `assurance-integration` with path filter `.github/delivery-attest-demo/request.json`, and reads that JSON: `{ "phase": "build" | "attest", "bundleRunId"?: string, "predicateSha256"?: string }`.
   - **Build phase:** an ubuntu job (bwrap, Rust, build) runs `node scripts/assurance-smoke.mjs --demo-bundle-out "$RUNNER_TEMP/demo-bundle"`, uploads artifact `demo-delivery-bundle`, and writes `predicate.json` plus its SHA-256 to the step summary.
   - **Attest phase:** a job calls `./.github/workflows/delivery-attest.yml` with:
     - `bundle-artifact-name: demo-delivery-bundle`
     - `bundle-run-id: <bundleRunId>`
     - `predicate-sha256: <predicateSha256>`
     - `public-disclosure-consent: true`

     Because GitHub only dispatches `workflow_dispatch`/`repository_dispatch` from the default branch, the push trigger is required on this unmerged branch.
2. Commit and push `request.json` with `{ "phase": "build" }`. When the run finishes, use `gh run download <id> -n demo-delivery-bundle` and compute the predicate digest.
3. **Point of risk.** Show the user the exact `predicate.json` contents, the manifest subject digest, and the predicate SHA-256 with `ask`, noting that this goes to GitHub and the public Sigstore transparency log. Proceed only on explicit approval. If the user declines, skip to substep 6 and report public CI authenticity as unperformed.
4. Commit and push `request.json` with `{ "phase": "attest", "bundleRunId": "<id>", "predicateSha256": "<hex>" }`. Then download `attested-delivery-bundle`.
5. **Offline verification.**
   - Fetch `gh attestation trusted-root > <tmp>/trusted_root.jsonl` on the host.
   - Write a trust policy with these exact values:
     - repository `9thLevelSoftware/legion-cli`;
     - SAN `https://github.com/9thLevelSoftware/legion-cli/.github/workflows/delivery-attest.yml@refs/heads/assurance-integration`;
     - issuer `https://token.actions.githubusercontent.com`;
     - the signer workflow and source digest from the attest run's commit.
   - Build a throwaway image FROM `node:22-bookworm`. It installs pinned `gh` from the official apt repository and `npm install`s the packed tarballs, using the Step 14 helper.
   - Run `docker run --network none` with `ship verify <bundle> --require ci-oidc --trust-policy <policy>`. It must pass.
   - Negative runs: a wrong SAN, a wrong predicate type, and `PATH` without `gh` must each exit 1.
   - If verification fails only on identity format, inspect the bundle certificate. Fix the policy derivation to exact values; never loosen it to a regex.
6. Record the verified bundle, `ci.sigstore.json`, and `trusted_root.jsonl` as a test fixture under `packages/persist/test/fixtures/ci-attestation/`. These are public data. Add a test in `packages/persist/test/delivery.test.js` that runs only when `gh` is on `PATH`; it asserts the positive offline verification plus the wrong-SAN failure.
7. Delete `delivery-attest-demo.yml` and `.github/delivery-attest-demo/`, commit, push, and confirm CI is still green.

## Critical files & anchors
- `packages/core/src/engine.ts`, the governance boundary code:
  - `#appendGovernanceBoundary` (around 7199): refused outcome, explicit retry, fault seam;
  - `#withLockOrRefuse` (around 8308): epoch guard placement;
  - `ship` (around 4500): ship-confirm ordering;
  - `#governanceProjection` (around 7091): vacuous integration pass.
- `packages/schema/src/governance.ts`: the single home for transition tables, the overlap predicate, the semantic validator, and outcome blocking.
- `packages/core/src/assurance-flow-host.ts` `readSource` (around 1291): the unexplained-byte label, extracted to the shared helper.
- `scripts/replay-governance-itf.mjs`: the engine replay to rework for the expanded model, adoption, review stimulus, sharding, and per-trace semantic validation.
- `scripts/build-wasi-host.mjs`: the seven-target list and release validation, extended by `--assemble`.

## Verification
All commands run from `D:/legion-cli` with Node 22+ and pnpm 9.15.9 unless stated otherwise.

**Local (Windows):**
1. `pnpm --filter @9thlevelsoftware/legion-cli-schema run build && pnpm --filter @9thlevelsoftware/legion-cli-schema run emit`, then `pnpm build && pnpm typecheck && pnpm test`.
2. `pnpm smoke:consumer` and `node scripts/check-publish-allowlist.mjs`.
3. Focused new behavior:
   - `pnpm --filter @9thlevelsoftware/legion-cli-persist test` covers every semantic violation code, `invalid`, and epochs.
   - `pnpm --filter @9thlevelsoftware/legion-cli-core test` covers:
     - the governance faults matrix;
     - the interrupted-epoch refusal followed by reapproval;
     - the refused amend not poisoning the epoch;
     - the component retry semantics;
     - the information-flow component stage with `observationLabel`;
     - the unexplained-change sealed label.
   - `pnpm --filter @9thlevelsoftware/legion-cli test` covers `context trace validate`, exit 0 then 1 after frame deletion, and help parity.
4. **Lazy load.** Write a throwaway `--import` hook (`module.register` with a resolve hook logging resolved URLs to stderr). Run `node --import <hook> packages/cli/dist/bin.js status` in an empty temp directory. No resolved URL may end with `/sandbox/dist/component.js` or `typescript`. Delete the hook afterwards.
5. **Formal.** Start the Apalache server from a temp working directory as in Step 0. Then:
   - Run `pnpm exec quint verify models/governance.qnt --apalache-version=0.62.1 --max-steps=20 --invariant=Safety`. Do the same for `models/governance-boundaries.qnt`. Both must report no violation.
   - Generate the 1,000-trace boundary corpus and run `node scripts/check-governance-boundaries.mjs --directory <tmp> --expected-traces 1000`. It must print zero mismatches and 7×1,000 rejected counterexamples.
   - Generate the public corpus and run `node scripts/replay-governance-itf.mjs --directory <tmp> --expected-traces 1000 --jobs 16 --shard 0/10`. It must PASS 100 traces with zero semantic violations. The full 1,000 runs in CI.
   - Stop the server.
6. **Fingerprint regression.** `node scripts/autoresearch-evidence.mjs` must pass its unchanged identity corpus. Report the measured median as new evidence alongside the 38.597 ms historical baseline.

**CI** (draft PR `assurance-integration`): all jobs must be green — `typecheck-and-test` (ubuntu and windows), `linux-docker`, `macos`, `native` (seven targets plus `native-assemble`, including the bullseye→musl and alpine selections), `governance-model`, eight `governance-replay` shards (1,000/1,000 PASS, no violations), and `assurance-smoke` (with uploaded evidence JSON).

**Demo attestation:**
- The `attest` run succeeds.
- The offline `docker run --network none … ship verify --require ci-oidc` passes.
- The wrong-SAN, wrong-predicate-type, and no-`gh` variants each exit 1.
- The gated fixture test passes locally, where `gh` is present.

**Final report:**
- State the evidence per acceptance group A–G.
- State that promotion is not performed.
- State any unverifiable residue: offline revocation limits and the bounded-model scope.

## Assumptions & contingencies
- **External effects.** The user authorized pushing branch `assurance-integration`, opening a draft PR, iterating CI, and exactly one public demo attestation of a synthetic bundle, gated on showing the exact predicate first. No merge, tag, publish, or main-branch push.
- **Branch contents.** The branch includes the 9 local autoresearch commits ahead of `origin/main`. If the PR shows conflicts with `main`, rebase onto `origin/main` and resolve them, preserving both sides' behavior. Never force-push `main`.
- **Schema versions.** The identifiers `action-approval/v2`, `http-run-authority/v2`, and `http-governed-checkpoint/v3` are kept as implemented (unreleased evolution, already documented).
- **Guest reproducibility.** If the `x86_64-unknown-linux-gnu` job's `git diff --exit-code extensions/json-contract` fails, download that job's built `assets/json-contract.wasm` and updated `SKILL.md`, commit them, and keep that job as the reproducibility gate.
- **Replay duration.** If a replay shard exceeds 300 minutes, raise the shard count to 16 and use `--jobs 4`. Never reduce the 1,000-trace corpus.
