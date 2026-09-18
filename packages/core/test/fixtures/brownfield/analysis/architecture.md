# Architecture Analysis

## Executive Summary
Orders flow through one service with no ownership checks. Confidence medium.

## Observed Architecture
```
### Not a finding: headings inside code fences are ignored
- Severity: critical
```

## Findings
### Order lookup skips owner check
- Severity: major
- Location: src/orders.ts:40
- Evidence: `getOrder(id)` never compares `order.userId`.
- Problem: violates FP-2 (users only see their own orders).
- Suggestion: add an owner check.
- Confidence: high

### Totals rounded per line item
- Severity: minor
- Location: src/totals.ts:12
- Evidence: `Math.round` inside the loop.
- Problem: cents drift on large carts.
- Suggestion: round once at the end.
- Confidence: medium

### Prose heading with no fields at all

This block has no Severity field and must be ignored.

## Assumptions
### Deleted accounts keep their orders
- Evidence: inferred from naming
- Confidence: medium
- Impact if wrong: major
- Status: needs_confirmation
- Question for user: Should orders survive account deletion?

### Payments are idempotent upstream
- Evidence: src/pay.ts:5
- Confidence: low
- Impact if wrong: critical
- Status: provisional

## Not Covered
Nothing.
