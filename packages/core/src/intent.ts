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
  failure: "What failures, security concerns, or integration risks must be handled?",
  screens: "What interfaces or touchpoints must exist in v0? (use `none` for a service or library)",
  platforms: "What runtime or deployment environment matters, if any? (for example CLI, service, browser, mobile, Python, Rust; or `none`)",
  brand: "Any existing constraints or design inputs we must follow? (path, link, or `none`)",
  blockers: "Which unknowns or external integrations could block building?",
} as const;

/** Question text is persisted in interview transcripts, so recognize prior wording on replay. */
const LEGACY_INTENT_Q = {
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
  const hasPhone = /\bphone\b|\bmobile\b/.test(text);
  const hasDesktop = /\bdesktop\b|\bweb\b|\bbrowser\b/.test(text);
  const both = /\bboth\b|\ball\b/.test(text) || (hasPhone && hasDesktop);
  if (both || /\ball\b/.test(text)) return ["phone", "desktop"];
  if (hasDesktop) return ["desktop"];
  if (hasPhone) return ["phone"];
  return [];
}

function questionVariants(question: string): readonly string[] {
  const key = (Object.keys(INTENT_Q) as Array<keyof typeof INTENT_Q>).find((name) => INTENT_Q[name] === question);
  return key && key in LEGACY_INTENT_Q
    ? [INTENT_Q[key], LEGACY_INTENT_Q[key as keyof typeof LEGACY_INTENT_Q]]
    : [question];
}

function hasQuestion(file: IntentAnswersFile, question: string): boolean {
  const variants = questionVariants(question);
  return file.rounds.some((round) => round.questions.some((recorded) => variants.includes(recorded)));
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
  if (file.source) {
    const questions: Record<string, string> = {
      personas: INTENT_Q.persona, problem: INTENT_Q.problem, mustBeTrue: INTENT_Q.mustBeTrue,
      mustNotChange: INTENT_Q.clarifyMustNotChange, outOfScope: INTENT_Q.scope,
      happyPath: INTENT_Q.happyPath, screens: INTENT_Q.screens, failureLines: INTENT_Q.failure,
      blockingLines: INTENT_Q.blockers,
    };
    const unresolved = [...new Set([...(file.importedConflicts ?? []), ...(file.importedMissing ?? [])])];
    return unresolved.map((slot) => questions[slot] ?? `Resolve imported requirement: ${slot}`).slice(0, 2);
  }
  for (const pair of [[INTENT_Q.persona, INTENT_Q.problem], [INTENT_Q.mustBeTrue, INTENT_Q.scope]]) {
    const pending = pair.filter((question) => !hasQuestion(file, question));
    if (pending.length) return pending;
  }
  const splitPending =
    hasQuestion(file, INTENT_Q.scope) &&
    file.mapped.mustNotChange.length === 0 &&
    !hasQuestion(file, INTENT_Q.clarifyMustNotChange);
  if (splitPending) return [INTENT_Q.clarifyMustNotChange];
  for (const pair of [[INTENT_Q.happyPath, INTENT_Q.failure], [INTENT_Q.screens, INTENT_Q.platforms], [INTENT_Q.brand, INTENT_Q.blockers]]) {
    const pending = pair.filter((question) => !hasQuestion(file, question));
    if (pending.length) return pending;
  }
  return [];
}

export function intentProgress(file: IntentAnswersFile): IntentProgress {
  const canFinishEarly = file.source
    ? requiredSlotsFilled(file.mapped) && !(file.importedConflicts?.length) && !(file.importedMissing?.length)
    : round2Filled(file.mapped);
  const atCap = file.rounds.length >= MAX_INTENT_ROUNDS;
  const pendingQuestions = nextBankQuestions(file);
  const nextQuestions = atCap ? [] : pendingQuestions;
  return {
    answers: file,
    nextQuestions,
    readyToConfirm: file.source ? pendingQuestions.length === 0 : nextQuestions.length === 0,
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
  const lastRound = file.rounds.at(-1);
  const bankPairs = [[INTENT_Q.persona, INTENT_Q.problem], [INTENT_Q.mustBeTrue, INTENT_Q.scope],
    [INTENT_Q.happyPath, INTENT_Q.failure], [INTENT_Q.screens, INTENT_Q.platforms], [INTENT_Q.brand, INTENT_Q.blockers]];
  // Save each answer immediately while retaining the interview's bounded paired rounds.
  const mergePartialRound = lastRound?.questions.length === 1 && questions.length === 1 &&
    bankPairs.some((pair) => pair.some((question) => questionVariants(question).includes(lastRound.questions[0])) &&
      pair.some((question) => questionVariants(question).includes(questions[0])) && lastRound.questions[0] !== questions[0]);
  const rounds = mergePartialRound && lastRound
    ? [...file.rounds.slice(0, -1), { n: lastRound.n, questions: [...lastRound.questions, ...recorded.questions], answers: [...lastRound.answers, ...recorded.answers] }]
    : [...file.rounds, recorded];

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const a = recorded.answers[i] ?? "";
    if (questionVariants(INTENT_Q.persona).includes(q) && a) mapped.personas = [a];
    if (questionVariants(INTENT_Q.problem).includes(q)) mapped.problem = a;
    if (questionVariants(INTENT_Q.mustBeTrue).includes(q)) mapped.mustBeTrue = splitLines(a);
    if (questionVariants(INTENT_Q.scope).includes(q)) {
      const split = splitMustNotAndOutOfScope(a);
      if (split.mustNotChange.length > 0) mapped.mustNotChange = split.mustNotChange;
      if (split.outOfScope.length > 0) mapped.outOfScope = split.outOfScope;
    }
    if (questionVariants(INTENT_Q.clarifyMustNotChange).includes(q)) mapped.mustNotChange = splitList(a);
    if (questionVariants(INTENT_Q.happyPath).includes(q)) mapped.happyPath = a.trim();
    if (questionVariants(INTENT_Q.failure).includes(q)) side.failureLines = splitList(a);
    if (questionVariants(INTENT_Q.screens).includes(q)) mapped.screens = splitList(a);
    if (questionVariants(INTENT_Q.platforms).includes(q)) side.platforms = parsePlatforms(a);
    if (questionVariants(INTENT_Q.brand).includes(q)) side.brand = a.trim();
    if (questionVariants(INTENT_Q.blockers).includes(q) && !/^(none|no|n\/a|-)$/i.test(a.trim())) {
      side.blockingLines = splitList(a);
    }
  }

  return {
    file: {
      ...file,
      schemaVersion: SCHEMA_VERSION.intentAnswers,
      rounds,
      mapped,
      ...(file.source ? {
        importedMissing: (file.importedMissing ?? []).filter((slot) => !answeredImportedSlot(slot, questions, recorded.answers)),
        importedConflicts: (file.importedConflicts ?? []).filter((slot) => !answeredImportedSlot(slot, questions, recorded.answers)),
      } : {}),
    },
    side,
  };
}

function answeredImportedSlot(slot: string, questions: string[], answers: string[]): boolean {
  const question: Record<string, string> = {
    personas: INTENT_Q.persona, problem: INTENT_Q.problem, mustBeTrue: INTENT_Q.mustBeTrue,
    mustNotChange: INTENT_Q.clarifyMustNotChange, outOfScope: INTENT_Q.scope,
    happyPath: INTENT_Q.happyPath, screens: INTENT_Q.screens, failureLines: INTENT_Q.failure,
    blockingLines: INTENT_Q.blockers,
  };
  return questions.some((item, index) => item === (question[slot] ?? `Resolve imported requirement: ${slot}`) && Boolean(answers[index]?.trim()));
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
