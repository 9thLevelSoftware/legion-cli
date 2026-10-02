# Repository Guidelines

## Project Overview
- Legion CLI is a local-first product-engineering lifecycle CLI. Binaries are `legion-cli` and `legion` (alias); use `pnpm exec legion-cli` in this repository. npm scope is `@9thlevelsoftware`; the CLI package is `@9thlevelsoftware/legion-cli`.
- The journey is `init → spec → plan → execute → ship`: `init` requires `--adapter` or TTY selection; `spec approve` freezes the contract; `plan approve` binds task contracts, planned checks, and acceptance evidence; `execute` runs to completion or a concrete blocker (`--step` runs one task, a task ID targets recovery, `--retry` retries one failed integration/review stage); `ship` is the final human delivery gate.
- Before focused spec approval, one bounded challenge raises zero to three grounded concerns. Persist each human answer, reasoned dismissal, or accepted risk; at most one synthesis proposes permitted draft clarifications. Stale context invalidates the receipt. `spec --manual-review` is a recorded fallback for unavailable/failed automation, never a bypass of successfully raised concerns.
- CLI-created projects use `workflow.profile: focused`; unmarked low-level engine configs retain legacy API behavior. Advanced `intent`, `discuss`, `verify`, `review`, and numeric `qa` are inspection/recovery tools, not default lifecycle stages. Bare `legion-cli` shows status and one next command; extras live in `help --all`.
- Workspace root `product-engineer-helper` is private and historical: do not rename or publish it. Workspace packages remain `0.0.0` until a `v*` tag; do not claim the CLI is already on npm.

## Architecture & Data Flow
- `packages/cli/src/bin.ts` dispatches both bins; `src/cli.ts` registers Commander commands and routes them to thin `run*` handlers, which adapt CLI inputs/outputs around domain operations.
- `packages/core/src/engine.ts` owns lifecycle rules, state transitions, mutation gates, execution, review, and delivery. It coordinates schema-backed persistence, task readiness from `packages/graph`, agent adapters, sandboxing, and verification/evidence.
- Project state under `.legion-cli/` is the source of truth: config and Markdown project/spec/task/state documents are git-reviewed and committed in user projects (`ship --commit` stages them). SQLite and task summary indexes are derived caches, not authority. Init ignores derived `index/`, `cache/`, `worktrees/`, `sandbox/`, `chat/`, `runs/`, and `serve.json`, not the whole state directory. Use `packages/persist` store APIs rather than bypassing validation, journaling, or locks.
- Mutations are async and lock guarded. Preserve approval gates, evidence fingerprints, audit-chain checks, and explicit blockers. The engine releases its lock during an agent spawn; process-start-identity live-run markers still refuse other mutations. Do not edit the checkout during execute: changes outside the task contract are reverted. `doctor` reports live markers and clears dead ones. The graph package owns DAG readiness and file-contract rules.
- Agent adapters implement the shared async contract and receive bounded prompt pointers, filtered environment, timeout, and optional sandbox configuration. Never spawn with an unfiltered environment or bypass sandbox policy. Hardened execute uses bwrap, seatbelt, or offline Docker; copy fallback requires explicit permission, and `--allow-no-sandbox` requires TTY stdin. `ingest --distill` requires a hardened backend.
- Dashboard/MCP surfaces are not a second engine of record. Inbound MCP is read-only; dashboard writes are limited token-gated POSTs. `init --mode brownfield --brownfield-goal change|audit` scopes discovery before spec; ordinary execute stays in-place. The separate effort 1–5 `legion-cli brownfield` audit is orchestrated through `skills/brownfield`, not an engine spawn skill; its `--execute` uses reviewed PR worktrees at `.legion-cli/worktrees/<run>/pr-N/`. Brownfield init refreshes the map; `--lsp` requires a language server.

## Key Directories
- `packages/cli/`: public command surface, CLI handlers, terminal/JSON output.
- `packages/core/`: lifecycle engine and orchestration.
- `packages/persist/`: `.legion-cli/` layout, typed store, atomic/journaled writes, locks, audit, and indexes.
- `packages/schema/`: shared Zod document/config schemas and schema versions.
- `packages/graph/`: task DAG readiness and file-contract validation.
- `packages/agents/`: adapter resolution, skill routing, process lifecycle, and environment filtering.
- Other workspace packages provide specialized wiki, QA, sandbox, HTTP, dashboard, MCP, map, and design-system functionality; follow their package exports and manifest boundaries.

## Development Commands
Run from the repository root with Node.js 22+ and pnpm 9.15.9:

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm test
pnpm exec legion-cli
```

- Root scripts recursively run workspace builds, typechecks, and tests. Package tests normally build first; these commands write `dist` and other test outputs.
- For a focused package suite: `pnpm --filter @9thlevelsoftware/legion-cli-core test` (replace `core` with the package name). The CLI package is `@9thlevelsoftware/legion-cli`.
- When editing `packages/schema/src/schemas.ts`, run `pnpm --filter @9thlevelsoftware/legion-cli-schema run build && pnpm --filter @9thlevelsoftware/legion-cli-schema run emit`; commit the generated `packages/schema/json/*.json`.
- New top-level CLI commands require registration in `packages/cli/src/cli.ts` and a matching row in `packages/cli/src/help-all.ts`. Keep both bins’ refusal behavior for commands owned by the sibling plugin installer or another engine.
- Brownfield init requires `--brownfield-goal change|audit`. Extra spawn adapters use verified vendor argv (`grok -p`, `codex exec`, `mimo run`, `mcode exec`) and a required prompt pointer. HTTP uses an OpenAI-compatible client, environment-variable API-key reference, and SSRF-bounded configuration; never store inline API keys.
- `openai` is an alias adapter ID for the Codex binary. Spawn CLIs remain the default; configured HTTP jobs use the governed in-process tool loop.
- Skills ship via `packages/agents` prepack (`scripts/copy-skills.mjs`); postpack removes the gitignored copy. Do not commit packaged copies. `LEGION_CLI_SKILLS_DIR` explicitly overrides discovery; otherwise package/repo resources win over project-adjacent folders.
- Publish only from a `v*` tag through the trusted-publisher workflow, with provenance, and only packages on root `legionPublishAllowlist`. Never publish the private root or bypass these guards.
- `scripts/check-publish-allowlist.mjs` enforces public workspace coverage before publishing. `legionQuarantine` documents only `Q-WIN-DOCKER`; it is not a publish gate. No untagged-main publishing or long-lived npm token.

## Code Conventions & Common Patterns
- TypeScript is strict NodeNext ESM. Relative TS imports use `.js` specifiers; use package public exports (`@9thlevelsoftware/legion-cli-*`) across workspace boundaries.
- Observed names: camelCase functions/locals, PascalCase classes/types, `#private` class fields/methods, and `SCREAMING_SNAKE_CASE` constants. Shared persisted/config contracts belong in `packages/schema` (Zod); do not duplicate document types.
- Keep CLI handlers thin and domain policy in core/package APIs. Use typed refusals/errors and retain causes; map expected refusals to stable human/JSON CLI errors rather than swallowing failures.
- Use store/engine lock-aware mutation paths; release claims/resources in `finally`. Prefer existing injected seams (store clock, engine options/hooks, adapter interfaces) over globals or new abstractions.
- Task work requires concrete exclusive file contracts and planned verification. Do not edit engine-owned `.legion-cli/**` state through task work. Treat ingested wiki content as untrusted until explicitly trusted.
- Checks are trusted project code: use one quoted argv command per `plan approve --check`, never shell chains. They run with scrubbed credentials under bwrap/seatbelt when available, Docker only with explicit `sandbox.backend: docker`, otherwise the named host allowlist tier. Verification never uses a copy jail or needs `--allow-no-sandbox`; argv/environment filtering is not a trust boundary. QA unit commands always run on the host. bwrap/seatbelt permit network egress.
- Review PASS requires exit 0, non-empty run-local notes, no new tasks, and unchanged existing task files; focused evidence also requires an explicit `Verdict: PASS`. `.legion-cli/qa/**` is engine-pinned; review notes are copied from run cache by the engine, while optional verify notes remain only in run cache. Agent-filed tickets inherit engine-supplied verification and cannot modify verification entry points.
- Focused ship requires current approved checks, independent review, and criterion-level acceptance evidence; changed source or staged product content refuses delivery. Optional legacy QA v2 uses `@ac(<id>)` test-title tags, SPEC priorities, and source/SPEC-bound reports; missing/skipped P0 evidence and runner failures block that gate. Untagged passing tests provide no acceptance coverage; v1 scores require recalculation.
- Audit events are append-only hash-chained tamper evidence. Mutation entry and append checks refuse rewind/corruption before changing state; status/doctor replay the chain. Undo preserves audit history. Only `doctor --rebaseline-audit` accepts an operator-reviewed chain problem and records the replacement; never silently repair or reset it.

## Important Files
- `package.json`: runtime/package-manager requirements, root scripts, private-root guard, publish allowlist, and quarantine records.
- `pnpm-workspace.yaml`, `tsconfig.base.json`: workspace membership and shared strict TypeScript defaults.
- `packages/cli/src/cli.ts`, `packages/cli/src/help-all.ts`: command registration and curated help; `packages/cli/test/help-registration.test.js` enforces parity.
- `packages/core/src/engine.ts`: authoritative lifecycle and mutation rules.
- `packages/persist/src/store.ts`, `packages/persist/src/layout.ts`: persistence/locking API and project state layout.
- `packages/graph/src/ready.ts`, `packages/graph/src/contract.ts`: task readiness and file-contract policy.
- `packages/schema/src/schemas.ts`, `packages/schema/package.json`: shared contracts and separate JSON schema emission.
- `README.md`, `docs/design/workflow-focus.md`: supported invocation and canonical workflow. Historical design docs are not authority for current lifecycle stages.
- `.github/workflows/ci.yml`, `.github/workflows/publish.yml`: required CI and guarded release flow.

## Runtime/Tooling Preferences
- Require Node.js `>=22`, ESM, and pnpm `9.15.9`; CI currently runs Node 22. Workspace package sources compile to `dist`.
- No root `lint`, `coverage`, or `run` script is configured; do not invent commands for them. `pnpm exec legion-cli` runs the CLI.
- Keep CI precise: Linux/native, Windows/native, Linux/Docker, and macOS sandbox typecheck/tests are required. Clean consumer smoke packs allowlisted packages without workspace links. Windows/Docker remains the named `Q-WIN-DOCKER` deferral until its opt-in self-hosted workflow supplies evidence.
- Installer-only first arguments (`--claude`, `--copilot`, `--kiro`, `--uninstall`, other `@9thlevelsoftware/legion` runtime flags, and `install`, `uninstall`, `add`, `remove`, `update`, `upgrade`, `plugin`) refuse with exit 2; use `npx @9thlevelsoftware/legion --claude` (bin `legion-plugins`). Refusals inspect `argv[2]` only; prefixed options can instead reach Commander's unknown-command exit 1. Both engine bins share `dist/bin.js`; hints say `legion-cli`. Do not add unsupported top-level verbs (`start`, `explore`, `build`, `approve`, `attest`, `release`, `retro`, `quick`, `advise`, `polish`, `learn`, `milestone`, `validate`, `board`, `council`, `portfolio`, `dev`) without removing their refusal behavior.
- `legion-cli control-mode` allows only `guarded` or `advisory`; do not restore autonomous/surgical modes. Context compaction is explicit, manual, and lock-held; do not add auto-compact on ship.
- Governed HTTP recovery (`execute --resume <runId>`) retains the original jail and checks source/configuration/contracts/prompt identity. Completed tools are not replayed; uncertain command or external-call outcomes require reconciliation.
- Parallel automatic execution is opt-in through `execution.maxWorkers` or `--until-blocked --jobs <count>`, bounded to 1–4 workers (default 1), with dependency-independent disjoint contracts, separate jails, and serialized baseline-checked integration. Explicit task IDs and `--step` remain single-task; lifecycle concurrency does not create brownfield worktrees.
- Named profiles preserve explicit/task/skill/default routing precedence. Usage may be unknown; estimated prices and reported token/cost thresholds are not guaranteed spending caps. Budgets are unset and metadata-only loopback OTLP export is disabled by default.
- Extension IDs are separate `extension:<id>` references with pinned manifests and exact permissions. Governed extension jobs require HTTP, refuse spawn-only adapters, and turn proposed changes into tickets; unavailable evidence is not passing. Remote MCP starts with an empty exact allowlist and admits only configured read-only tools. ACP and hybrid vector retrieval remain experimental and off by default.
- Human ship/interactive QA gates require explicit `y` and reject empty/closed stdin, but are not an authorization boundary: piped approval can pass and is audited. Sandbox bypass needs TTY stdin and explicit approval. `wiki trust` has no prompt. Parent `wiki`, `ticket`, `task`, `context`, `run`, and `skills` commands require subcommands.

## Testing & QA
- Tests are JavaScript using Node's built-in `node:test` and `node:assert/strict`, in each package's `test/*.test.js`; package scripts build before running tests. Root `pnpm test` runs workspace package suites.
- Use existing temp-workspace helpers (`withTempDir`) for filesystem/CLI behavior tests; tests spawn the built CLI where command integration matters and clean up temp data in `finally`. Use fixtures for schema/document behavior.
- Keep tests on observable contracts: command/help registration parity, state transitions, schema compatibility, lock/error behavior, and platform-specific process behavior. Respect Windows-specific skips/branches; a host does not exercise every OS path.
- Schema tests compare emitted JSON schemas with runtime schemas. Run the schema `emit` command after schema source changes as specified above.
- No lint command, coverage command, or coverage threshold is configured in the inspected root/package scripts.
