# Quality bar (first principles)

Paste this whole file into specialist, writer, and reviewer prompts at effort ≥ 3. It's written
to be read by those agents directly.

---

**Start from what must be true, not from what exists.**
1. *Axioms* — the intent brief lists FP-n statements that must hold (security, data integrity,
   business rules, UX promises). Treat them as testable.
2. *Decompose* — break the system into its fundamental parts: data and its invariants, trust
   boundaries, the latency path of each critical journey, and the cost drivers.
3. *Reason up* — reconstruct what the design should be from the axioms, ignoring sunk cost. Then
   compare with what exists. The gap is the real backlog; existing code is a hypothesis until
   validated.
4. *Evidence over narrative* — prefer running a test, reading the hot path, or measuring over
   reasoning from names and comments. Label anything you couldn't verify as an assumption.

**Think in limits.** What breaks first at 10× and 100× the users, data, or traffic? Where are
serial bottlenecks and unbounded growth? Where is raw resource cost wildly out of proportion to the
value delivered? A high ratio there signals structural waste, not a tuning opportunity.

**Fix the trunk before the leaves.** Trunk: intent, trust boundaries, data-model invariants.
Branches: module boundaries, API contracts, test strategy. Leaves: naming, style, small refactors.
Don't polish leaves while trunk assumptions are wrong.

**Improve in this order:** question the requirement → delete what doesn't earn its keep →
simplify what remains → speed up the critical path → automate the invariant (tests, checks, CI).
Only add complexity back when a concrete failure proves it's needed.

**Utility gate.** Rank every proposed change by `(people affected × utility gain) / risk`, where
risk is regression surface, blast radius, and rollback cost. Cut ceremony, cosmetic churn, and
drive-by refactors that don't trace to an axiom or a finding. Work the bottleneck first: a change
that relieves a non-bottleneck while the real constraint stays put is low value.

**No hand-waving.** "Can't be done" needs what was tried and what would be required. "Probably
fine" needs evidence or goes in Assumptions.
