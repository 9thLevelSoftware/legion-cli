# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`AGENTS.md` holds the authoritative project rules (naming, publish guard, refused verbs, brownfield surfaces, CI policy); read it first. `README.md` covers user-facing usage. This file only adds the working loop and architecture.

## Commands

Node 22+, pnpm 9 workspaces, ESM, TypeScript (`tsc` builds to `dist/`). Tests are compiled JS run with `node --test`, so **build before testing**.

```bash
pnpm install && pnpm -r run build        # build everything
pnpm typecheck                           # tsc --noEmit across packages
pnpm test                                # all packages (each test script builds first)

# single test file
pnpm --filter @9thlevelsoftware/legion-cli-<pkg> run build && node --test packages/<pkg>/test/<file>.test.js

# run the CLI from the repo
pnpm exec legion-cli init --name Checkin --adapter fake
```

There is no lint step. On Windows PowerShell use `$env:LEGION_CLI_ADAPTER = "fake"` instead of the bash env prefix. `fake` is the test-only adapter; `doctor` treats it as spawnable only when `LEGION_CLI_ADAPTER=fake`.

Test-only env knobs for the `fake` adapter: `LEGION_CLI_ADAPTER`, `LEGION_CLI_FAKE_ARTIFACTS`, `LEGION_CLI_FAKE_WAIT_READY` / `_RELEASE`. Other overrides: `LEGION_CLI_SKILLS_DIR` (explicit skills folder; otherwise bundled/repo skills take precedence over cwd-adjacent folders), `LEGION_CLI_CRAFT_DIR`, `LEGION_CLI_CHAT_ACTION`.

### Required follow-ups for specific edits

- **Schema change** (`packages/schema/src/schemas.ts`, `versions.ts`): run `pnpm --filter @9thlevelsoftware/legion-cli-schema run build && pnpm --filter @9thlevelsoftware/legion-cli-schema run emit`, and commit `packages/schema/json/*.json` (the schema test diffs them).
- **New verb**: edit `packages/cli/src/cli.ts` and add a row in `packages/cli/src/help-all.ts`; `help-registration.test.js` fails if the two disagree. Never use a name the CLI deliberately refuses (see `bin.ts` and AGENTS.md).
- Publishing is tag-only (`v*`) via CI; never publish the private root or packages not on `legionPublishAllowlist`. `scripts/check-publish-allowlist.mjs` enforces public workspace coverage before publishing; `legionQuarantine` documents only `Q-WIN-DOCKER`.
- **Skills bundling**: `packages/agents` prepack runs `scripts/copy-skills.mjs`; postpack removes the gitignored `packages/agents/skills` copy. Do not commit that copy.

## Architecture

Legion CLI's canonical journey is `init → spec → plan → execute → ship`.
CLI-created projects use `workflow.profile: focused`; unmarked direct engine
configuration retains legacy API behavior. `intent`, `discuss`, `verify`,
`review`, and numeric `qa` are advanced inspection/recovery commands, not default
waypoints. `spec` includes a bounded zero-to-three-concern challenge with
persisted human dispositions and at most one synthesis; failed/unavailable
automation has an explicit manual-review fallback, not a successful-concern bypass.

State lives under `.legion-cli/`, not in memory. Markdown/config/workflow
receipts are authoritative; SQLite and indexes are derived. User projects
commit durable state (`ship --commit` stages it); init ignores only `index/`
(including the lock), `cache/`, `worktrees/`, `sandbox/`, `chat/`, `runs/`, and
`serve.json`, not the whole directory.

Package layering (`packages/*`, all `@9thlevelsoftware/legion-cli-*`):

- `schema` — Zod schemas plus emitted JSON Schema; the shared vocabulary every other package imports.
- `persist` — markdown/frontmatter documents, atomic writes, git, sqlite, and the lock. Path-escape guarded.
- `graph` — task DAG and file-contract queries (`filesAllowed`, overlap, readiness, next-task picking).
- `wiki` — ingest, FTS search, briefing; wiki content is wrapped as *untrusted* until `wiki trust`.
- `map` — module fingerprints/architecture markdown (fallback parser, optional LSP).
- `agents` — adapters that run a model: `fake`, `generic`, `claude`, and vendor CLIs spawned with verified argv; also the skill catalog/resolution. `http` is a separate in-process OpenAI-compatible client with a governed tool loop (SSRF-bounded, `apiKeyEnv` only).
- `sandbox` — jail-as-project-root execution: bwrap (Linux), seatbelt (macOS), Docker (offline agents only, no network or login files), and an unhardened copy fallback. Hardened execution is the default; `--allow-no-sandbox` requires TTY stdin, or explicit `sandbox.allowCopyJail` permits copy fallback.
- `qa` — in-process Playwright/unit JSON scorer. `design-system`, `dashboard` (view-only HTTP/SSE board), `mcp` (read-only stdio server) are surfaces.
- `core` — `LegionEngine` (`engine.ts`) composes all of the above; lifecycle logic (spawn, verify, ship, tickets, packets, compaction, brownfield bookkeeping, refusals) lives here. Mutations run under the persist lock.
- `cli` — thin verb layer. `cli.ts` registers commands, one `src/<verb>.ts` per verb, `help-all.ts` for the full listing, `bin.ts` for the refuse-list and entry point. Verbs delegate to the engine rather than holding logic.

Agent-facing skills live in `skills/<name>/` (spawn skills resolved by `agents`). `skills/brownfield` is an orchestrator-run Claude Code skill, not an engine spawn skill, and is intentionally absent from `SkillIdSchema`. Keep its parsing rules in sync with the separate brownfield audit CLI.

Current lifecycle guidance: `docs/design/workflow-focus.md`. `docs/design/product-engineering-cli.md` is historical architecture, not authority for the public workflow.

## Gotchas

- **Checks are trusted project code.** Approved `--check` commands and task `verificationCommands` are argv-only with credentials scrubbed. They use bwrap/seatbelt where available, explicit `sandbox.backend: docker` for Docker, or the named host allowlist tier; no verification copy jail or `--allow-no-sandbox` flag is required. QA unit commands always run on the host. bwrap/seatbelt allow network egress; environment filtering is not a trust boundary.
- **Hands off during execute.** The lock is released during agent work, but process-start-identity live-run markers refuse other mutations. `doctor` reports live markers and clears dead ones. Out-of-contract edits, including your own concurrent edits, are reverted.
- **Focused delivery evidence.** Spec and plan approvals bind the contracts. Execute records current planned checks and independent review; ship also needs criterion-level `plan acceptance` evidence. Review requires exit 0, non-empty run-cache notes, no new tasks and byte-identical existing task files; focused review evidence requires an explicit `Verdict: PASS`. The engine promotes review notes into pinned `qa/review.md`; optional verify notes remain in run cache. Changed source/evidence or staged product content blocks shipping.
- **Legacy QA v2.** Test title tags `@ac(<id>)` link to SPEC criteria; untagged successes provide no acceptance coverage. Missing/skipped P0 or failed/timed-out runners block the legacy gate. Reports bind SPEC and tested source; historical v1 scores need recalculation. Numeric QA remains optional for focused delivery.
- **Human gates.** Ship and interactive QA reject empty/closed stdin, but piped explicit approval can pass and is audited. `execute --allow-no-sandbox` refuses non-TTY stdin. `wiki trust` has no prompt.
- **Governed runtime.** HTTP resume retains the original jail, validates context/source identities, and never replays completed tools. Uncertain effects require reconciliation. Automatic execution supports 1–4 workers (default 1), with separate jails, disjoint contracts and serialized baseline-checked integration; `--step` and task IDs remain one-task. Extensions require HTTP tool enforcement and exact pinned permissions; ACP and hybrid retrieval remain experimental/off.
- **`ingest --distill`** requires a hardened sandbox. Agent-filed tickets inherit engine-supplied verification commands and cannot touch verification entry points.
- **Undo/audit.** Undo returns only the highest-id done task to todo. Reverting ship refuses dirty tracked state (append-only audit excepted) or an in-progress revert, restores the appropriate phase/receipt, and preserves audit history. Events are append-only hash-chained; mutation entry/append validation refuses rewinds or corruption before state changes. Status/doctor replay the chain. Only `doctor --rebaseline-audit` accepts an operator-reviewed chain problem, records the replacement and refuses live runs. Never reset the audit to make a mutation pass.
- **Large repos.** Map keeps the 10,000 largest source modules (ties by path), with a degraded-map note for omissions. Restore walks only pinned/static contract roots and skips derived/runtime/audit roots; retain atomic derived-index rebuilds.
- CI requires Linux/native, Windows/native, Linux/Docker and macOS sandbox checks. Windows/Docker remains the named `Q-WIN-DOCKER` deferral, with an opt-in self-hosted workflow. Consumer smoke packs allowlisted packages without workspace links and does not publish.
- Untracked scratch/artifacts (`scratchpad/`, `.grok-worktrees/`, `isolate-*.log`) are not part of the product.
