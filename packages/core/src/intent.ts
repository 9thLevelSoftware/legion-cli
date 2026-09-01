import {
  SCHEMA_VERSION,
  type IntentAnswersFile,
  type IntentMapped,
} from "@9thlevelsoftware/legion-cli-schema";

export const MAX_INTENT_ROUNDS = 8;

export const INTENT_Q = {
  persona: "Who is this for, in one sentence?",
  problem: "What are they stuck doing today?",
  mustBeTrue: "What must be true when this is done?",
  scope: "What must we not change, and what will we not build?",
  clarifyMustNotChange: "What must we not change?",
  happyPath: "Walk through the happy path in 3–5 steps.",
  failure: "What does failure look like (empty, error, changed mind)?",
  screens: "What screens or moments must exist in v0?",
  platforms: "Phone, desktop, or both?",
  brand: "Any existing brand file we must follow? (path or `none`)",
  blockers: "Anything unsure that would block building?",
} as const;

export type IntentSideEffect = {
  platforms?: Array<"phone" | "desktop">;
  failureLines: string[];
  brand?: string;
  blockingLines: string[];
};

export type IntentProgress = {
  answers: IntentAnswersFile;
  nextQuestions: string[];
  readyToConfirm: boolean;
  canFinishEarly: boolean;
  brief: string;
  side: IntentSideEffect;
};

export function emptyMapped(): IntentMapped {
  return {
    personas: [],
    problem: "",
    mustBeTrue: [],
    mustNotChange: [],
    outOfScope: [],
    happyPath: "",
    screens: [],
  };
}

export function emptyIntentAnswers(): IntentAnswersFile {
  return {
    schemaVersion: SCHEMA_VERSION.intentAnswers,
    rounds: [],
    mapped: emptyMapped(),
  };
}

/** Newlines and numbered/bullet lines only — not commas. */
export function splitLines(answer: string): string[] {
  return answer
    .split(/\r?\n/)
    .map((item) => item.replace(/^\s*(?:\d+[.)]\s*|[-*]\s*)/u, "").trim())
    .map((item) => item.replace(/[.]+$/u, "").trim())
    .filter((item) => item.length > 0);
}

export function splitList(answer: string): string[] {
  const chunks = answer
    .split(/\r?\n|,/)
    .map((item) => item.replace(/^\s*(?:\d+[.)]\s*|[-*]\s*)/u, "").trim())
    .map((item) => item.replace(/^(?:no|not)\s+/i, "").replace(/[.]+$/u, "").trim())
    .filter((item) => item.length > 0 && !/^(?:we will|we won't|out of scope)$/i.test(item));
  return chunks;
}

export function splitMustNotAndOutOfScope(answer: string): {
  mustNotChange: string[];
  outOfScope: string[];
  needsClarify: boolean;
} {
  const match = /(?:we\s+)?(?:will\s+not|won't|will not)\s+build|not build|out of scope/iu.exec(answer);
  if (!match || match.index === undefined) {
    return { mustNotChange: [], outOfScope: splitList(answer), needsClarify: true };
  }
  const before = answer.slice(0, match.index);
  const after = answer.slice(match.index);
  return {
    mustNotChange: splitList(before),
    outOfScope: splitList(after),
    needsClarify: false,
  };
}

export function parsePlatforms(answer: string): Array<"phone" | "desktop"> {
  const text = answer.toLowerCase();
  const both = /\bboth\b|\band\b/.test(text) || (/\bphone\b/.test(text) && /\bdesktop\b/.test(text));
  if (both || /\ball\b/.test(text)) return ["phone", "desktop"];
  if (/\bdesktop\b|\bweb\b/.test(text) && !/\bphone\b|\bmobile\b/.test(text)) return ["desktop"];
  if (/\bphone\b|\bmobile\b/.test(text)) return ["phone"];
  return ["phone", "desktop"];
}

function hasQuestion(file: IntentAnswersFile, question: string): boolean {
  return file.rounds.some((round) => round.questions.includes(question));
}

function round2Filled(mapped: IntentMapped): boolean {
  return mapped.mustBeTrue.length > 0 && (mapped.outOfScope.length > 0 || mapped.mustNotChange.length > 0);
}

export function requiredSlotsFilled(mapped: IntentMapped): boolean {
  return (
    mapped.personas.length > 0 &&
    mapped.problem.trim().length > 0 &&
    mapped.mustBeTrue.length > 0 &&
    mapped.happyPath.trim().length > 0 &&
    mapped.screens.length > 0
  );
}

export function formatIntentBrief(mapped: IntentMapped): string {
  const persona = mapped.personas[0] ?? "(unspecified)";
  const must = mapped.mustBeTrue.join("; ") || "(unspecified)";
  const out = mapped.outOfScope.join(", ") || "(unspecified)";
  return [
    "Intent brief:",
    `  Persona: ${persona}`,
    `  Must be true: ${must}`,
    `  Out of scope: ${out}`,
  ].join("\n");
}

function nextBankQuestions(file: IntentAnswersFile): string[] {
  if (!hasQuestion(file, INTENT_Q.persona)) return [INTENT_Q.persona, INTENT_Q.problem];
  if (!hasQuestion(file, INTENT_Q.mustBeTrue)) return [INTENT_Q.mustBeTrue, INTENT_Q.scope];
  const splitPending =
    hasQuestion(file, INTENT_Q.scope) &&
    file.mapped.mustNotChange.length === 0 &&
    !hasQuestion(file, INTENT_Q.clarifyMustNotChange);
  if (splitPending) return [INTENT_Q.clarifyMustNotChange];
  if (!hasQuestion(file, INTENT_Q.happyPath)) return [INTENT_Q.happyPath, INTENT_Q.failure];
  if (!hasQuestion(file, INTENT_Q.screens)) return [INTENT_Q.screens, INTENT_Q.platforms];
  if (!hasQuestion(file, INTENT_Q.brand)) return [INTENT_Q.brand, INTENT_Q.blockers];
  return [];
}

export function intentProgress(file: IntentAnswersFile): IntentProgress {
  const canFinishEarly = round2Filled(file.mapped);
  const atCap = file.rounds.length >= MAX_INTENT_ROUNDS;
  const nextQuestions = atCap ? [] : nextBankQuestions(file);
  return {
    answers: file,
    nextQuestions,
    readyToConfirm: nextQuestions.length === 0,
    canFinishEarly,
    brief: formatIntentBrief(file.mapped),
    side: { failureLines: [], blockingLines: [] },
  };
}

export function applyIntentAnswers(
  file: IntentAnswersFile,
  questions: string[],
  answers: string[],
): { file: IntentAnswersFile; side: IntentSideEffect } {
  const mapped = { ...file.mapped, personas: [...file.mapped.personas], mustBeTrue: [...file.mapped.mustBeTrue], mustNotChange: [...file.mapped.mustNotChange], outOfScope: [...file.mapped.outOfScope], screens: [...file.mapped.screens] };
  const side: IntentSideEffect = { failureLines: [], blockingLines: [] };
  const n = file.rounds.length + 1;
  const recorded = {
    n,
    questions: [...questions],
    answers: questions.map((_, i) => (answers[i] ?? "").trim()),
  };

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const a = recorded.answers[i] ?? "";
    if (q === INTENT_Q.persona && a) mapped.personas = [a];
    if (q === INTENT_Q.problem) mapped.problem = a;
    if (q === INTENT_Q.mustBeTrue) mapped.mustBeTrue = splitLines(a);
    if (q === INTENT_Q.scope) {
      const split = splitMustNotAndOutOfScope(a);
      if (split.mustNotChange.length > 0) mapped.mustNotChange = split.mustNotChange;
      if (split.outOfScope.length > 0) mapped.outOfScope = split.outOfScope;
    }
    if (q === INTENT_Q.clarifyMustNotChange) mapped.mustNotChange = splitList(a);
    if (q === INTENT_Q.happyPath) mapped.happyPath = a.trim();
    if (q === INTENT_Q.failure) side.failureLines = splitList(a);
    if (q === INTENT_Q.screens) mapped.screens = splitList(a);
    if (q === INTENT_Q.platforms) side.platforms = parsePlatforms(a);
    if (q === INTENT_Q.brand) side.brand = a.trim();
    if (q === INTENT_Q.blockers && !/^(none|no|n\/a|-)$/i.test(a.trim())) {
      side.blockingLines = splitList(a);
    }
  }

  return {
    file: {
      schemaVersion: SCHEMA_VERSION.intentAnswers,
      rounds: [...file.rounds, recorded],
      mapped,
    },
    side,
  };
}

export function specIdFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `spec-${slug || "product"}`;
}

export function prdBody(mapped: IntentMapped): string {
  const persona = mapped.personas[0] ?? "the user";
  return [
    `# PRD`,
    ``,
    `## Problem`,
    mapped.problem || "(unspecified)",
    ``,
    `## Persona`,
    persona,
    ``,
    `## Must be true`,
    ...bullets(mapped.mustBeTrue),
    ``,
    `## Must not change`,
    ...bullets(mapped.mustNotChange),
    ``,
    `## Out of scope`,
    ...bullets(mapped.outOfScope),
    ``,
    `## Happy path`,
    mapped.happyPath || "(unspecified)",
    ``,
    `## Screens`,
    ...bullets(mapped.screens),
    ``,
  ].join("\n");
}

export function intentWikiBody(mapped: IntentMapped): string {
  const persona = mapped.personas[0] ?? "the user";
  return [
    `${persona}. ${mapped.problem}`.trim(),
    ``,
    mapped.happyPath ? `Happy path: ${mapped.happyPath}` : "",
    mapped.outOfScope.length > 0 ? `Out of scope: ${mapped.outOfScope.join(", ")}.` : "",
    ``,
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

function bullets(items: string[]): string[] {
  if (items.length === 0) return ["- (none)"];
  return items.map((item) => `- ${item}`);
}
