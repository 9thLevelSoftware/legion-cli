# Bounded spec challenge: implementation and validation

Validated locally on Windows with Node 24.19.0 and pnpm 9 on 2026-10-02.

Focused unfrozen drafts now run one analysis with zero to three concerns and,
after human resolution, at most one synthesis. Responses and progress are saved
immediately. Re-running `spec` resumes the saved round; changed draft, interview,
decision, or readable repository inputs require a new round. Approval checks
current completed evidence while holding the engine lock. Legacy APIs and frozen
specs retain their existing behavior.

The internal skill always runs in a sandbox and can copy out only its own run
cache. The engine validates citations, owns receipt/draft writes, and protects
workflow receipts and the readable thinking record. Unsupported citations become
labeled assumptions. Validated output is checkpointed before sandbox cleanup;
draft application is checkpointed and replayed idempotently after interruption.

Synthesis is additive and preserves the exact trimmed human response text,
including punctuation, operators, case, and Unicode. Paraphrases or unauthorized
changes require manual completion. Explicit manual review is available after
automation failure, asks three fixed questions, and requires `I acknowledge`.
It cannot bypass unresolved concerns from successful analysis.

## Verification evidence

Affected checks ran once per revision. Only failed checks or checks affected by
subsequent repairs were repeated; passed unrelated suites were not repeated.

| Check | Result |
| --- | --- |
| Workspace `pnpm typecheck` | Passed, all workspace packages |
| Schema build and JSON emission; schema tests | Passed, 29 tests; emitted/runtime parity included |
| Packaged skill catalog tests | Passed, 12 tests |
| Core challenge and validation tests | Passed, 13 tests covering zero/over-limit concerns, human dispositions, incorporation, stale evidence, invalid output/citations, manual fallback, receipt identity and corrupted application rejection |
| Actual crash-window and held-spawn tests | Passed, 4 tests: analysis/synthesis output absent from project cache, no repeated runs, idempotent draft-write recovery, concurrent mutation refusal |
| Recovery and routing tests | Passed, 4 tests: three concerns, no manual bypass, interrupted analysis, legacy/frozen compatibility, focused brownfield configured adapter route |
| Sandbox, contracts, and workflow protection tests | Passed; includes credential-path filtering, cache-only copy-out, receipt restoration, nonzero/aborted adapter failures |
| CLI challenge and focused template approval | Passed: default activation, partial manual answers, resume, clean JSON, status guidance, approval, frozen reads |
| Previously blocked intent fixture | Passed after restoring the matching local SQLite native binding |
| Frozen approval crash recovery | Passed, 2 existing regression tests |
| Help/command registration | Passed, 4 tests |
| Affected schema, core, and CLI builds | Passed |
| `git diff --check` | Passed |

Automation checks used deterministic fake adapters. A live vendor adapter and
Linux/macOS CI were not exercised in this local implementation pass.

Source changes were developed in an isolated worktree copied from the existing
uncommitted work. Integration checks each original file against its starting hash
and copies only the challenge changes; existing work is preserved.
