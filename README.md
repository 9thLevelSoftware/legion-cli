# Legion CLI

Local-first CLI that turns product knowledge into shipped, verified software.

- **npm:** [`@9thlevelsoftware/legion-cli`](https://www.npmjs.com/package/@9thlevelsoftware/legion-cli)
- **bin:** `legion-cli` only

This engine does **not** take bin `legion`. That belongs to the sibling [`@9thlevelsoftware/legion`](https://www.npmjs.com/package/@9thlevelsoftware/legion) plugin installer (`npx @9thlevelsoftware/legion --claude`).

## Requirements

- Node.js 22+
- pnpm 9

## Quick start

Supported invocation: `pnpm exec legion-cli` or `npx @9thlevelsoftware/legion-cli`.

Init requires `--adapter` (`claude` | `generic` | `fake`). There is no product default. Dashboard is a **viewer**: `legion-cli dashboard`.

From this repo:

```bash
pnpm install
pnpm exec legion-cli init --name Checkin --adapter fake
pnpm exec legion-cli status
LEGION_CLI_ADAPTER=fake pnpm exec legion-cli doctor
pnpm exec legion-cli dashboard --no-open
```

From npm:

```bash
npx @9thlevelsoftware/legion-cli init --name Checkin --adapter claude
# or
npm i -g @9thlevelsoftware/legion-cli
legion-cli init --name Checkin --adapter claude
```

`fake` is the test adapter; `doctor` treats it as spawnable only when `LEGION_CLI_ADAPTER=fake`. For `claude` or `generic`, doctor fails closed until that binary is on PATH. Brownfield `init` is v1.

Local metrics (never phones home): `legion-cli doctor --metrics`.

## Development

```bash
pnpm typecheck
pnpm test
```

Publish is tag-triggered (`git tag v*`) via GitHub Actions trusted publisher for the `@9thlevelsoftware` npm org, with provenance. Untagged `main` does not publish. There is no long-lived npm token.

See [docs/design/product-engineering-cli.md](docs/design/product-engineering-cli.md) for the product design.
