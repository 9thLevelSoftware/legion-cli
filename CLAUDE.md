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

Test-only env knobs for the `fake` adapter: `LEGION_CLI_ADAPTER`, `LEGION_CLI_FAKE_ARTIFACTS`, `LEGION_CLI_FAKE_WAIT_READY` / `_RELEASE`. Other overrides: `LEGION_CLI_SKILLS_DIR`, `LEGION_CLI_CRAFT_DIR`, `LEGION_CLI_CHAT_ACTION`.

### Required follow-ups for specific edits

- **Schema change** (`packages/schema/src/schemas.ts`, `versions.ts`): run `pnpm --filter @9thlevelsoftware/legion-cli-schema run build && pnpm --filter @9thlevelsoftware/legion-cli-schema run emit`, and commit `packages/schema/json/*.json` (the schema test diffs them).
- **New verb**: edit `packages/cli/src/cli.ts` and add a row in `packages/cli/src/help-all.ts`; `help-registration.test.js` fails if the two disagree. Never use a name the CLI deliberately refuses (see `bin.ts` and AGENTS.md).
- Publishing is tag-only (`v*`) via CI; never publish the private root or packages not on `legionPublishAllowlist`.

## Architecture

Legion CLI is a lifecycle engine: `init → intent → discuss → spec → plan → execute → verify → review → qa → ship`. State lives on disk under `.legion-cli/` (gitignored; markdown documents, git, sqlite index, lock), not in memory.

Package layering (`packages/*`, all `@9thlevelsoftware/legion-cli-*`):

- `schema` — Zod schemas plus emitted JSON Schema; the shared vocabulary every other package imports.
- `persist` — markdown/frontmatter documents, atomic writes, git, sqlite, and the lock. Path-escape guarded.
- `graph` — task DAG and file-contract queries (`filesAllowed`, overlap, readiness, next-task picking).
- `wiki` — ingest, FTS search, briefing; wiki content is wrapped as *untrusted* until `wiki trust`.
- `map` — module fingerprints/architecture markdown (fallback parser, optional LSP).
- `agents` — adapters that run a model: `fake`, `generic`, `claude`, and vendor CLIs spawned with verified argv; also the skill catalog/resolution. `http` is a separate in-process OpenAI-compatible client with a governed tool loop (SSRF-bounded, `apiKeyEnv` only).
- `sandbox` — jail-as-project-root execution (bwrap / seatbelt / copy fallback).
- `qa` — in-process Playwright/unit JSON scorer. `design-system`, `dashboard` (view-only HTTP/SSE board), `mcp` (read-only stdio server) are surfaces.
- `core` — `LegionEngine` (`engine.ts`) composes all of the above; lifecycle logic (spawn, verify, ship, tickets, packets, compaction, brownfield bookkeeping, refusals) lives here. Mutations run under the persist lock.
- `cli` — thin verb layer. `cli.ts` registers commands, one `src/<verb>.ts` per verb, `help-all.ts` for the full listing, `bin.ts` for the refuse-list and entry point. Verbs delegate to the engine rather than holding logic.

Agent-facing skills live in `skills/<name>/` (spawn skills resolved by `agents`). `skills/brownfield` is a Claude Code skill run by the orchestrating agent, not an engine spawn skill, and is intentionally absent from `SkillIdSchema`. Two copies of it exist (repo and `~/.claude/skills/brownfield`); keep parsing rules in sync with the CLI.

Design background: `docs/design/product-engineering-cli.md`.

## Gotchas

- `verificationCommands` and the QA unit command run on the host, outside the sandbox, with secrets stripped from env; they are argv-only (no `a && b`).
- CI: typecheck + tests on ubuntu (bwrap) and windows (Node 22); Windows-Docker and integration suites are named quarantines in root `legionQuarantine`.
- Untracked scratch/artifacts (`scratchpad/`, `.grok-worktrees/`, `isolate-*.log`) are not part of the product.
