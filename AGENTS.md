# Legion CLI — notes for coding agents

- Product: **Legion CLI**. Binary: **`legion-cli`**. On-disk dir: **`.legion-cli/`**.
- npm org: `@9thlevelsoftware`.
- CLI package: `@9thlevelsoftware/legion-cli` (public, bin `legion-cli`).
- Libraries (later PRs): `@9thlevelsoftware/legion-cli-{schema,core,persist,wiki,graph,agents,qa,dashboard}`.
- Workspace **root** is `"private": true`. Do not publish the root.
- Workspace packages are public under `@9thlevelsoftware`.
- **Do not register bin `legion`.** That belongs to `@9thlevelsoftware/legion` (plugin installer).
- Supported invocation: `pnpm exec legion-cli`.
- Until `init` exists, the stub prints `uninitialized` and exits 0.
- Node 22+, ESM, pnpm workspaces (`packageManager: pnpm@9`).
- CI: typecheck + test. Publish: git tag `v*` only; GitHub Actions trusted publisher; `pnpm publish -r --access public` with provenance. No publish from untagged main. No long-lived npm token.
