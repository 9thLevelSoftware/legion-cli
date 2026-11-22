# @9thlevelsoftware/legion-cli

Local-first product-engineering lifecycle CLI that turns product knowledge into verified, reviewed software.

- **Binaries:** `legion-cli` (and `legion` as an alias of the same binary)
- **Package:** `@9thlevelsoftware/legion-cli` (workspace packages remain `0.0.0` until tagged `v*` release)
- **Plugin installer separation:** Installer flags (`--claude`, `--copilot`, `--kiro`, `--uninstall`, `install`, `uninstall`, `add`, `remove`, `update`, `upgrade`, `plugin`) belong to the sibling `@9thlevelsoftware/legion` plugin installer (`npx @9thlevelsoftware/legion --claude`, bin `legion-plugins`) and are refused by `legion-cli` / `legion`.

## Requirements

- **Node.js `>= 22`**
- **git** (used by `ship --commit|--pr`, `brownfield`, and `execute` out-of-contract revert)
- One configured coding-agent adapter (or OpenAI-compatible HTTP endpoint)

## Canonical Workflow

Legion CLI guides projects through five lifecycle stages:

```text
init → spec → plan → execute → ship
```

1. **`init`** — Configure an adapter (`--adapter <id>`) and start a greenfield or brownfield (`--mode brownfield --brownfield-goal change|audit`) project. Writes `.legion-cli/` state with `workflow.profile: focused`.
2. **`spec`** — Capture intent, investigate context, discuss consequential choices, run one bounded challenge pass (0–3 grounded concerns), and produce the feature contract. Freeze with `legion-cli spec approve`.
3. **`plan`** — Break the approved contract into bounded tasks with exclusive file contracts, planned verification checks, and acceptance criteria. Bind with `legion-cli plan approve --check "<command>"`.
4. **`execute`** — Run ready tasks inside a hardened sandbox (`bwrap` on Linux, `seatbelt` on macOS, or offline Docker where applicable; `--allow-no-sandbox` requires interactive TTY confirmation), run approved checks, and perform independent review (`--step`, `<taskId>`, `--retry`, `--resume <runId>`, or `--until-blocked --jobs 1-4`).
5. **`ship`** — Present check, review, and `plan acceptance` evidence for explicit human delivery approval (`--commit`, `--pr`, `--bundle <dir>`).

Run bare `legion-cli` to view current status and the single recommended next command, or `legion-cli help --all` for advanced inspection and recovery commands (`status`, `doctor`, `ingest`, `search`, `show`, `map`, `serve`, `dashboard`, `skills`, `design-system`, `brownfield`, `undo`).

## Adapter Options

`init` requires `--adapter` (or interactive TTY selection):

- **Spawn CLIs:** `claude`, `codex`, `openai` (alias for `codex`), `grok`, `mimo`, `minimax` (`mcode`), or `generic` (`--generic-binary`, `--generic-args`)
- **HTTP:** `http` (`--http-base-url`, `--http-model`, `--http-api-key-env`, `--http-allow-loopback`) — OpenAI-compatible API with environment-variable API key references and SSRF-bounded configuration
- **Experimental:** `acp` (`--acp-command`, `--acp-args`)
- **CI / test fixture only:** `fake`

## Documentation

- [Repository README](https://github.com/9thLevelSoftware/legion-cli/blob/main/README.md)
- [Focused Workflow Design](https://github.com/9thLevelSoftware/legion-cli/blob/main/docs/design/workflow-focus.md)
- [Assurance Integration](https://github.com/9thLevelSoftware/legion-cli/blob/main/docs/design/assurance-integration.md)
- [Adapter Routing](https://github.com/9thLevelSoftware/legion-cli/blob/main/docs/design/adapter-routing.md)
- [Extensions & Component Validators](https://github.com/9thLevelSoftware/legion-cli/blob/main/docs/extensions.md)

## License

MIT — see [LICENSE](https://github.com/9thLevelSoftware/legion-cli/blob/main/LICENSE).
