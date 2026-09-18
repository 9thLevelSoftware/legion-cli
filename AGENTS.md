# Legion CLI — notes for coding agents

- Product: **Legion CLI**. Binary: **`legion-cli`**. On-disk dir: **`.legion-cli/`**.
- npm org: `@9thlevelsoftware`.
- CLI package: `@9thlevelsoftware/legion-cli` (public, bin `legion-cli`). Workspace packages stay `0.0.0` until the first `v*` tag; do not claim the CLI is already on npm.
- Libraries (shipped): `@9thlevelsoftware/legion-cli-{schema,core,persist,wiki,graph,agents,qa,dashboard,design-system}`.
- Canonical surface: **10-verb lifecycle core** (`init`, `intent`, `discuss`, `spec`, `plan`, `execute`, `verify`, `review`, `qa`, `ship`) + extras in `legion-cli help --all`. Bare `legion-cli` is status + the one next command. The old skeleton (`init` / `status` / `doctor` / `ingest` / `wiki trust` / `search` / `show` / `brief` / `help`) is not the product.
- Task DAG / file-contract queries: `@9thlevelsoftware/legion-cli-graph`. CLI verbs: `plan`, `next`, `ticket create`, `task amend`.
- Review packets (shipped): `packet new` / `packet respond`. PMs/designers file a request and get a packet back. Packets spawn tickets, not execute.
- Closed-work compaction (shipped): `legion-cli context compact`. Manual; lock-held; no auto-compact on ship.
- Workspace **root** is `"private": true`, historical npm name `product-engineer-helper`. Do not publish the root. Do not rename the private root.
- Workspace packages are public under `@9thlevelsoftware`.
- PATH bins: `legion-cli` and `legion` (same `dist/bin.js`). Installer first-args (`--claude` / `--copilot` / `--kiro` / `--uninstall` / other `@9thlevelsoftware/legion` runtime flags, plus `install` / `uninstall` / `add` / `remove` / `update` / `upgrade` / `plugin`) refuse exit 2; plugin installer is `npx @9thlevelsoftware/legion --claude` (bin `legion-plugins`).
- Supported invocation: `pnpm exec legion-cli`.
- `init` requires `--adapter` (or a TTY prompt). Two brownfield surfaces (document both; do not merge): (1) `init --mode brownfield` sets `project.mode` and next-command (10-verb `execute` stays **in-place**); (2) `legion-cli brownfield` is the effort-1 audit extra (`--execute` is the only worktree path).
- Parent verbs `wiki` / `ticket` / `task` / `context` / `run` print `requires <sub>` + `Next:` (same pattern as `packet` / `assume`).
- `legion-cli control-mode` is shipped (show / set `guarded|surgical|advisory`; refuse `autonomous`; engine under lock).
- Extra adapters (`grok` / `openai` / `codex` / `mimo` / `minimax`) spawn with **verified vendor argv** (`grok -p`, `codex exec`, `mimo run`, `mcode exec`; `{{pointer}}` required). Nested extra config is `.strict()`. No HTTP completions client.
- Node 22+, ESM, pnpm workspaces (`packageManager: pnpm@9`).
- CI: typecheck + test. Publish: git tag `v*` only; GitHub Actions trusted publisher; `pnpm publish -r --access public` with provenance. No publish from untagged main. No long-lived npm token.
