import { readActive } from "./active.js";
import { isUiWork } from "./review.js";

export async function isBrandViolationBlockingFreeze(
  projectRoot: string,
  spec: { wireframesIndex?: string | null },
  screens: string[],
): Promise<boolean> {
  if (!isUiWork(spec, screens)) return false;
  const active = await readActive(projectRoot);
  return Boolean(active?.brandViolation);
}
