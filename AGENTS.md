# Legion CLI — notes for coding agents

- Product: **Legion CLI**. Binary: **`legion-cli`**. On-disk dir: **`.legion-cli/`**.
- npm org: `@9thlevelsoftware`.
- CLI package: `@9thlevelsoftware/legion-cli` (public, bin `legion-cli`). Workspace packages stay `0.0.0` until the first `v*` tag; do not claim the CLI is already on npm.
- Libraries (shipped): `@9thlevelsoftware/legion-cli-{schema,core,persist,wiki,graph,agents,qa,dashboard,design-system,sandbox,map}`. `@9thlevelsoftware/legion-cli-http` is private / not published.
- Canonical surface: **10-verb lifecycle core** (`init`, `intent`, `discuss`, `spec`, `plan`, `execute`, `verify`, `review`, `qa`, `ship`) + extras in `legion-cli help --all`. Bare `legion-cli` is status + the one next command. The old skeleton (`init` / `status` / `doctor` / `ingest` / `wiki trust` / `search` / `show` / `brief` / `help`) is not the product.
- Task DAG / file-contract queries: `@9thlevelsoftware/legion-cli-graph`. CLI verbs: `plan`, `next`, `ticket create`, `task amend`.
- Review packets (shipped): `packet new` / `packet respond`. PMs/designers file a request and get a packet back. Packets spawn tickets, not execute.
- Closed-work compaction (shipped): `legion-cli context compact`. Manual; lock-held; no auto-compact on ship.
- Workspace **root** is `"private": true`, historical npm name `product-engineer-helper`. Do not publish the root. Do not rename the private root.
- Workspace packages are public under `@9thlevelsoftware`.
- PATH bins: `legion-cli` and `legion` (same `dist/bin.js`). Installer first-args (`--claude` / `--copilot` / `--kiro` / `--uninstall` / other `@9thlevelsoftware/legion` runtime flags, plus `install` / `uninstall` / `add` / `remove` / `update` / `upgrade` / `plugin`) refuse exit 2; plugin installer is `npx @9thlevelsoftware/legion --claude` (bin `legion-plugins`). legion-ascended workflow-engine verbs this CLI lacks (`start`, `explore`, `build`, `approve`, `attest`, `release`, `retro`, `quick`, `advise`, `polish`, `learn`, `milestone`, `validate`, `board`, `council`, `portfolio`, `dev`) also refuse exit 2. Do not add a top-level verb with one of those names without removing it from `bin.ts`. Messages and hints keep saying `legion-cli`.
- Supported invocation: `pnpm exec legion-cli`.
- `init` requires `--adapter` (or a TTY prompt). Two brownfield surfaces (document both; do not merge): (1) `init --mode brownfield` sets `project.mode` and next-command (10-verb `execute` stays **in-place**); (2) `legion-cli brownfield` is the audit bookkeeping extra (effort 1–5; specialists are launched by the orchestrating agent via `skills/brownfield`, not by the engine; `--execute` means per-PR worktrees under `.legion-cli/worktrees/<run>/pr-N/`, the only worktree path). `skills/brownfield/` is a Claude Code skill, not an engine spawn skill: it is not in `SkillIdSchema`.
- Parent verbs `wiki` / `ticket` / `task` / `context` / `run` / `skills` print `requires <sub>` + `Next:` (same pattern as `packet` / `assume`).
- `legion-cli control-mode` is shipped (show / set `guarded|surgical|advisory`; refuse `autonomous`; engine under lock).
- Extra adapters (`grok` / `openai` / `codex` / `mimo` / `minimax`) spawn with **verified vendor argv** (`grok -p`, `codex exec`, `mimo run`, `mcode exec`; `{{pointer}}` required). Nested extra config is `.strict()`. AdapterId `http` is detect-only (`init` may persist `adapter.http`; CLI `--adapter http` and lifecycle spawn refuse). No HTTP completions client. Spawn CLIs remain the default.
- Node 22+, ESM, pnpm workspaces (`packageManager: pnpm@9`).
- CI: typecheck + test. Publish: git tag `v*` only; GitHub Actions trusted publisher; `pnpm publish -r --access public` with provenance. No publish from untagged main. No long-lived npm token.
