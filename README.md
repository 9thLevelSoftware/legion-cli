# Legion CLI

Local-first CLI that turns product knowledge into shipped, verified software.

- **bin:** `legion-cli` (and `legion` as an alias of the same engine binary)
- **package (first `v*` tag):** `@9thlevelsoftware/legion-cli`
- Workspace root npm name is the historical `product-engineer-helper` (`"private": true`). Do not publish the root. Do not rename it.

`@9thlevelsoftware/legion-cli` registers bin `legion` as an **alias** of `legion-cli`. At runtime, `legion install|uninstall|add|remove|update|upgrade|plugin` is refused so those flags stay with the sibling `@9thlevelsoftware/legion` plugin installer (`npx @9thlevelsoftware/legion --claude`). There is no install-time collision check.

v0 bar is **workspace correctness**. Packages are `0.0.0` until the first `v*` tag. This README does **not** claim the CLI is already on npm.

## Requirements

- Node.js 22+
- pnpm 9

## Quick start

Supported invocation: `pnpm exec legion-cli`.

The product is the **10-verb lifecycle core** plus extras in `legion-cli help --all`:

`init` → `intent` → `discuss` → `spec` → `plan` → `execute` → `verify` → `review` → `qa` → `ship`

Init requires `--adapter` (`claude` | `generic` | `fake` | `grok` | `openai` | `codex` | `mimo` | `minimax`). There is no product default. `fake` is test-only (`LEGION_CLI_ADAPTER=fake`). Extra adapters spawn with verified vendor argv (`grok -p`, `codex exec`, `mimo run`, `mcode exec`). Dashboard is a **view-only** board: writes are CLI or token POST; it is not the source of truth.

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
2. `legion-cli brownfield` is the effort-1 audit extra. `--execute` is the only worktree path.

Do not merge these.

Local metrics (never phones home): `legion-cli doctor --metrics`.

## Development

```bash
pnpm typecheck
pnpm test
```

Publish is tag-triggered (`git tag v*`) via GitHub Actions trusted publisher for the `@9thlevelsoftware` npm org, with provenance. Untagged `main` does not publish. There is no long-lived npm token.

See [docs/design/product-engineering-cli.md](docs/design/product-engineering-cli.md) for the product design.
