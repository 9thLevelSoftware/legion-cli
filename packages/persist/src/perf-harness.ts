/** A-007: every pipeline step under 10s at 50k files. Wall-clock only here (KD-3). */
export const A007_STEP_BUDGET_MS = 10_000;
/** Shared-runner jitter. Work-counter proofs never use this. */
export const A007_TOLERANCE = 2;
export const A007_FILE_COUNT = 50_000;

export type A007Measurement = {
  step: string;
  ms: number;
  files?: number;
};

export type A007GateResult = {
  ok: boolean;
  reason?: string;
};

export function evaluateA007Gate(measurements: readonly A007Measurement[]): A007GateResult {
  if (measurements.length === 0) {
    return { ok: false, reason: "zero measurements" };
  }
  const budget = A007_STEP_BUDGET_MS * A007_TOLERANCE;
  for (const row of measurements) {
    if (!Number.isFinite(row.ms) || row.ms < 0) {
      return { ok: false, reason: `invalid measurement for ${row.step}` };
    }
    if (row.ms > budget) {
      return { ok: false, reason: `budget exceeded: ${row.step} ${row.ms}ms > ${budget}ms` };
    }
  }
  return { ok: true };
}
