# Brownfield Improvement Plan — Shop

## Summary
Fix authz first.

## PR Plan
### PR 1: Add owner check to order lookup
- Depends on: none
- Files: src/orders.ts, `test/orders.test.ts`
- Traces to: FP-2, F-001
- Risk: low
- Description: compare order.userId.
- Acceptance: new test fails without the check.

### PR 2: Pin refund error handling with tests
- Depends on: PR 1
- Files: src/refund.ts
- Traces to: F-002
- Risk: medium
- Description: surface refund errors.
- Acceptance: failing refund returns 502.

### PR 3: Round totals once at the end of checkout calculation pipeline
- Depends on: PR 1, PR 2
- Files: none
- Traces to: F-003
- Risk: low
- Description: move rounding.
- Acceptance: property test on cents.

## Not Doing (and why)
### PR 9: Not a plan entry because it is outside the PR Plan section
- Depends on: PR 42
