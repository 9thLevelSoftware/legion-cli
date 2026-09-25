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
