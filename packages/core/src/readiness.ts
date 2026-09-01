import { filesAllowedFailsPlan, overlappingFilesAllowed } from "@9thlevelsoftware/legion-cli-graph";
import type { Readiness, Spec, Task } from "@9thlevelsoftware/legion-cli-schema";

export type ReadinessReport = {
  readiness: Readiness;
  fails: string[];
  concerns: string[];
};

export { filesAllowedFailsPlan, overlappingFilesAllowed };

export function evaluateReadiness(input: {
  spec: Spec;
  tasks: readonly Task[];
  hasStories: boolean;
  skipWireframes: boolean;
  openNonBlockingAssumptions: boolean;
}): ReadinessReport {
  const fails: string[] = [];
  const concerns: string[] = [];

  if (input.spec.status !== "frozen") fails.push("spec not frozen");
  if (input.spec.mustBeTrue.length === 0) fails.push("mustBeTrue empty");
  if (!input.spec.acceptance.some((ac) => ac.priority === "P0")) {
    fails.push("no P0 acceptance criterion");
  }
  if (!input.tasks.some((task) => task.priority === "P0")) {
    fails.push("plan did not emit at least one P0 task");
  }

  for (const task of input.tasks) {
    if (task.contract.verificationCommands.length === 0) {
      fails.push(`${task.id} missing verificationCommands`);
    }
    if (filesAllowedFailsPlan(task.contract.filesAllowed)) {
      fails.push(`${task.id} filesAllowed must be concrete paths`);
    }
  }

  const overlaps = overlappingFilesAllowed(input.tasks);
  for (const overlap of overlaps) {
    fails.push(`overlapping filesAllowed ${overlap}`);
  }

  if (fails.length === 0) {
    if (!input.hasStories) concerns.push("no stories.yaml");
    if (input.skipWireframes) concerns.push("skip-wireframes");
    if (input.openNonBlockingAssumptions) concerns.push("open non-blocking assumption");
    if (input.tasks.some((task) => task.contract.filesAllowed.length > 12)) {
      concerns.push("filesAllowed length > 12");
    }
    if (input.spec.mustNotChange.length === 0 && input.spec.outOfScope.length > 0) {
      concerns.push("mustNotChange empty");
    }
  }

  const readiness: Readiness = fails.length > 0 ? "FAIL" : concerns.length > 0 ? "CONCERNS" : "PASS";
  return { readiness, fails, concerns };
}
