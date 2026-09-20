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

Init requires `--adapter` (`claude` | `generic` | `fake` | `grok` | `openai` | `codex` | `mimo` | `minimax`). There is no product default. `fake` is test-only (`LEGION_CLI_ADAPTER=fake`). Extra adapters spawn with verified vendor argv (`grok -p`, `codex exec`, `mimo run`, `mcode exec`). Dashboard is a **view-only** board: writes are CLI or token POST; it is not the source of truth.

verificationCommands and the QA unit command are trusted code run on your machine, outside the sandbox, with API keys and tokens removed from the environment. They are argv-only: split `a && b` into separate commands.

### Your files are quarantined, never deleted

After every agent run Legion compares your project by **content** and puts back anything the agent changed outside its contract — including files git never sees, like a gitignored `.env` or a local `dev.sqlite`. The agent's version is **moved to a quarantine folder outside the project**, never deleted: `<user state dir>/quarantine/<project>/<run>-<random>/`, with a `MANIFEST.json` listing every displaced path. Legion never removes that folder; `legion-cli doctor` lists what is retained and flags a manifest that no longer matches its audited hash.

Two consequences worth knowing:

- **A run cannot tell who typed.** If you edit a file yourself while a run is live, that edit is quarantined and reverted too. Finish the run first.
- **If the agent commits, Legion does not un-commit for you.** The working tree is restored, the commit shas are recorded in `STATE.quarantinedCommits` and kept reachable under `refs/legion-quarantine/<run>`, the task is blocked, and the one command that undoes the ref movement (`git reset <ref>` or `git checkout <branch>`) is printed. `legion-cli ship` remains the human commit gate.

Build output is left alone: new files in gitignored directories (`dist/`, `coverage/`, an installed `node_modules`) are reported as warnings, not reverted. The exception is secret-like names (`.env*`), which are always quarantined.

From this repo:

```bash
pnpm install
pnpm exec legion-cli init --name Checkin --adapter fake
pnpm exec legion-cli status
LEGION_CLI_ADAPTER=fake pnpm exec legion-cli doctor
pnpm exec legion-cli intent
```

`fake` is the test adapter; `doctor` treats it as spawnable only when `LEGION_CLI_ADAPTER=fake`. For `claude` or `generic`, doctor fails closed until that binary is on PATH.

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
