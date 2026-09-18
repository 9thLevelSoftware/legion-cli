import {
  applyChatAction,
  createLegionEngine,
  findSkillsDir,
  HINT,
  isChatProposalAction,
  refuse,
  resumeOrCreateChatSession,
  routeChatTurn,
  type ChatTurnResult,
} from "@9thlevelsoftware/legion-cli-core";
import type { AdapterId, ChatAction, ChatSessionFile, ControlMode } from "@9thlevelsoftware/legion-cli-schema";
import { parseAdapterFlag } from "./adapter-route.js";
import { runBrief } from "./brief.js";
import type { CliOpts } from "./io.js";
import { formatHelpLayer1 } from "./help-all.js";
import { writeErr, writeJson, writeOut } from "./io.js";
import { nextCommand } from "./next.js";
import { closePrompt, isYes, readLine } from "./prompt.js";
import { runSearch } from "./search.js";
import { runStatus } from "./status.js";

export type ChatFlags = {
  once?: string;
  adapter?: string;
};

function isTty(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function fixtureFromEnv(): unknown {
  const raw = process.env.LEGION_CLI_CHAT_ACTION;
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

async function formatNextVerb(engine: ReturnType<typeof createLegionEngine>): Promise<string> {
  const state = await engine.getState();
  let mode: "greenfield" | "brownfield" | undefined;
  let controlMode: ControlMode | undefined;
  if (state.phase !== "uninitialized") {
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
  }
  const slice = state.phase === "uninitialized" ? [] : await engine.listSliceTasks();
  const next = nextCommand(state, slice, mode, controlMode);
  return `Next: ${next.run}`;
}

async function printRead(
  opts: CliOpts,
  engine: ReturnType<typeof createLegionEngine>,
  action: ChatAction,
  turn: ChatTurnResult,
): Promise<number> {
  if (turn.local === "brief") {
    await runBrief(opts);
    return 0;
  }
  if (turn.local === "help") {
    const help = formatHelpLayer1();
    if (opts.json) writeJson({ kind: "help", output: help, next: turn.nextHint });
    else writeOut(help);
    return 0;
  }
  if (action.type === "status") {
    return runStatus(opts);
  }
  if (action.type === "search") {
    await runSearch(opts, action.q, {});
    return 0;
  }
  if (turn.kind === "dropped") {
    if (opts.json) writeJson({ kind: "dropped", next: turn.nextHint, paused: turn.paused });
    else writeOut(`Dropped. Next: ${turn.nextHint}`);
    return 0;
  }
  if (action.type === "next_verb") {
    if (opts.json) {
      const next = await formatNextVerb(engine);
      writeJson({ kind: "next", next: next.replace(/^Next: /, ""), paused: turn.paused });
    } else writeOut(await formatNextVerb(engine));
    return 0;
  }
  if (turn.output) {
    if (opts.json) writeJson({ kind: turn.kind, output: turn.output, next: turn.nextHint, paused: turn.paused });
    else writeOut(turn.output);
  }
  return 0;
}

async function handleTurn(
  opts: CliOpts,
  engine: ReturnType<typeof createLegionEngine>,
  session: ChatSessionFile,
  utterance: string,
  flags: { once: boolean; adapter?: AdapterId },
): Promise<{ code: number; session: ChatSessionFile; stop: boolean }> {
  const turn = await routeChatTurn(engine, session, utterance, {
    cliAdapter: flags.adapter,
    fixtureAction: fixtureFromEnv(),
  });

  if (turn.kind === "proposal" && isChatProposalAction(turn.action)) {
    if (opts.yes && turn.action.type === "discuss_decide") {
      refuse("discuss --yes cannot skip product decisions", HINT.discuss);
    }
    if (opts.json) {
      writeJson({ kind: "proposal", proposal: turn.proposal ?? turn.output, next: turn.nextHint });
    } else writeOut(turn.proposal ?? turn.output);
    if (flags.once || !isTty()) {
      if (!opts.json) writeErr(`Next: ${turn.nextHint}`);
      return { code: 1, session: turn.session, stop: true };
    }
    const answer = await readLine("> ");
    if (!isYes(answer)) {
      if (opts.json) writeJson({ applied: false });
      else writeOut("Not applied.");
      return { code: 0, session: turn.session, stop: false };
    }
    const applied = await applyChatAction(engine, turn.action, { confirmed: true, utterance });
    if (applied.output) {
      if (opts.json) writeJson({ applied: true, output: applied.output });
      else writeOut(applied.output);
    }
    return { code: 0, session: turn.session, stop: false };
  }

  const code = await printRead(opts, engine, turn.action, turn);
  if (turn.paused) {
    if (opts.json) {
      writeJson({ paused: true, next: turn.nextHint });
    } else {
      writeOut("Chat paused.");
      if (turn.action.type === "search" || turn.kind === "dropped") {
        writeOut(await formatNextVerb(engine));
      }
    }
    return { code, session: turn.session, stop: true };
  }
  return { code, session: turn.session, stop: flags.once };
}

export async function runChat(opts: CliOpts, flags: ChatFlags): Promise<number> {
  const once = flags.once;
  if (once === undefined && !isTty()) {
    refuse("chat requires a TTY or --once", HINT.chat);
  }
  const adapter = parseAdapterFlag(flags.adapter);
  const engine = createLegionEngine(opts.project, {
    skillsDir: findSkillsDir(),
  });
  const state = await engine.getState();
  if (state.phase === "uninitialized") {
    refuse("chat is refused until init", HINT.init);
  }

  try {
    let session = await resumeOrCreateChatSession(engine);
    if (once !== undefined) {
      const result = await handleTurn(opts, engine, session, once, { once: true, adapter });
      return result.code;
    }

    writeOut("legion-cli chat. /status /next /brief /help /search, or type freely.");
    for (;;) {
      const line = await readLine("> ");
      if (!line) continue;
      if (/^(exit|quit)$/i.test(line)) return 0;
      const result = await handleTurn(opts, engine, session, line, { once: false, adapter });
      session = result.session;
      if (result.stop) return result.code;
    }
  } finally {
    closePrompt();
  }
}
