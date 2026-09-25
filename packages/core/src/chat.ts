import { randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { runCachePaths } from "@9thlevelsoftware/legion-cli-agents";
import { ensureGitignore, redactSecrets, toFsPath } from "@9thlevelsoftware/legion-cli-persist";
import {
  ChatActionSchema,
  ChatProposalActionSchema,
  ChatSessionFileSchema,
  SCHEMA_VERSION,
  type AdapterId,
  type ChatAction,
  type ChatProposalAction,
  type ChatReadAction,
  type ChatSessionFile,
  type Phase,
} from "@9thlevelsoftware/legion-cli-schema";
import { renderSessionBrief } from "@9thlevelsoftware/legion-cli-wiki";
import { atomicWriteFile } from "./atomic-write.js";
import { HINT, refuse } from "./errors.js";
import type { LegionEngine } from "./engine.js";
import { isSliceTerminal } from "./slice.js";
import type { DecisionInput, NewTicket } from "./types.js";

const CHAT_IDLE_LIMIT = 4;

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
  cliAdapter?: AdapterId;
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

export function isChatProposalAction(action: ChatAction): action is ChatProposalAction {
  return ChatProposalActionSchema.safeParse(action).success;
}

function nextVerbForPhase(phase: Phase): string {
  switch (phase) {
    case "uninitialized":
      return "init";
    case "initialized":
    case "intent_draft":
      return "intent";
    case "intent_ready":
      return "discuss";
    case "discussing":
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

async function nextVerbForState(engine: LegionEngine, phase: Phase): Promise<string> {
  if (phase === "uninitialized") return "legion-cli init";
  let mode: "greenfield" | "brownfield" | undefined;
  let controlMode: string | undefined;
  try {
    mode = (await engine.store.readProject()).data.mode;
  } catch {
    mode = undefined;
  }
  try {
    controlMode = (await engine.store.readConfig()).control_mode;
  } catch {
    controlMode = undefined;
  }
  const slice = await engine.listSliceTasks();
  if (phase === "initialized" && mode === "brownfield") return "legion-cli brownfield";
  if (phase === "executing" && isSliceTerminal(slice)) {
    const state = await engine.getState();
    return state.lastReview === "PASS" ? "legion-cli qa" : "legion-cli review";
  }
  const wouldExecute = phase === "plan_ready" || (phase === "executing" && !isSliceTerminal(slice));
  if (controlMode === "advisory" && wouldExecute) return "legion-cli control-mode guarded";
  return `legion-cli ${nextVerbForPhase(phase)}`;
}

async function nextHintForAction(engine: LegionEngine, action: ChatAction, phase: Phase): Promise<string> {
  switch (action.type) {
    case "intent_answer":
      return HINT.intent;
    case "discuss_decide":
      return HINT.discuss;
    case "assume_answer":
      return HINT.assumeAnswer;
    case "ticket":
      return HINT.ticket("TSK-x");
    default:
      return nextVerbForState(engine, phase);
  }
}

function formatChatProposal(action: ChatProposalAction): string {
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
  if (/^\/status(?:\s|$)/i.test(trimmed)) return { type: "status" };
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
  const search = /^search\s+(.+)$/i.exec(trimmed);
  if (search) {
    const q = search[1].trim();
    if (q) return { type: "search", q };
  }
  return null;
}

function isRequestedRead(utterance: string): boolean {
  return parseSlash(utterance) !== null || parseNaturalRead(utterance) !== null;
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
  return answers.length === 1 && answers[0] === normalized.trim();
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

/** Single gate for drop vs keep of intent_answer (router, sanitize, apply). */
export function gateChatAction(
  action: ChatAction,
  ctx: { phase: Phase; utterance?: string },
): ChatAction {
  if (action.type !== "intent_answer") return action;
  if (ctx.phase !== "intent_draft") return { type: "next_verb" };
  if (ctx.utterance !== undefined && !answersAreParseOf(action.answers, ctx.utterance)) {
    return { type: "next_verb" };
  }
  return action;
}

export function sanitizeChatAction(
  raw: unknown,
  ctx: { phase: Phase; utterance: string },
): ChatAction {
  const parsed = parseRawAction(raw);
  if (!parsed) return { type: "next_verb" };
  return gateChatAction(parsed, ctx);
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
  if (input.nextQuestions.length > 0) {
    const answers = splitAnswerLines(input.utterance);
    if (answers.length > 0) {
      const gated = gateChatAction(
        { type: "intent_answer", answers },
        { phase: input.phase, utterance: input.utterance },
      );
      if (gated.type === "intent_answer") return gated;
    }
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

export function idleTurnsFromSession(session: ChatSessionFile): number {
  const turns = session.turns;
  const userBefore: Array<string | undefined> = new Array(turns.length);
  let lastUser: string | undefined;
  for (let i = 0; i < turns.length; i++) {
    userBefore[i] = lastUser;
    if (turns[i].role === "user") lastUser = turns[i].text;
  }
  let count = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (turn.role !== "assistant") continue;
    const userText = userBefore[i];
    if (userText !== undefined && isRequestedRead(userText)) break;
    if (turn.action?.type !== "next_verb" && turn.action?.type !== "search") break;
    count += 1;
  }
  return count;
}

const ENGINE_SESSION_FILE = /^chat-[0-9a-z]+-[0-9a-f]{8}\.json$/;

function chatSessionPath(id: string): string {
  const safe = id.trim();
  if (!safe || /[\\/]/.test(safe) || safe.includes("..")) {
    refuse("invalid chat session id", HINT.chat);
  }
  return `.legion-cli/chat/${safe}.json`;
}

async function writeSessionFile(engine: LegionEngine, session: ChatSessionFile): Promise<void> {
  const parsed = ChatSessionFileSchema.parse(session);
  const abs = toFsPath(engine.projectRoot, chatSessionPath(parsed.id));
  const body = redactSecrets(`${JSON.stringify(parsed, null, 2)}\n`);
  await atomicWriteFile(abs, body, { symlinkMessage: "chat session path is a symlink", root: engine.projectRoot });
}

export async function saveChatSession(engine: LegionEngine, session: ChatSessionFile): Promise<void> {
  await engine.store.withLock(() => writeSessionFile(engine, session));
}

export async function resumeOrCreateChatSession(engine: LegionEngine): Promise<ChatSessionFile> {
  await ensureGitignore(engine.projectRoot);
  return engine.store.withLock(async () => {
    const dir = engine.store.paths.chatDir;
    await mkdir(dir, { recursive: true });
    let names: string[] = [];
    try {
      names = (await readdir(dir)).filter((name) => ENGINE_SESSION_FILE.test(name));
    } catch {
      names = [];
    }
    let latest: ChatSessionFile | null = null;
    for (const name of names) {
      const abs = join(dir, name);
      try {
        const st = await lstat(abs);
        if (st.isSymbolicLink()) continue;
        const raw = await readFile(abs, "utf8");
        const parsed = ChatSessionFileSchema.safeParse(JSON.parse(raw));
        if (!parsed.success) continue;
        if (parsed.data.id !== name.slice(0, -".json".length)) continue;
        if (!latest || parsed.data.startedAt > latest.startedAt) latest = parsed.data;
      } catch {
        // skip unreadable session files
      }
    }
    if (latest) return latest;
    const created = createChatSession();
    await writeSessionFile(engine, created);
    return created;
  });
}

export async function buildChatPrompt(
  engine: LegionEngine,
  utterance: string,
  session: ChatSessionFile,
): Promise<string> {
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
    "Do not include wiki page bodies. Use titles and paths from SessionBrief above; never inline page bodies.",
    `Phase: ${state.phase}`,
    `Next verb: ${await nextVerbForState(engine, state.phase)}`,
    "",
    intent.nextQuestions.length > 0
      ? `Intent questions:\n${intent.nextQuestions.map((q, i) => `${i + 1}. ${q}`).join("\n")}`
      : "Intent questions: (none)",
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
  let requestedRead = false;

  if (routed === "brief" || routed === "help") {
    local = routed;
    action = { type: "next_verb" };
    requestedRead = true;
  } else if (routed) {
    requestedRead = true;
    const gated = gateChatAction(routed, { phase: state.phase, utterance: text });
    dropped = gated.type !== routed.type;
    action = gated;
  } else {
    let raw: unknown;
    if (opts?.fixtureAction !== undefined) {
      raw = opts.fixtureAction;
    } else {
      const prompt = await buildChatPrompt(engine, text, session);
      const spawn = await engine.spawnChatSkill(prompt, opts?.cliAdapter);
      spawned = spawn.spawned;
      raw = spawn.spawned ? await readSpawnedAction(engine.projectRoot, spawn.runId) : undefined;
    }
    if (raw !== undefined) {
      const parsed = parseRawAction(raw);
      dropped = parsed === null;
      const sanitized = sanitizeChatAction(raw, { phase: state.phase, utterance: text });
      if (parsed && sanitized.type !== parsed.type) dropped = true;
      action = sanitized;
    } else {
      action = { type: "next_verb" };
    }
  }

  const kind: ChatTurnKind = dropped
    ? "dropped"
    : isChatProposalAction(action)
      ? "proposal"
      : "read";
  const nextHint = local
    ? await nextVerbForState(engine, state.phase)
    : await nextHintForAction(engine, action, state.phase);
  const proposal = kind === "proposal" && isChatProposalAction(action) ? formatChatProposal(action) : null;
  const output =
    kind === "proposal"
      ? (proposal ?? "")
      : kind === "dropped"
        ? `Dropped. Next: ${nextHint}`
        : local === "help"
          ? "Chat routes into engine verbs. /status /next /brief /help /search, or type freely."
          : local === "brief"
            ? "brief"
            : "";

  const userTurnId = `turn-${randomBytes(4).toString("hex")}`;
  const assistantTurnId = `turn-${randomBytes(4).toString("hex")}`;
  const nextSession: ChatSessionFile = {
    ...session,
    turns: [
      ...session.turns,
      { id: userTurnId, role: "user", text: redactSecrets(text) },
      {
        id: assistantTurnId,
        role: "assistant",
        text: redactSecrets(proposal ?? output ?? action.type),
        ...(local ? {} : { action }),
      },
    ],
  };

  const idleEligible =
    !requestedRead && (action.type === "next_verb" || action.type === "search") && kind !== "proposal";
  const paused = idleEligible && idleTurnsFromSession(nextSession) >= CHAT_IDLE_LIMIT;

  await saveChatSession(engine, nextSession);
  return {
    session: nextSession,
    action,
    kind,
    output,
    proposal,
    nextHint,
    paused,
    spawned,
    ...(local ? { local } : {}),
  };
}

export async function applyChatAction(
  engine: LegionEngine,
  action: ChatAction,
  opts?: { confirmed?: boolean; utterance?: string },
): Promise<ChatApplyResult> {
  const rawType = (action as { type?: string }).type;
  if (typeof rawType === "string" && ILLEGAL_MODEL_TYPES.has(rawType)) {
    refuse(`chat cannot apply ${rawType}`, HINT.status);
  }
  const state = await engine.getState();
  if (state.phase === "uninitialized") {
    refuse("chat is refused until init", HINT.init);
  }
  const gated = gateChatAction(action, { phase: state.phase, utterance: opts?.utterance });
  if (gated.type !== action.type) {
    return { applied: false, output: `Next: ${await nextHintForAction(engine, gated, state.phase)}` };
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

export function forkChatSession(
  session: ChatSessionFile,
  fromTurnId: string,
): ChatSessionFile {
  const targetIdx = session.turns.findIndex((t) => t.id === fromTurnId);
  if (targetIdx < 0) {
    refuse(`turn id '${fromTurnId}' not found in chat session`, "legion-cli chat");
  }
  const branchId = `branch-${randomBytes(4).toString("hex")}`;
  const truncatedTurns = session.turns.slice(0, targetIdx + 1).map((t) => ({ ...t }));
  return {
    ...session,
    id: `chat-${randomBytes(4).toString("hex")}`,
    activeBranchId: branchId,
    turns: truncatedTurns,
  };
}
