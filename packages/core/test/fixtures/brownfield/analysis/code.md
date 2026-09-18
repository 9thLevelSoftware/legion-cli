# Code Analysis

## Executive Summary
Two real bugs on the checkout path.

## Findings
### F-7: Order lookup skips owner check
- **Severity**: High
- **Location**: `src/orders.ts:41`
- **Evidence**: same missing comparison.
- **Confidence**: high

### Refund path swallows errors
- Severity: critical
- Location: src/refund.ts:9
- Evidence: empty `catch {}` returns success.
- Problem: a failed refund looks successful (FP-1).
- Suggestion: surface the error.
- Confidence: high

### Highlight colour is hard-coded
- Severity: highlight nit
- Location: src/ui.ts:3
- Evidence: `#ff0`.
- Confidence: low

## Assumptions
### Deleted accounts keep their orders
- Evidence: src/accounts.ts:22
- Confidence: low
- Impact if wrong: major
- Status: provisional

### A lonely heading without assumption fields
- Evidence: nothing else
