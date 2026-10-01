# Legion CLI

Local-first CLI that turns product knowledge into shipped, verified software.

- **bin:** `legion-cli` (and `legion` as an alias of the same engine binary)
- **package (first `v*` tag):** `@9thlevelsoftware/legion-cli`
- Workspace root npm name is the historical `product-engineer-helper` (`"private": true`). Do not publish the root. Do not rename it.

`@9thlevelsoftware/legion-cli` registers bin `legion` as an **alias** of `legion-cli`. At runtime, `legion install|uninstall|add|remove|update|upgrade|plugin` is refused so those flags stay with the sibling `@9thlevelsoftware/legion` plugin installer (`npx @9thlevelsoftware/legion --claude`). legion-ascended workflow-engine verbs this CLI lacks (e.g. `start`, `build`, `explore`) refuse the same way. There is no install-time collision check; `legion-cli doctor` warns when the first `legion` on PATH is another program.

v0 bar is **workspace correctness**. Packages are `0.0.0` until the first `v*` tag. This README does **not** claim the CLI is already on npm. The first release is meant to work without a cloned repo: `@9thlevelsoftware/legion-cli-agents` bundles the repo's `skills/` folder at pack time (`scripts/copy-skills.mjs`, run by `prepack`), and the CLI finds it next to its own `dist/`. `LEGION_CLI_SKILLS_DIR` overrides the location; otherwise the bundled copy wins over any `skills/` folder in your project or its parents, and per-project changes go in `.legion-cli/skills/<id>` overlays.

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
  | Any OS with a running Docker daemon | Docker, when bwrap/seatbelt are absent, **for offline agents only** (no network, no login files; see below) | Docker only if you set `sandbox.backend: docker`; `auto` never picks it |
  | Windows without Docker, or Linux without bwrap or Docker | refused; `--allow-no-sandbox` (needs a real terminal; piped stdin is refused) accepts the unhardened copy backend | run on the host with your privileges (argv-only, no shell, scrubbed environment); this is not a sandbox |

  The QA unit command (`pnpm test` or `qa.unitCommand`) always runs on the host, not in a sandbox. bwrap and seatbelt do not restrict network egress (the agent needs its model API), and bwrap mounts your agent login files (for example `~/.claude`) read-only; the Docker backend runs with no network and no login files. Do not point `execute` at a repo you do not trust.

  **Docker and vendor agents.** The Docker backend runs the agent in a `node:22-alpine` container with `--network none`, a read-only root and no home directory. Vendor CLIs (`claude`, `codex`, `grok`, `mimo`, `mcode`) are host binaries that need their model API and login, so they do **not** work under Docker `execute`; only an offline agent that runs as a Node script (for example a `generic` adapter calling `node`) does. On Windows, a networked vendor agent therefore runs `execute` only with `--allow-no-sandbox` (unhardened copy backend), or on Linux/macOS with bwrap/seatbelt. No other workaround is provided.
- **Credentials.** Only allowlisted variables reach the agent: a base set (`PATH`, `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `TEMP`, `TERM`, ...) plus the adapter's own key: `CLAUDE_API_KEY` (claude), `GROK_API_KEY` / `XAI_API_KEY` (grok), `OPENAI_API_KEY` (codex, openai), `MINIMAX_API_KEY` (minimax); `http` reads the variable named by `adapter.http.apiKeyEnv`. A signed-in subscription (the CLI's own login files) needs no key at all, but those login files are visible to the agent only under bwrap, seatbelt or the copy backend, not under Docker. Legion forwards only the names above, so any other key variable in your shell (for example `ANTHROPIC_API_KEY`) is not passed to the agent; which variable the `claude` binary itself reads is not verified here.
- **Tools.** `gh` for `ship --pr`; Playwright (`pnpm exec playwright`) for full-mode QA with UI criteria; your project's own test command for `verificationCommands` and QA.
- **Hands off** while it runs: see "Hands off while `execute` runs" below.


## Reliability and governed enhancements

Interactive init uses a numbered adapter selection with explanations. Init checks
the selected adapter's local configuration/PATH and sandbox readiness, then shows
remediation instructions; it does not contact a provider. Under `--json`, prompts
and progress go to stderr and one-shot commands return one JSON document.
Interactive chat uses JSON Lines and includes fork metadata and proposals awaiting
confirmation. The dashboard follows state/audit SSE events, displays connection
freshness and offers manual refresh when updates are unavailable.

QA reports link tests to SPEC acceptance criteria with title tags such as
`@ac(AC-01) @ac(AC-02)`. Criterion priorities come from the SPEC. Untagged passing
tests cannot cover an acceptance criterion; missing/skipped P0 evidence blocks
shipping. QA v2 preserves reports per run and binds scores to the SPEC and source
tested. Recalculate historical v1 scores before a new ship, and rerun QA after
source changes. The 85-point bar, visual gate and explicit degraded no-browser
workflow remain in effect.

Status and the dashboard expose interrupted run stages, ownership and recovery
guidance. Compatible interrupted HTTP jobs use `execute --resume <runId>` with
their original jail. Completed tools are not replayed. Recovery refuses changed
source, configuration, contracts or jail identities, and uncertain command or
external-call outcomes require operator reconciliation.

Useful scoped invocations:

```bash
pnpm exec legion-cli help spec approve
pnpm exec legion-cli status --project ./product --json
pnpm exec legion-cli search "authentication" --limit 10 --project ./product --json
pnpm exec legion-cli brief --project ./product --json
pnpm exec legion-cli execute --until-blocked --jobs 2 --project ./product
pnpm exec legion-cli skills list --project ./product
pnpm exec legion-cli skills show extension:accessibility --project ./product
pnpm exec legion-cli skills run extension:release-readiness --project ./product
```

Parallel execution is explicit: `execution.maxWorkers` defaults to **1**, supports
**1–4**, and applies only to automatic `--until-blocked` execution. Tasks must be
dependency-independent with disjoint contracts. Workers use separate sandbox
jails and outputs are integrated serially with source-baseline checks. Explicit
task IDs stay single-task. Brownfield `--execute` retains its separate
`.legion-cli/worktrees/<run>/pr-N/` layout.

Named `adapter.profiles`, skill profile routes and task profiles can select
supported model arguments, output limits and operator-supplied pricing.
`--adapter` and `--profile` are mutually exclusive. Explicit CLI selection wins,
then task selection, skill routing and the existing default. Usage stays unknown
when an adapter cannot report it. Token/cost thresholds use reported values;
estimated costs are not guaranteed spending caps. Budgets are unset and telemetry
export is disabled by default. Optional OTLP export goes to a loopback collector
and excludes source, prompts, credentials and paths.

Extension packs have separate `extension:<id>` references, integrity pins,
manifests and permission contracts. Accessibility, performance, migration/rollback
and release-readiness jobs produce evidence and tickets for proposed product
changes. Unavailable checks remain unavailable, rather than passing. Extension
execution requires a configured HTTP adapter/profile so the engine can
enforce exact tool and command permissions. Spawn-only adapters are refused for
these jobs. Packaged agents include core skills and extensions; design-system packages include craft
resources. Explicit resource directory overrides take precedence over checkout
and package-local discovery.

Remote MCP configuration selects stdio, SSE or Streamable HTTP with
transport-specific fields and environment-referenced authentication. Governed
HTTP jobs start with an empty exact tool allowlist; only explicitly configured
read-only tools are eligible. Inbound MCP and MCP Apps remain read-only.

ACP and hybrid vector retrieval are experimental and disabled by default. Their
fixture/benchmark evidence and opt-in smoke instructions live under
[`docs/experiments`](docs/experiments). Real-provider, real-agent, embedding-quality
and platform results are reported separately from deterministic checks.

`pnpm smoke:consumer` packs only allowlisted packages and installs them in a clean
consumer without workspace links. The complete lifecycle regression covers human
approval, contracted execution, review, AC-linked QA and ship. CI requires
Linux/native, Linux/Docker, Windows/native and macOS sandbox checks. The opt-in
Windows/Docker workflow needs a self-hosted `legion-docker` runner; `Q-WIN-DOCKER`
remains open until it supplies passing evidence. Packages remain `0.0.0`; no
publishing is performed by these checks.

## Quick start

Supported invocation: `pnpm exec legion-cli`. To type `legion` anywhere, link it once from this repo: `pnpm -r run build`, then `npm link --force` in `packages/cli` (`--force` replaces another tool's `legion` shim; `legion-cli doctor` warns when PATH `legion` is not this CLI).

The product is the **10-verb lifecycle core** plus extras in `legion-cli help --all`:

`init` → `intent` → `discuss` → `spec` → `plan` → `execute` → `verify` → `review` → `qa` → `ship`

Init requires `--adapter` (`claude` | `generic` | `grok` | `openai` | `codex` | `mimo` | `minimax` | `http` | `acp` (experimental); `fake` is also accepted but is for CI and tests only). There is no product default. Extra adapters spawn with verified vendor argv (`grok -p`, `codex exec`, `mimo run`, `mcode exec`). Dashboard is a **view-only** board: writes are CLI or token POST; it is not the source of truth.

verificationCommands and the QA unit command are trusted code run as you, with API keys and tokens removed from the environment (defence in depth, not a sandbox). Where a sandbox exists, `verificationCommands` run inside it (table above); the QA unit command never does. They are argv-only: split `a && b` into separate commands.

**What the gates mean.**
- `verify` is an optional agent walkthrough. It is **not** a ship gate and does not re-run anything. Its notes are **not kept today**: `.legion-cli/qa/**` is engine-owned and restored after every agent run (open item; `review` does not have this problem because its notes go through the run cache). The ship gate is: each task's `verificationCommands` passed at `execute`, `review` PASS, and `qa` pass.
- `review` PASS needs evidence: the reviewer exited 0, wrote non-empty notes, and filed no tasks and rewrote no task files. A reviewer that crashes or writes nothing is an error, not a PASS.
- `qa` links tests to declared SPEC criteria using `@ac(<id>)` title tags. Untagged tests provide no acceptance coverage; missing/skipped P0 evidence fails the gate. A runner that times out, is killed or exits non-zero is blocking evidence.
- `ship` and the interactive `qa checklist` refuse an empty or closed-stdin answer and need an explicit `y` (`n` or a blank for a `qa checklist` criterion is a refusal). That stops accidental approval only: a script or agent that supplies a piped `y` (`echo y | legion-cli ship`), or `qa checklist --tick <id>`, still passes them, and the audit log records whether the answer came from a terminal or a pipe. `execute --allow-no-sandbox` is stricter: it refuses any non-terminal stdin (a program driving a pseudo-terminal could still answer). `wiki trust` has no prompt at all: any process running as you can promote a page.

**Hands off while `execute` runs.** `execute` releases `engine.lock` while the agent works (up to 20 minutes) and takes it again afterwards to check what changed. Do not edit the working tree and do not run other legion commands in that time. While an agent run is live, every command that writes (`verify`, `intent`, `discuss`, `spec`, `plan`, `ingest`, `control-mode <mode>`, `ship`, ...) is refused with the run id; `status`, `next`, `doctor` and read-only verbs still work. Legion does not merge concurrent edits: after the run, anything outside the task's `filesAllowed` that differs from the start is reverted, including a change you made yourself. Commit or stash files inside `filesAllowed` first; `execute` warns when the tree is dirty there. Ctrl-C stops the agent too (under the Docker or bwrap sandbox wrapper the container may keep running, but its writes stay in the jail). `skills install` and `design-system install` are not refused. If a run was killed without cleanup (Windows console close, `taskkill`), the next command sees the surviving agent and refuses; `legion-cli doctor` clears a marker whose processes are both gone.

From this repo, with a real adapter (`claude` needs the `claude` binary on PATH and signed in):

```bash
pnpm install
pnpm exec legion-cli init --name Checkin --adapter claude
pnpm exec legion-cli doctor
pnpm exec legion-cli intent
```

`doctor` fails closed until the adapter's binary is on PATH; it only warns when no hardened sandbox is available, and `execute` is what then refuses (unless `--allow-no-sandbox` on a TTY or `sandbox.allowCopyJail`). `intent`, `discuss` and `spec` refuse with "no agent available" when the adapter cannot spawn; they do not fall back to canned text.

`fake` is the CI/test adapter (canned output, no agent). Use it only in tests: `LEGION_CLI_ADAPTER=fake` (PowerShell: `$env:LEGION_CLI_ADAPTER = "fake"`) makes `doctor` treat it as spawnable.

## Shipped verbs not in the 10-verb lifecycle core

See `legion-cli help --all` for the full rows. One sentence each:

- `chat` — REPL that routes into engine verbs (`--once`, `--adapter`, `--fork`).
- `undo` — revert the last completed task or Legion commit. Only the highest-id done task goes back to `todo`; the spec's other done tasks stay done. Undoing a ship commit needs a clean tracked tree (pending audit-log appends don't count) and no revert in progress; it moves the phase back to `executing` and marks the ship receipt reverted, unless the reverted commit's parent records an earlier ship of another spec, which is left standing.
- `recipe list` / `recipe run` — workflow recipes from `.legion-cli/recipes/*.yaml`.
- `repl` — host-mode interactive REPL (NO SANDBOX).
- `serve` / `dashboard` — local board; writes are CLI or token-gated POST (`ticket|wikiTrust|qaChecklist`).
- `map` — architecture markdown, fingerprints, optional LSP diagnostics.
- `wireframe` — regenerate HTML wireframes after spec edits.
- `skills list|show|install|run` — packaged catalog and pinned overlays.
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

**Audit log.** The audit log is append-only tamper evidence: `.legion-cli/audit/events.jsonl` is hash-chained by `audit/chain.json` (length, last digest, byte offset). Every mutating verb checks the chain on lock entry (cheap: unreadable `chain.json`, a log shorter than the chain covers, or a reset chain over a multi-line log refuse with "audit chain rewind refused"), and each append verifies only the unchained tail. Writers also run the append-time check up front (a tail read for a current-format chain; a full replay only for an old-format one with no byte offset), so a bad chain refuses before any state moves. If a hard crash lands between undo's two restore writes (log first, chain last), the chain is left behind the log (healed on the next append) or, if the ship commit had added `chain.json`, missing over a multi-line log, which refuses until `doctor --rebaseline-audit`; a crash after the revert and before the restore leaves a revert in progress over the ship commit's copy of the log (the pre-undo bytes were held in memory only). A log whose line endings git converted on checkout is re-anchored by one full replay, not refused. `doctor` and `status` replay the whole log against the chain (cost grows with the log) and report a middle-line edit as a blocker. `undo` never rewinds it: it reverts a ship commit with `--no-commit`, puts the pre-undo audit files (`events.jsonl`, `chain.json`, the dated summaries) back and commits them with the revert, so neither the tree nor the revert commit carries an older log, then appends an `undo` event. The recorded way out of a chain you have reviewed is `legion-cli doctor --rebaseline-audit`: it refuses while an agent run is live, re-chains the current log, prints the length and digest it replaced, and appends an `audit_rebaselined` event.

**Big repos.** `map` keeps at most the 10,000 largest source modules (ties by path) instead of refusing on a bigger repo; `ARCHITECTURE.md` then carries a "Degraded map" note naming how many smaller modules were left out.

## Development

```bash
pnpm typecheck
pnpm test
```

Publish is tag-triggered (`git tag v*`) via GitHub Actions trusted publisher for the `@9thlevelsoftware` npm org, with provenance. Untagged `main` does not publish. There is no long-lived npm token.

See [docs/design/product-engineering-cli.md](docs/design/product-engineering-cli.md) for the product design.
