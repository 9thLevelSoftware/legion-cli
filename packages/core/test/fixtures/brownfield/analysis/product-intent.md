# Product-Intent Analysis

## 1. Executive Summary
The demo hides a broken export.

## 2. Issues
### CSV export silently drops rows
- Severity: bug
- Location: src/export.ts:88
- Evidence: `rows.slice(0, 1000)`.
- Confidence: high
