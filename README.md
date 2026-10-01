# Legion CLI

Local-first CLI that turns product knowledge into shipped, verified software.

- **bin:** `legion-cli` (and `legion` as an alias of the same engine binary)
- **package (first `v*` tag):** `@9thlevelsoftware/legion-cli`
- Workspace root npm name is the historical `product-engineer-helper` (`"private": true`). Do not publish the root. Do not rename it.

`@9thlevelsoftware/legion-cli` registers bin `legion` as an **alias** of `legion-cli`. At runtime, `legion install|uninstall|add|remove|update|upgrade|plugin` is refused so those flags stay with the sibling `@9thlevelsoftware/legion` plugin installer (`npx @9thlevelsoftware/legion --claude`). legion-ascended workflow-engine verbs this CLI lacks (e.g. `start`, `build`, `explore`) refuse the same way. There is no install-time collision check; `legion-cli doctor` warns when the first `legion` on PATH is another program.

v0 bar is **workspace correctness**. Packages are `0.0.0` until the first `v*` tag. This README does **not** claim the CLI is already on npm.

## Requirements

- Node.js 22+
- pnpm 9

## Reliability and governed enhancements

Interactive init uses a numbered adapter selection with explanations. Init checks
the selected adapter's local configuration/PATH and sandbox readiness, then shows
remediation instructions; it does not contact a provider. Under `--json`, prompts
and progress go to stderr and one-shot commands return one JSON document.
Interactive chat uses JSON Lines and includes fork metadata and proposals awaiting
confirmation. The dashboard follows state/audit SSE events, displays connection
freshness and offers manual refresh when updates are unavailable.

QA reports link tests to SPEC acceptance criteria with title tags such as
`@ac(AC-01) @ac(AC-02)`. Criterion priorities come from the SPEC. Untagged passing
tests cannot cover an acceptance criterion; missing/skipped P0 evidence blocks
shipping. QA v2 preserves reports per run and binds scores to the SPEC and source
tested. Recalculate historical v1 scores before a new ship, and rerun QA after
source changes. The 85-point bar, visual gate and explicit degraded no-browser
workflow remain in effect.

Status and the dashboard expose interrupted run stages, ownership and recovery
guidance. Compatible interrupted HTTP jobs use `execute --resume <runId>` with
their original jail. Completed tools are not replayed. Recovery refuses changed
source, configuration, contracts or jail identities, and uncertain command or
external-call outcomes require operator reconciliation.

Useful scoped invocations:

```bash
pnpm exec legion-cli help spec approve
pnpm exec legion-cli status --project ./product --json
pnpm exec legion-cli search "authentication" --limit 10 --project ./product --json
pnpm exec legion-cli brief --project ./product --json
pnpm exec legion-cli execute --until-blocked --jobs 2 --project ./product
pnpm exec legion-cli skills list --project ./product
pnpm exec legion-cli skills show extension:accessibility --project ./product
pnpm exec legion-cli skills run extension:release-readiness --project ./product
```

Parallel execution is explicit: `execution.maxWorkers` defaults to **1**, supports
**1–4**, and applies only to automatic `--until-blocked` execution. Tasks must be
dependency-independent with disjoint contracts. Workers use separate sandbox
jails and outputs are integrated serially with source-baseline checks. Explicit
task IDs stay single-task. Brownfield `--execute` retains its separate
`.legion-cli/worktrees/<run>/pr-N/` layout.

Named `adapter.profiles`, skill profile routes and task profiles can select
supported model arguments, output limits and operator-supplied pricing.
`--adapter` and `--profile` are mutually exclusive. Explicit CLI selection wins,
then task selection, skill routing and the existing default. Usage stays unknown
when an adapter cannot report it. Token/cost thresholds use reported values;
estimated costs are not guaranteed spending caps. Budgets are unset and telemetry
export is disabled by default. Optional OTLP export goes to a loopback collector
and excludes source, prompts, credentials and paths.

Extension packs have separate `extension:<id>` references, integrity pins,
manifests and permission contracts. Accessibility, performance, migration/rollback
and release-readiness jobs produce evidence and tickets for proposed product
changes. Unavailable checks remain unavailable, rather than passing. Extension
execution requires a configured HTTP adapter/profile so the engine can
enforce exact tool and command permissions. Spawn-only adapters are refused for
these jobs. Packaged agents include core skills and extensions; design-system packages include craft
resources. Explicit resource directory overrides take precedence over checkout
and package-local discovery.

Remote MCP configuration selects stdio, SSE or Streamable HTTP with
transport-specific fields and environment-referenced authentication. Governed
HTTP jobs start with an empty exact tool allowlist; only explicitly configured
read-only tools are eligible. Inbound MCP and MCP Apps remain read-only.

ACP and hybrid vector retrieval are experimental and disabled by default. Their
fixture/benchmark evidence and opt-in smoke instructions live under
[`docs/experiments`](docs/experiments). Real-provider, real-agent, embedding-quality
and platform results are reported separately from deterministic checks.

`pnpm smoke:consumer` packs only allowlisted packages and installs them in a clean
consumer without workspace links. The complete lifecycle regression covers human
approval, contracted execution, review, AC-linked QA and ship. CI requires
Linux/native, Linux/Docker, Windows/native and macOS sandbox checks. The opt-in
Windows/Docker workflow needs a self-hosted `legion-docker` runner; `Q-WIN-DOCKER`
remains open until it supplies passing evidence. Packages remain `0.0.0`; no
publishing is performed by these checks.

## Quick start

Supported invocation: `pnpm exec legion-cli`. To type `legion` anywhere, link it once from this repo: `pnpm -r run build`, then `npm link --force` in `packages/cli` (`--force` replaces another tool's `legion` shim; `legion-cli doctor` warns when PATH `legion` is not this CLI).

The product is the **10-verb lifecycle core** plus extras in `legion-cli help --all`:

`init` → `intent` → `discuss` → `spec` → `plan` → `execute` → `verify` → `review` → `qa` → `ship`

Init requires `--adapter` (`claude` | `generic` | `fake` | `grok` | `openai` | `codex` | `mimo` | `minimax` | `http`). There is no product default. `fake` is test-only. Extra adapters spawn with verified vendor argv (`grok -p`, `codex exec`, `mimo run`, `mcode exec`). Dashboard is a **view-only** board: writes are CLI or token POST; it is not the source of truth.

verificationCommands and the QA unit command are trusted code run on your machine, outside the sandbox, with API keys and tokens removed from the environment. They are argv-only: split `a && b` into separate commands.

From this repo:

```bash
pnpm install
pnpm exec legion-cli init --name Checkin --adapter fake
pnpm exec legion-cli status
LEGION_CLI_ADAPTER=fake pnpm exec legion-cli doctor
pnpm exec legion-cli intent
```

Windows PowerShell: set env vars with `$env:` (the bash prefix above is not a cmdlet):

```powershell
pnpm install
pnpm exec legion-cli init --name Checkin --adapter fake
pnpm exec legion-cli status
$env:LEGION_CLI_ADAPTER = "fake"; pnpm exec legion-cli doctor
pnpm exec legion-cli intent
```

`fake` is the test adapter; `doctor` treats it as spawnable only when `LEGION_CLI_ADAPTER=fake`. For `claude` or `generic`, doctor fails closed until that binary is on PATH.

## Shipped verbs not in the 10-verb lifecycle core

See `legion-cli help --all` for the full rows. One sentence each:

- `chat` — REPL that routes into engine verbs (`--once`, `--adapter`, `--fork`).
- `undo` — revert the last completed task or Legion commit.
- `recipe list` / `recipe run` — workflow recipes from `.legion-cli/recipes/*.yaml`.
- `repl` — host-mode interactive REPL (NO SANDBOX).
- `serve` / `dashboard` — local board; writes are CLI or token-gated POST (`ticket|wikiTrust|qaChecklist`).
- `map` — architecture markdown, fingerprints, optional LSP diagnostics.
- `wireframe` — regenerate HTML wireframes after spec edits.
- `skills list|show|install` — packaged catalog and pinned overlays.
- `design-system show|install|import-od|generate` — local or `github:owner/repo@tag`.
- `control-mode` — show or set `guarded|advisory` (refuses `autonomous`; `surgical` is removed — migrate to `guarded`).
- `brownfield …` — effort 1–5 audit bookkeeping (separate from `init --mode brownfield`).
- `context compact` — manual compaction of done tasks.
- `garden` — stale wiki, orphans, duplicates.
- `packet new|respond` — PM/designer packets that spawn tickets, not execute.

JSON schemas for chat sessions/actions, fingerprint files, and serve files live in `packages/schema/json/`.

## Two brownfield surfaces (not one verb)

1. `init --mode brownfield` sets `project.mode` and the next command (`legion-cli brownfield`). After that, 10-verb `execute` is **in-place**.
2. `legion-cli brownfield` is the audit extra (effort 1–5). The orchestrating agent (the `skills/brownfield` Claude Code skill) does the judgment: it launches specialists, the design writer and reviewers, and implementers. The CLI keeps the books under `.legion-cli/runs/<id>/` (gitignored): `init`, `state`, `roster`, `evidence`, `merge`, `review-status`, `pr-plan`, `dag`, `worktree`, `patterns`. `--execute` is the only worktree path: one worktree per reviewed PR under `.legion-cli/worktrees/<run>/pr-N/`, stacked on its dependency's branch. `legion-cli run promote <id>` copies the run's pages into the wiki (untrusted until `wiki trust`).

Do not merge these.

Local metrics (never phones home): `legion-cli doctor --metrics`.

## Development

```bash
pnpm typecheck
pnpm test
```

Publish is tag-triggered (`git tag v*`) via GitHub Actions trusted publisher for the `@9thlevelsoftware` npm org, with provenance. Untagged `main` does not publish. There is no long-lived npm token.

See [docs/design/product-engineering-cli.md](docs/design/product-engineering-cli.md) for the product design.
