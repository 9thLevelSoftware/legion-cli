# Legion CLI

Local-first CLI that turns product knowledge into shipped, verified software.

- **bin:** `legion-cli` (and `legion` as an alias of the same engine binary)
- **package (first `v*` tag):** `@9thlevelsoftware/legion-cli`
- Workspace root npm name is the historical `product-engineer-helper` (`"private": true`). Do not publish the root. Do not rename it.

`@9thlevelsoftware/legion-cli` registers bin `legion` as an **alias** of `legion-cli`. At runtime, `legion install|uninstall|add|remove|update|upgrade|plugin` is refused so those flags stay with the sibling `@9thlevelsoftware/legion` plugin installer (`npx @9thlevelsoftware/legion --claude`). legion-ascended workflow-engine verbs this CLI lacks (e.g. `start`, `build`, `explore`) refuse the same way. There is no install-time collision check; `legion-cli doctor` warns when the first `legion` on PATH is another program.

v0 bar is **workspace correctness**. Packages are `0.0.0` until the first `v*` tag. This README does **not** claim the CLI is already on npm. The first release is meant to work without a cloned repo: `@9thlevelsoftware/legion-cli-agents` bundles the repo's `skills/` folder at pack time (`scripts/copy-skills.mjs`, run by `prepack`), and the CLI finds it next to its own `dist/`. `LEGION_CLI_SKILLS_DIR` overrides the location.

## Requirements

- Node.js 22+ (pnpm 9 to build from this repo)
- git (a repo is needed for `ship --commit|--pr`, `brownfield` and the revert step of `execute`)
- One coding-agent CLI you are signed in to (`claude`, `codex`, `grok`, `mimo`, `mcode`, or your own `generic` binary), or the `http` adapter. See "Before you run `execute`".

## Before you run `execute`

`execute` (and `verify`, `review`, `plan`) start your agent CLI and change your working tree. Check these first; `legion-cli doctor` reports most of them.

- **Sandbox.** `execute` refuses unless a hardened sandbox exists (`sandbox.requireHardened`, default on):

  | Platform | Agent during `execute` | `verificationCommands` |
  | --- | --- | --- |
  | Linux with `bwrap` | bwrap jail | bwrap jail |
  | macOS | seatbelt (`sandbox-exec`) | seatbelt |
  | Any OS with a running Docker daemon | Docker, when bwrap/seatbelt are absent | Docker only if you set `sandbox.backend: docker`; `auto` never picks it |
  | Windows without Docker, or Linux without bwrap or Docker | refused; `--allow-no-sandbox` (needs a real terminal and an explicit `y`) accepts the unhardened copy backend | run on the host with your privileges (argv-only, no shell, scrubbed environment); this is not a sandbox |

  The QA unit command (`pnpm test` or `qa.unitCommand`) always runs on the host, not in a sandbox. bwrap and seatbelt do not restrict network egress (the agent needs its model API), and bwrap mounts your agent login files (for example `~/.claude`) read-only; only the Docker backend runs with no network. Do not point `execute` at a repo you do not trust.
- **Credentials.** Only allowlisted variables reach the agent: a base set (`PATH`, `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `TEMP`, `TERM`, ...) plus the adapter's own key: `CLAUDE_API_KEY` (claude), `GROK_API_KEY` / `XAI_API_KEY` (grok), `OPENAI_API_KEY` (codex, openai), `MINIMAX_API_KEY` (minimax); `http` reads the variable named by `adapter.http.apiKeyEnv`. A signed-in subscription (the CLI's own login files) needs no key at all. Legion forwards only the names above, so any other key variable in your shell (for example `ANTHROPIC_API_KEY`) is not passed to the agent; which variable the `claude` binary itself reads is not verified here.
- **Tools.** `gh` for `ship --pr`; Playwright (`pnpm exec playwright`) for full-mode QA with UI criteria; your project's own test command for `verificationCommands` and QA.
- **Hands off** while it runs: see "Hands off while `execute` runs" below.


## Quick start

Supported invocation: `pnpm exec legion-cli`. To type `legion` anywhere, link it once from this repo: `pnpm -r run build`, then `npm link --force` in `packages/cli` (`--force` replaces another tool's `legion` shim; `legion-cli doctor` warns when PATH `legion` is not this CLI).

The product is the **10-verb lifecycle core** plus extras in `legion-cli help --all`:

`init` → `intent` → `discuss` → `spec` → `plan` → `execute` → `verify` → `review` → `qa` → `ship`

Init requires `--adapter` (`claude` | `generic` | `grok` | `openai` | `codex` | `mimo` | `minimax` | `http`; `fake` is also accepted but is for CI and tests only). There is no product default. Extra adapters spawn with verified vendor argv (`grok -p`, `codex exec`, `mimo run`, `mcode exec`). Dashboard is a **view-only** board: writes are CLI or token POST; it is not the source of truth.

verificationCommands and the QA unit command are trusted code run as you, with API keys and tokens removed from the environment (defence in depth, not a sandbox). Where a sandbox exists, `verificationCommands` run inside it (table above); the QA unit command never does. They are argv-only: split `a && b` into separate commands.

**What the gates mean.**
- `verify` is optional walkthrough notes. It is **not** a ship gate and does not re-run anything. The ship gate is: each task's `verificationCommands` passed at `execute`, `review` PASS, and `qa` pass.
- `review` PASS needs evidence: the reviewer exited 0, wrote non-empty notes, and filed no tasks and rewrote no task files. A reviewer that crashes or writes nothing is an error, not a PASS.
- `qa` scores **your repo's own tests**. Tests are tagged by title (`@p0`, `@p1`, `@p2`); untagged tests count as P1, so the P0 bucket is vacuous unless tests carry `@p0`. QA warns (it does not fail) when the spec has P0 acceptance criteria and no test is tagged `@p0`. A runner that times out, is killed or exits non-zero is scored as failed.
- The human gates (`ship`, interactive `qa checklist`, `execute --allow-no-sandbox`) refuse an empty or closed-stdin answer and need an explicit `y`. That stops accidental approval only: a script or agent that supplies a piped `y` (`echo y | legion-cli ship`), or `qa checklist --tick <id>`, still passes them, and the audit log records whether the answer came from a terminal or a pipe. `wiki trust` has no prompt at all: any process running as you can promote a page.

**Hands off while `execute` runs.** `execute` releases `engine.lock` while the agent works (up to 20 minutes) and takes it again afterwards to check what changed. Do not edit the working tree and do not run other legion commands in that time. While an agent run is live, every command that writes (`verify`, `intent`, `discuss`, `spec`, `plan`, `ingest`, `control-mode <mode>`, `ship`, ...) is refused with the run id; `status`, `next`, `doctor` and read-only verbs still work. Legion does not merge concurrent edits: after the run, anything outside the task's `filesAllowed` that differs from the start is reverted, including a change you made yourself. Commit or stash files inside `filesAllowed` first; `execute` warns when the tree is dirty there. Ctrl-C stops the agent too (under the Docker or bwrap sandbox wrapper the container may keep running, but its writes stay in the jail). `skills install` and `design-system install` are not refused. If a run was killed without cleanup (Windows console close, `taskkill`), the next command sees the surviving agent and refuses; `legion-cli doctor` clears a marker whose processes are both gone.

From this repo, with a real adapter (`claude` needs the `claude` binary on PATH and signed in):

```bash
pnpm install
pnpm exec legion-cli init --name Checkin --adapter claude
pnpm exec legion-cli doctor
pnpm exec legion-cli intent
```

`doctor` fails closed until the adapter's binary is on PATH and, for `execute`, a hardened sandbox is available. `intent`, `discuss` and `spec` refuse with "no agent available" when the adapter cannot spawn; they do not fall back to canned text.

`fake` is the CI/test adapter (canned output, no agent). Use it only in tests: `LEGION_CLI_ADAPTER=fake` (PowerShell: `$env:LEGION_CLI_ADAPTER = "fake"`) makes `doctor` treat it as spawnable.

## Shipped verbs not in the 10-verb lifecycle core

See `legion-cli help --all` for the full rows. One sentence each:

- `chat` — REPL that routes into engine verbs (`--once`, `--adapter`, `--fork`).
- `undo` — revert the last completed task or Legion commit. Only the highest-id done task goes back to `todo`; the spec's other done tasks stay done. Undoing a ship commit needs a clean tracked tree and no revert in progress; it moves the phase back to `executing` and marks the ship receipt reverted.
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
