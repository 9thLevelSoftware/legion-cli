# Brownfield run: effort 5, fresh audit, plan only

## Context
The user ran `/brownfield --effort 5` on the legion-cli repo. This is the third deep audit. The last one (`.brownfield/f8ca3ae6`) produced a 10-step fix plan, and those fixes are merged on the current branch `feat/cli-superpowers-and-audit-remediation` (HEAD `5f7bbb7`). Local `main` (`d9494d9`) is stale and does not include them.

The user's answers:
- **Fresh audit.** Judge the code as it stands today from first principles. Earlier runs are background only and are never cited as proof.
- **Plan only.** Stop at a reviewed plan. No `--execute`, and no source files change.
- **Notes backend.** Use the Python fallback in `.brownfield/`, as before. Do not run `legion-cli init` (`.legion-cli/STATE.md` does not exist).

Size: medium (about 60k lines; `max_prs` 10; effort 5 is within the suggested maximum).

## Steps
1. **Setup.** Run `python "%USERPROFILE%\.claude\skills\brownfield\scripts\brownfield.py" init D:\legion-cli --effort 5 --context "Fresh first-principles audit of branch feat/cli-superpowers-and-audit-remediation @5f7bbb7. Prior runs 87437d5f/f8ca3ae6 are background only, not evidence. Plan only."`
   - Record base = the current branch HEAD, not the stale `main`.
   - Run `patterns` and pass any hits to the code, tests and security specialists.
   - Announce the roster: pass 1 is architecture and product-intent; pass 2 is code ×2, tests, docs, security and performance; execute is no.
2. **Intent.** Write `intent.md` from README, AGENTS.md, CLAUDE.md, `docs/design/product-engineering-cli.md` and the git log. Keep the axioms (FP-n) to the product promises, for example:
   - the lifecycle state machine can't be bypassed
   - a spawned agent can't escape its file contract or touch `.legion-cli/` state
   - the sandbox fails closed
   - no secrets leak
   - the docs and help match what ships
   - the suite is green and honest on Linux and Windows

   Don't ask the user more questions. Where intent is unclear, record it as an open question.
3. **Plan the analysis.** Run `roster`. Write `plan.md` with 2–3 focus bullets per specialist, each assigned explicit directories (`packages/core`, `sandbox`, `agents`, `http`, `cli`, and so on). Run risks to cover:
   - large diff surface (147 files changed in the last cycle)
   - Windows-specific code paths
   - quarantined integration suites
2. **Analysis.** Read `references/specialists.md` and `references/doctrine.md`.
   - Launch the pass-1 specialists in parallel. Checkpoint on their summaries.
   - Launch the pass-2 specialists in parallel. The two code reviewers get split, independent focus.
   - Specialists may run the build and tests read-only (output goes to the run folder) so findings rest on actual results.
   - Run `merge` to produce `findings.md` and `assumptions.md`. Relaunch any specialist whose output came back empty.
5. **Assumptions.** Ask the user about blocking assumptions in plain language (the user has said jargon is hard to follow). Record the answers and re-run `merge`.
6. **Design and review.** Read `references/design-and-review.md`.
   - The writer produces `design.md` and `summary.md`.
   - Two reviewers (general, and security-minded) review it; loop with `review-status --strict` for up to 5 rounds.
   - Exit when every severity is at zero.
7. **Present.** Show:
   - the summary headline
   - critical and major findings, with file:line
   - key decisions and remaining risks
   - the PR plan (at most 10 PRs, each traced to an FP or F number)

   Ask any open questions.
8. **Final report.** Set state `phase=complete`, add generalized patterns, and give the report in plain language. Mention that `--resume <id> --execute` will build the plan.

## Ground rules
- The audit is read-only apart from `.brownfield/<run-id>/`.
- Secrets are cited as `file:line` with the value shown as `[REDACTED]`.
- I orchestrate. The specialists write the findings.
- No commits, pushes or branches.

## Verification
- `findings.md` and `assumptions.md` exist, and `empty_sources` is empty.
- `review-status --strict` returns `pass`.
- Every PR in `design.md` traces to an FP or F number and the plan stays at 10 PRs or fewer.
- Any "suite is green" statement cites a test log saved in the run folder.
