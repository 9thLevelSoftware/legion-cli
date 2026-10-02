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

The default workflow is five commands. Each command owns a complete stage; the
supporting interview, decision, review, and evidence work is available within
that stage instead of being a ceremony the user must navigate.

`init` → `spec` → `plan` → `execute` → `ship`

- `init` configures an adapter and starts a greenfield or brownfield project.
- `spec` captures intent, investigates relevant context, records decisions, and
  produces the contract. Before approval it runs one bounded challenge pass:
  answer, dismiss with a reason, or accept each identified risk, then review
  the proposed draft changes. `spec approve` freezes it.
- `plan` turns that contract into bounded tasks, planned checks, and manual
  acceptance evidence. `plan approve` is required before execution.
- `execute` completes the approved plan or stops at a concrete blocker. It
  runs planned checks and an independent review; `execute --step` runs one
  ready task, `execute <taskId>` is targeted recovery, and `execute --retry`
  explicitly retries one failed integration or review stage.
- `ship` is the final human approval and delivery gate. It presents evidence;
  it never commits, opens a PR, merges, or deploys without the matching option
  and human confirmation.

`intent`, `discuss`, `verify`, `review`, and `qa` remain available as advanced
inspection or recovery commands in `legion-cli help --all`. The focused ship
gate uses the approved plan's checks, review result, and acceptance evidence;
numeric QA remains optional legacy reporting.

New projects created by this CLI use the focused workflow profile. Existing
unmarked engine configuration remains compatible as the legacy profile. Migrate
an existing CLI project by running `plan approve`: it binds the current frozen
spec, plan, and task artifacts without regenerating them. CLI `execute` always
requires that approval; direct legacy core APIs remain compatible.

Init requires `--adapter` (`claude` | `generic` | `fake` | `grok` | `openai` | `codex` | `mimo` | `minimax` | `http`). There is no product default. `fake` is test-only. Extra adapters spawn with verified vendor argv (`grok -p`, `codex exec`, `mimo run`, `mcode exec`). Dashboard is a **view-only** board: writes are CLI or token POST; it is not the source of truth.

verificationCommands and the QA unit command are trusted code run on your machine, outside the sandbox, with API keys and tokens removed from the environment. They are argv-only: split `a && b` into separate commands.

The following is a fixture/smoke example using the test-only `fake` adapter;
it is not an end-to-end real-adapter walkthrough. For actual development, use
a configured adapter such as `--adapter claude` and complete its normal doctor
check first.

From this repo:

```bash
pnpm install
pnpm exec legion-cli init --name Checkin --adapter fake
pnpm exec legion-cli spec
pnpm exec legion-cli spec approve
pnpm exec legion-cli plan
pnpm exec legion-cli plan approve --check "pnpm test"
pnpm exec legion-cli execute
# After planned checks and independent review pass, repeat for each spec criterion.
pnpm exec legion-cli plan acceptance --pass <criterionId> --note "Manual walkthrough passed"
pnpm exec legion-cli ship
```

Windows PowerShell equivalent:

```powershell
pnpm install
pnpm exec legion-cli init --name Checkin --adapter fake
pnpm exec legion-cli spec
pnpm exec legion-cli spec approve
pnpm exec legion-cli plan
pnpm exec legion-cli plan approve --check "pnpm test"
pnpm exec legion-cli execute
# After planned checks and independent review pass, repeat for each spec criterion.
pnpm exec legion-cli plan acceptance --pass <criterionId> --note "Manual walkthrough passed"
pnpm exec legion-cli ship

# Test adapter only: enable its doctor check for local fixture testing.
$env:LEGION_CLI_ADAPTER = "fake"
pnpm exec legion-cli doctor
```

`fake` is the test adapter; `doctor` treats it as spawnable only when
`LEGION_CLI_ADAPTER=fake`. For `claude` or `generic`, doctor fails closed until
that binary is on PATH.

## Advanced commands and extras

See `legion-cli help --all` for the full rows. One sentence each:

- `chat` — REPL that routes into engine verbs (`--once`, `--adapter`, `--fork`).
- `undo` — revert the last completed task or Legion commit.
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

## Greenfield and brownfield starts

For a new project, use the default greenfield mode. For an existing repository:

```bash
pnpm exec legion-cli init --mode brownfield --brownfield-goal change --adapter <adapter>
```

`--brownfield-goal change` performs scoped discovery of the relevant code,
tests, integration points, and current behavior before `spec`. Use
`--brownfield-goal audit` to collect findings. Before the interview begins,
audit mode persists a bounded remediation goal and affected module paths;
unselected findings remain backlog items. Both paths converge on `spec` →
`plan` → `execute` → `ship`, and ordinary execute stays **in-place**.

`legion-cli brownfield` remains a separate advanced audit-bookkeeping surface.
The orchestrating `skills/brownfield` skill launches specialists and reviewers;
the CLI records runs under `.legion-cli/runs/<id>/`. Its `--execute` mode is the
only workflow that creates per-PR worktrees under
`.legion-cli/worktrees/<run>/pr-N/`. Do not merge the two surfaces.

Wireframes are opt-in (`spec --wireframes`); a non-UI spec does not need
wireframes or user stories. Planned checks are declared at approval time with
one quoted argv command per `--check`, for example `plan approve --check "pnpm test"`.
Record manual acceptance with `plan acceptance --pass <criterionId>` (or
`--fail <criterionId>` / `--not-applicable <criterionId> --note "reason"`).

The focused spec challenge asks no more than three grounded questions about
measurable success, failure behavior, compatibility, and scope. Each answer is
saved immediately, so rerunning `spec` resumes unanswered questions without
regenerating the draft. The challenge receipt records the concern, evidence or
assumption, response, disposition, rationale, and resulting draft changes.
When adapter automation is actually unavailable or fails, `spec --manual-review`
records an explicit acknowledgement and answers to the same three fixed review
questions. It does not bypass concerns produced by a successful challenge.

Local metrics (never phones home): `legion-cli doctor --metrics`.

## Development

```bash
pnpm typecheck
pnpm test
```

Publish is tag-triggered (`git tag v*`) via GitHub Actions trusted publisher for the `@9thlevelsoftware` npm org, with provenance. Untagged `main` does not publish. There is no long-lived npm token.

See [docs/design/workflow-focus.md](docs/design/workflow-focus.md) for the
canonical workflow and [docs/design/product-engineering-cli.md](docs/design/product-engineering-cli.md)
for the historical architecture record.
