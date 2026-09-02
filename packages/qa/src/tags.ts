import type { AcceptanceCriterion, Priority, Spec } from "@9thlevelsoftware/legion-cli-schema";

/** Execute copies AC.priority into test titles as @p0/@p1/@p2. */
export function tagFromPriority(priority: Priority): "@p0" | "@p1" | "@p2" {
  if (priority === "P0") return "@p0";
  if (priority === "P2") return "@p2";
  return "@p1";
}

export function priorityFromTitle(title: string): Priority {
  if (/(^|\s)@p0(\s|$)/i.test(title)) return "P0";
  if (/(^|\s)@p2(\s|$)/i.test(title)) return "P2";
  return "P1";
}

export function isVisualTitle(title: string): boolean {
  return /@visual\b/i.test(title);
}

const UI_AC_RE =
  /\b(ui|ux|screen|page|button|click|tap|visual|wireframe|board|phone|mobile|desktop|browser|layout)\b/i;

export function isUiAcceptance(ac: Pick<AcceptanceCriterion, "statement">): boolean {
  return UI_AC_RE.test(ac.statement) || /@visual/i.test(ac.statement);
}

/** UI spec: any UI AC or wireframes. Otherwise visual is N/A (award 15, skip Playwright). */
export function specHasUi(spec: Pick<Spec, "acceptance" | "wireframesIndex">): boolean {
  if (spec.wireframesIndex) return true;
  return spec.acceptance.some(isUiAcceptance);
}
