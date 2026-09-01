# Legion CLI

Local-first CLI that turns product knowledge into shipped, verified software.

- **npm:** [`@9thlevelsoftware/legion-cli`](https://www.npmjs.com/package/@9thlevelsoftware/legion-cli)
- **bin:** `legion-cli`

This is **not** the [`@9thlevelsoftware/legion`](https://www.npmjs.com/package/@9thlevelsoftware/legion) plugin installer (`npx @9thlevelsoftware/legion --claude`, bin `legion`). They are sibling products. This engine does not register the `legion` bin.

## Requirements

- Node.js 22+
- pnpm 9

## Quick start (this repo)

```bash
pnpm install
pnpm exec legion-cli init --name Checkin --adapter fake
pnpm exec legion-cli status
pnpm exec legion-cli doctor
```

`adapter.default` is required (`--adapter claude|generic|fake`, or a prompt). Brownfield `init` is v1. Supported invocation: `pnpm exec legion-cli`. This package does not register bin `legion`.

## Install from npm

```bash
npx @9thlevelsoftware/legion-cli
# or
npm i -g @9thlevelsoftware/legion-cli
```

## Development

```bash
pnpm typecheck
pnpm test
```

Publish is tag-triggered (`git tag v*`) via GitHub Actions trusted publisher for the `@9thlevelsoftware` npm org, with provenance. Untagged `main` does not publish. There is no long-lived npm token.

See [docs/design/product-engineering-cli.md](docs/design/product-engineering-cli.md) for the product design.
