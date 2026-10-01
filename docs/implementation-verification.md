# Enhancement implementation verification

Worktree: `D:\legion-cli-enhancements`, branch `enhancements-20260930`.
The original checkout and its pre-existing untracked work are preserved.
This change does not publish, deploy, or certify a production release.

## Capability evidence

| Capability | Implementation and regression evidence |
| --- | --- |
| QA and ship | QA v2 canonical acceptance IDs, SPEC-derived priorities, missing/skipped/failed coverage, report process failures, run-scoped evidence, source/SPEC freshness, legacy-score migration, degraded-workflow restrictions |
| Recovery | Atomic resume v2 stages, process-start identities, recycled PID/unknown-owner handling, status/dashboard recovery commands, retained interruption artifacts |
| HTTP tool loop | Strict response and argument validation, engine-owned versioned checkpoints, no completed-call replay, file-write reconciliation, uncertain command/external-call refusal, compatible retained-jail resume |
| CLI UX | Nested help, adapter selection/preflight, stderr progress/prompts, one-document JSON and interactive JSON Lines, fork/proposal metadata, safely quoted project-scoped hints |
| Dashboard | Reconnecting SSE, freshness/manual refresh, lifecycle/task/blocker/evidence updates, accessible announcements/focus/keyboard controls, scoped copy commands and error navigation |
| Context/search | Deterministic bounded map slices and read-only jail artifacts, selection reasons/freshness, BM25 with IDF and exact-match priority, optional limits/truncation metadata |
| Profiles/usage | Explicit profile precedence and supported arguments, normalized optional usage, HTTP request/round limits and reported thresholds, estimated pricing, local metrics, optional metadata-only loopback OTLP |
| Extensions | Separate extension IDs, standard frontmatter/manifests, permissions/integrity/signatures, governed evidence jobs and recommendation tickets, four bundled packs, explicit unavailable checks |
| MCP | Transport-specific configuration, stdio compatibility, bounded authenticated SSE/Streamable HTTP, pinned URL resolution, cancellation, exact read-only HTTP tool allowlist; inbound tools remain read-only |
| ACP | Official SDK negotiation/session/progress/cancellation, sandbox process lifecycle and governed permissions; disabled by default |
| Hybrid retrieval | Optional sqlite-vec rebuildable index, precomputed/local embedding input, deterministic lexical/vector fusion and trust filtering; disabled by default |
| Parallel execute | Explicit 1–4 workers for automatic until-blocked only, disjoint contracts/jails, sealed output inspection and serialized conflict-checked application, sibling preservation and interruption recovery |
| Packaging/release | Bundled skill/extension/craft resources, clean packed-package consumer smoke, complete lifecycle smoke, brownfield/vendor-argv compatibility, required macOS sandbox CI and opt-in Windows/Docker workflow |

## Validation boundaries

Deterministic fixtures exercise provider protocol, ACP behavior, checkpoint
interruptions, permissions, transport policy, and integration conflicts. They
do not validate a real provider or third-party ACP agent. The opt-in ACP smoke
is documented in [ACP experiment](experiments/acp.md).

The fixed retrieval benchmark uses actual BM25 search over tracked repository
page bodies and explicit synthetic vectors. Both rankings achieve MRR 1.0 on
the five-question fixture; this is parity, not evidence of a retrieval-quality
gain. Captured latency and optional sqlite-vec installation evidence are in
[the benchmark report](experiments/retrieval-benchmark.md). No embedding model
quality or live-repository performance is certified.

Linux/native, Linux/Docker, and macOS sandbox checks require their CI runners.
Windows/Docker remains the visible `Q-WIN-DOCKER` deferral until the opt-in
self-hosted workflow provides passing evidence. Local verification does not
close those platform gates.

## Integrated local results

- Final clean consumer smoke: **passed**, exit 0. All 14 allowlisted tarballs installed
  without workspace links; installed help, init, structured status, core skills,
  extension packs, craft files, and brownfield help passed.
- Local runtime: Windows, Node 24.19.0 (the required CI matrix uses Node 22).

The consumer harness uses a temporary empty npm user configuration and removes
inherited script-policy environment keys. This avoids importing a machine's
global-only npm policy into the fixture; it does not edit operator configuration.

- Schema build/emit: **passed**, exit 0; generated JSON schemas are included.
  The schema consistency test passed in the integrated run.
- Recursive workspace build: **passed** for all 14 packages. Packages changed
  during final repairs were rebuilt successfully by their owners.
- Typecheck: all 14 package checks passed. The initial recursive invocation
  stopped at a newly changed sandbox declaration; after rebuilding, only the
  failed/downstream core, dashboard, MCP and CLI scopes were rerun and passed.
- Integrated tests were run **once**: **1,345 tests**, **1,293 passed**,
  **45 failed**, **7 skipped**. Every failure was repaired and passed in a
  targeted rerun; the complete suite was not repeated. Its original command
  exited 1, so this report does not present a second all-green suite run.
- Complete governed lifecycle smoke: **passed**, including real contracted
  output verification, approval, review, AC-linked QA and ship.
- Independent Sol review: **accepted**, no remaining material findings.
  Review used read-only source/diff inspection and did not run tests.
- Final whitespace check: **passed**, exit 0. `AGENTS.md` is unchanged.
- Original checkout status remains exactly its initial untracked `.claude/`
  and `CLAUDE.md`; implementation stays in the isolated worktree.

| Initial failing scope | Failures | Targeted resolution |
| --- | ---: | --- |
| Schema | 1 | ACP adapter/help expectations corrected; passed |
| HTTP | 2 | Fail-fast unknown-tool and unknown-cost expectations corrected; both passed |
| Persistence | 1 | Stress fixture yields between reader cycles and retains error diagnostics; invariants preserved; passed |
| Sandbox | 1 | Full-plan parent/destination preflight rejects file/directory conflicts before any sibling mutation; passed and independently reviewed |
| Core | 17 | QA staging/mode identity, canonical capture fixtures, verification log expectations, lifecycle and injected-clock seam repaired; every failed case passed |
| Dashboard | 1 | Multiline core import assertion corrected without removing no-fallback checks; passed |
| MCP | 1 | Static App rendering omits live script and inert controls; passed and independently reviewed |
| CLI | 21 | Six ship, two QA and thirteen help/status/doctor/transcript cases repaired; all passed |

The seven integrated skips are the Windows filename restriction, two missing
bubblewrap checks, the POSIX process-group check, and three existing opt-in
50k performance gates. The added POSIX dirty-chmod regression is also skipped
locally on Windows; source mode behavior received static review and the
stage-only mode regression passed locally. These skips are not passing platform
or performance certification.

Local logs are retained under `scratchpad/verification/`: `tests.log` is the
single integrated run, `failures.json` its deduplicated failure ledger,
`typecheck.log` and `typecheck-repaired.log` the cumulative typecheck evidence,
and `consumer-final.log` the final consumer result. Worker handoffs retain the
targeted repair results. The scratchpad is intentionally gitignored.
