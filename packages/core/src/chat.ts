import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { runCachePaths } from "@9thlevelsoftware/legion-cli-agents";
import { redactSecrets, toFsPath, writeTextFile } from "@9thlevelsoftware/legion-cli-persist";
import {
  ChatActionSchema,
  ChatProposalActionSchema,
  ChatReadActionSchema,
  ChatSessionFileSchema,
  SCHEMA_VERSION,
  type ChatAction,
  type ChatProposalAction,
  type ChatReadAction,
  type ChatSessionFile,
  type Phase,
} from "@9thlevelsoftware/legion-cli-schema";
import { renderSessionBrief } from "@9thlevelsoftware/legion-cli-wiki";
import { HINT, refuse } from "./errors.js";
import type { LegionEngine } from "./engine.js";
import type { DecisionInput, NewTicket } from "./types.js";

export const CHAT_IDLE_LIMIT = 4;

const ILLEGAL_MODEL_TYPES = new Set([
  "execute",
  "ship",
  "plan",
  "spec_approve",
  "control_mode",
  "wiki_trust",
]);

export type ChatTurnKind = "read" | "proposal" | "dropped";

export type ChatTurnResult = {
  session: ChatSessionFile;
  action: ChatAction;
  kind: ChatTurnKind;
  output: string;
  proposal: string | null;
  nextHint: string;
  paused: boolean;
  spawned: boolean;
  local?: "brief" | "help";
};

export type ChatApplyResult = {
  applied: boolean;
  output: string;
};

export type ChatRouteOpts = {
  cliAdapter?: import("@9thlevelsoftware/legion-cli-schema").AdapterId;
  /** Test seam: model JSON used only when the rule router is unclear. */
  fixtureAction?: unknown;
};

function nowIso(): string {
  return new Date().toISOString();
}

function newSessionId(): string {
  return `chat-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

export function createChatSession(): ChatSessionFile {
  return {
    schemaVersion: SCHEMA_VERSION.chatSession,
    id: newSessionId(),
    startedAt: nowIso(),
    turns: [],
  };
}

export function isChatReadAction(action: ChatAction): action is ChatReadAction {
  return ChatReadActionSchema.safeParse(action).success;
}

export function isChatProposalAction(action: ChatAction): action is ChatProposalAction {
  return ChatProposalActionSchema.safeParse(action).success;
}

export function nextVerbForPhase(phase: Phase): string {
  switch (phase) {
    case "uninitialized":
      return "init";
    case "initialized":
    case "intent_draft":
      return "intent";
    case "intent_ready":
      return "discuss";
    case "discussing":
      return "spec";
    case "spec_draft":
      return "spec";
    case "spec_frozen":
    case "planning":
    case "plan_failed":
      return "plan";
    case "plan_ready":
    case "executing":
      return "execute";
    case "ready_to_ship":
      return "ship";
    case "shipped":
    case "abandoned":
      return "spec";
    default:
      return "status";
  }
}

export function nextHintForAction(action: ChatAction, phase: Phase): string {
  switch (action.type) {
    case "intent_answer":
      return HINT.intent;
    case "discuss_decide":
      return HINT.discuss;
    case "assume_answer":
      return HINT.assumeAnswer;
    case "ticket":
      return HINT.ticket("TSK-x");
    case "status":
    case "search":
    case "next_verb":
      return `legion-cli ${nextVerbForPhase(phase)}`;
    default:
      return `legion-cli ${nextVerbForPhase(phase)}`;
  }
}

export function formatChatProposal(action: ChatProposalAction): string {
  switch (action.type) {
    case "intent_answer":
      return `Proposed: intent answers: ${action.answers.map((item) => JSON.stringify(item)).join("; ")} [Y/n]`;
    case "discuss_decide":
      return `Proposed: discuss ${action.id} ${action.status} [Y/n]`;
    case "assume_answer":
      return `Proposed: assume ${action.id} ${action.status} [Y/n]`;
    case "ticket":
      return `Proposed: ticket ${JSON.stringify(action.title)}${action.parentId ? ` parent ${action.parentId}` : ""} [Y/n]`;
  }
}

function normalizeUtterance(text: string): string {
  return text.replace(/\r\n/g, "\n").trim().slice(0, 8_000);
}

function isYesLine(text: string): boolean {
  return /^(y|yes)$/i.test(text.trim());
}

function isNoLine(text: string): boolean {
  return /^(n|no)$/i.test(text.trim());
}

function parseSlash(utterance: string): ChatAction | "brief" | "help" | null {
  const trimmed = utterance.trim();
  const status = /^\/status(?:\s|$)/i.exec(trimmed);
  if (status) return { type: "status" };
  if (/^\/next(?:\s|$)/i.test(trimmed)) return { type: "next_verb" };
  if (/^\/brief(?:\s|$)/i.test(trimmed)) return "brief";
  if (/^\/help(?:\s|$)/i.test(trimmed)) return "help";
  const search = /^\/search(?:\s+(.+))?$/i.exec(trimmed);
  if (search) {
    const q = (search[1] ?? "").trim();
    if (!q) return { type: "next_verb" };
    return { type: "search", q };
  }
  return null;
}

function parseNaturalRead(utterance: string): ChatReadAction | null {
  const trimmed = utterance.trim();
  if (/^(where am i\??|status)$/i.test(trimmed)) return { type: "status" };
  if (/^(what(?:'s| is) next\??|next(?: command)?\??)$/i.test(trimmed)) return { type: "next_verb" };
  const search = /^(?:search|find)\s+(.+)$/i.exec(trimmed);
  if (search) {
    const q = search[1].trim();
    if (q) return { type: "search", q };
  }
  return null;
}

function splitAnswerLines(utterance: string): string[] {
  return utterance
    .split(/\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 2);
}

function answersAreParseOf(answers: readonly string[], utterance: string): boolean {
  const normalized = utterance.replace(/\r\n/g, "\n");
  const lines = splitAnswerLines(normalized);
  if (answers.length === lines.length && answers.every((answer, i) => answer === lines[i])) {
    return true;
  }
  if (answers.length === 1 && answers[0] === normalized.trim()) return true;
  return answers.every((answer) => {
    const needle = answer.trim();
    return needle.length > 0 && normalized.includes(needle);
  });
}

function parseRawAction(raw: unknown): ChatAction | null {
  if (raw === null || raw === undefined) return null;
  let value: unknown = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    try {
      value = JSON.parse(trimmed) as unknown;
    } catch {
      const match = /\{[\s\S]*\}/.exec(trimmed);
      if (!match) return null;
      try {
        value = JSON.parse(match[0]) as unknown;
      } catch {
        return null;
      }
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  if (typeof rec.type === "string" && ILLEGAL_MODEL_TYPES.has(rec.type)) return null;
  const parsed = ChatActionSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function sanitizeChatAction(
  raw: unknown,
  ctx: { phase: Phase; utterance: string },
): ChatAction {
  const parsed = parseRawAction(raw);
  if (!parsed) return { type: "next_verb" };
  if (parsed.type === "intent_answer") {
    if (ctx.phase !== "intent_draft" && ctx.phase !== "intent_ready") return { type: "next_verb" };
    if (!answersAreParseOf(parsed.answers, ctx.utterance)) return { type: "next_verb" };
  }
  return parsed;
}

export function ruleRouteChat(input: {
  utterance: string;
  phase: Phase;
  nextQuestions: readonly string[];
  proposedDecisionId?: string;
}): ChatAction | "brief" | "help" | null {
  const slash = parseSlash(input.utterance);
  if (slash) return slash;
  const natural = parseNaturalRead(input.utterance);
  if (natural) return natural;
  if (input.phase === "intent_draft" && input.nextQuestions.length > 0) {
    const answers = splitAnswerLines(input.utterance);
    if (answers.length > 0) return { type: "intent_answer", answers };
  }
  if (input.phase === "discussing" && input.proposedDecisionId) {
    if (isYesLine(input.utterance)) {
      return { type: "discuss_decide", id: input.proposedDecisionId, status: "accepted" };
    }
    if (isNoLine(input.utterance)) {
      return { type: "discuss_decide", id: input.proposedDecisionId, status: "rejected" };
    }
  }
  return null;
}

function isSlashUtterance(utterance: string): boolean {
  return utterance.trim().startsWith("/");
}

export function idleTurnsFromSession(session: ChatSessionFile): number {
  let count = 0;
  for (let i = session.turns.length - 1; i >= 0; i--) {
    const turn = session.turns[i];
    if (turn.role !== "assistant") continue;
    if (turn.action?.type === "next_verb" || turn.action?.type === "search") count += 1;
    else break;
  }
  return count;
}

function chatSessionPath(id: string): string {
  const safe = id.trim();
  if (!safe || /[\\/]/.test(safe) || safe.includes("..")) {
    refuse("invalid chat session id", HINT.chat);
  }
  return `.legion-cli/chat/${safe}.json`;
}

export async function saveChatSession(engine: LegionEngine, session: ChatSessionFile): Promise<void> {
  const parsed = ChatSessionFileSchema.parse(session);
  const abs = toFsPath(engine.projectRoot, chatSessionPath(parsed.id));
  const body = redactSecrets(`${JSON.stringify(parsed, null, 2)}\n`);
  await writeTextFile(abs, body);
}

export async function loadChatSession(engine: LegionEngine, id: string): Promise<ChatSessionFile | null> {
  try {
    const raw = await readFile(toFsPath(engine.projectRoot, chatSessionPath(id)), "utf8");
    return ChatSessionFileSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function resumeOrCreateChatSession(engine: LegionEngine): Promise<ChatSessionFile> {
  const dir = engine.store.paths.chatDir;
  await mkdir(dir, { recursive: true });
  let names: string[] = [];
  try {
    names = (await readdir(dir)).filter((name) => name.toLowerCase().endsWith(".json"));
  } catch {
    names = [];
  }
  let latest: ChatSessionFile | null = null;
  for (const name of names) {
    try {
      const raw = await readFile(join(dir, name), "utf8");
      const parsed = ChatSessionFileSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) continue;
      if (!latest || parsed.data.startedAt > latest.startedAt) latest = parsed.data;
    } catch {
      // skip unreadable session files
    }
  }
  if (latest) return latest;
  const created = createChatSession();
  await saveChatSession(engine, created);
  return created;
}

function wikiPromptLines(brief: { wiki: Array<{ path: string; title: string; trust: string; summary?: string | null }> }): string[] {
  const lines = ["Wiki (titles/paths only; untrusted bodies omitted):"];
  if (brief.wiki.length === 0) {
    lines.push("- (none)");
    return lines;
  }
  for (const page of brief.wiki) {
    const trust = page.trust === "untrusted" ? " untrusted" : "";
    lines.push(`- ${page.title} (${page.path})${trust}`);
  }
  return lines;
}

export async function buildChatPrompt(engine: LegionEngine, utterance: string, session: ChatSessionFile): Promise<string> {
  const state = await engine.getState();
  if (state.phase === "uninitialized") {
    refuse("chat is refused until init", HINT.init);
  }
  const brief = await engine.brief();
  const intent = await engine.getIntentState();
  let proposedId: string | undefined;
  try {
    const discuss = (await engine.store.readDiscuss()).data;
    proposedId = discuss.decisions.find((item) => item.status === "proposed")?.id;
  } catch {
    proposedId = undefined;
  }
  const recent = session.turns.slice(-8).map((turn) => {
    const action = turn.action ? ` action=${turn.action.type}` : "";
    return `${turn.role}:${action} ${redactSecrets(turn.text)}`.trim();
  });
  const lines = [
    renderSessionBrief(brief).trimEnd(),
    "",
    "## Chat",
    "Reply with a single JSON object (ChatAction). No markdown. Extra keys are ignored.",
    "Allowed types: status, search, next_verb, intent_answer, discuss_decide, ticket, assume_answer.",
    "Do not emit execute, ship, plan, spec_approve, control_mode, or wiki_trust.",
    "Do not include wiki page bodies. Titles and paths only.",
    `Phase: ${state.phase}`,
    `Next verb: legion-cli ${nextVerbForPhase(state.phase)}`,
    "",
    ...wikiPromptLines(brief),
    "",
    intent.nextQuestions.length > 0 ? `Intent questions:\n${intent.nextQuestions.map((q, i) => `${i + 1}. ${q}`).join("\n")}` : "Intent questions: (none)",
    proposedId ? `Proposed decision: ${proposedId}` : "Proposed decision: (none)",
    "",
    "Recent turns:",
    ...(recent.length > 0 ? recent : ["(none)"]),
    "",
    `User: ${redactSecrets(normalizeUtterance(utterance))}`,
  ];
  return `${lines.join("\n")}\n`;
}

async function readSpawnedAction(projectRoot: string, runId: string): Promise<unknown> {
  const paths = runCachePaths(projectRoot, runId);
  const abs = join(paths.runDir, "action.json");
  try {
    const raw = await readFile(abs, "utf8");
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return raw;
    }
  } catch {
    return undefined;
  }
}

async function proposedDecisionId(engine: LegionEngine): Promise<string | undefined> {
  try {
    const discuss = (await engine.store.readDiscuss()).data;
    return discuss.decisions.find((item) => item.status === "proposed")?.id;
  } catch {
    return undefined;
  }
}

export async function routeChatTurn(
  engine: LegionEngine,
  session: ChatSessionFile,
  utterance: string,
  opts?: ChatRouteOpts,
): Promise<ChatTurnResult> {
  const state = await engine.getState();
  if (state.phase === "uninitialized") {
    refuse("chat is refused until init", HINT.init);
  }
  const text = normalizeUtterance(utterance);
  if (!text) {
    refuse("chat requires an utterance", HINT.chat);
  }

  const intent = await engine.getIntentState();
  const proposedId = await proposedDecisionId(engine);
  const routed = ruleRouteChat({
    utterance: text,
    phase: state.phase,
    nextQuestions: intent.nextQuestions,
    proposedDecisionId: proposedId,
  });

  let spawned = false;
  let dropped = false;
  let local: "brief" | "help" | null = null;
  let action: ChatAction;

  if (routed === "brief" || routed === "help") {
    local = routed;
    action = { type: "next_verb" };
  } else if (routed) {
    action = routed;
  } else {
    let raw: unknown;
    const fixture = opts?.fixtureAction !== undefined ? opts.fixtureAction : engine.chatActionFixture();
    if (fixture !== undefined) {
      raw = fixture;
    } else {
      const prompt = await buildChatPrompt(engine, text, session);
      const spawn = await engine.spawnChatSkill(prompt, opts?.cliAdapter);
      spawned = spawn.spawned;
      raw = spawn.spawned ? await readSpawnedAction(engine.projectRoot, spawn.runId) : undefined;
    }
    if (raw !== undefined) {
      dropped = parseRawAction(raw) === null;
      action = sanitizeChatAction(raw, { phase: state.phase, utterance: text });
    } else {
      action = { type: "next_verb" };
    }
  }

  const kind: ChatTurnKind = dropped
    ? "dropped"
    : isChatProposalAction(action)
      ? "proposal"
      : "read";
  const nextHint = local ? `legion-cli ${nextVerbForPhase(state.phase)}` : nextHintForAction(action, state.phase);
  const proposal = kind === "proposal" && isChatProposalAction(action) ? formatChatProposal(action) : null;
  const output =
    kind === "proposal"
      ? (proposal ?? "")
      : kind === "dropped"
        ? `Next: ${nextHint}`
        : local === "help"
          ? "Chat routes into engine verbs. /status /next /brief /help /search, or type freely."
          : local === "brief"
            ? "brief"
            : "";

  const nextSession: ChatSessionFile = {
    ...session,
    turns: [
      ...session.turns,
      { role: "user", text: redactSecrets(text) },
      {
        role: "assistant",
        text: redactSecrets(proposal ?? output ?? action.type),
        ...(local ? {} : { action }),
      },
    ],
  };

  const idleEligible = !isSlashUtterance(text) && (action.type === "next_verb" || action.type === "search");
  const paused = idleEligible && idleTurnsFromSession(nextSession) >= CHAT_IDLE_LIMIT;

  await saveChatSession(engine, nextSession);
  return {
    session: nextSession,
    action,
    kind: kind === "dropped" ? "dropped" : kind,
    output: paused
      ? `Chat paused. Next: legion-cli ${nextVerbForPhase(state.phase)}`
      : output,
    proposal,
    nextHint: paused ? `legion-cli ${nextVerbForPhase(state.phase)}` : nextHint,
    paused,
    spawned,
    ...(local ? { local } : {}),
  };
}

export async function applyChatAction(
  engine: LegionEngine,
  action: ChatAction,
  opts?: { confirmed?: boolean },
): Promise<ChatApplyResult> {
  const state = await engine.getState();
  if (state.phase === "uninitialized") {
    refuse("chat is refused until init", HINT.init);
  }
  if (isChatProposalAction(action) && !opts?.confirmed) {
    return { applied: false, output: formatChatProposal(action) };
  }
  if (action.type === "status" || action.type === "next_verb") {
    return { applied: true, output: action.type };
  }
  if (action.type === "search") {
    const hits = await engine.search(action.q);
    return { applied: true, output: JSON.stringify(hits) };
  }
  if (action.type === "intent_answer") {
    await engine.intentTurn(action.answers);
    return { applied: true, output: "intent answers recorded" };
  }
  if (action.type === "discuss_decide") {
    const remaining = await engine.discuss([{ id: action.id, status: action.status } satisfies DecisionInput]);
    return { applied: true, output: remaining.length === 0 ? "decisions recorded" : "decision recorded" };
  }
  if (action.type === "assume_answer") {
    await engine.assumeAnswer(action.id, action.status);
    return { applied: true, output: `${action.status} ${action.id}` };
  }
  if (action.type === "ticket") {
    const input: NewTicket = { title: action.title, parentId: action.parentId };
    const ticket = await engine.fileTicket(input);
    return { applied: true, output: `Filed ${ticket.id}` };
  }
  return { applied: false, output: "" };
}
