import {
  applyChatAction,
  createLegionEngine,
  findSkillsDir,
  HINT,
  isChatProposalAction,
  nextVerbForPhase,
  refuse,
  resumeOrCreateChatSession,
  routeChatTurn,
  type ChatTurnResult,
} from "@9thlevelsoftware/legion-cli-core";
import type { AdapterId, ChatAction, ChatSessionFile, ControlMode } from "@9thlevelsoftware/legion-cli-schema";
import { parseAdapterFlag } from "./adapter-route.js";
import { runBrief } from "./brief.js";
import { formatHelpLayer1 } from "./help-all.js";
import type { CliOpts } from "./io.js";
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
): Promise<void> {
  if (turn.local === "brief") {
    await runBrief(opts);
    return;
  }
  if (turn.local === "help") {
    writeOut(turn.output);
    return;
  }
  if (action.type === "status") {
    await runStatus(opts);
    return;
  }
  if (action.type === "search") {
    await runSearch(opts, action.q, {});
    return;
  }
  if (turn.kind === "dropped") {
    writeOut(turn.output);
    return;
  }
  if (action.type === "next_verb") {
    writeOut(await formatNextVerb(engine));
    return;
  }
  if (turn.output) writeOut(turn.output);
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
    fixtureAction: engine.chatActionFixture(),
  });

  if (turn.paused) {
    const state = await engine.getState();
    writeOut(`Next: legion-cli ${nextVerbForPhase(state.phase)}`);
    writeOut(turn.output);
    return { code: 0, session: turn.session, stop: true };
  }

  if (turn.kind === "dropped") {
    writeOut(turn.output);
    return { code: 0, session: turn.session, stop: flags.once };
  }

  if (turn.kind === "proposal" && isChatProposalAction(turn.action)) {
    if (opts.yes && turn.action.type === "discuss_decide") {
      refuse("discuss --yes cannot skip product decisions", HINT.discuss);
    }
    writeOut(turn.proposal ?? turn.output);
    if (flags.once || !isTty()) {
      writeErr(`Next: ${turn.nextHint}`);
      return { code: 1, session: turn.session, stop: true };
    }
    const answer = await readLine("> ");
    if (!isYes(answer)) {
      writeOut("Not applied.");
      return { code: 0, session: turn.session, stop: false };
    }
    const applied = await applyChatAction(engine, turn.action, { confirmed: true });
    if (applied.output) writeOut(applied.output);
    return { code: 0, session: turn.session, stop: false };
  }

  await printRead(opts, engine, turn.action, turn);
  return { code: 0, session: turn.session, stop: flags.once };
}

export async function runChat(opts: CliOpts, flags: ChatFlags): Promise<number> {
  const once = flags.once;
  if (!once && !isTty()) {
    refuse("chat requires a TTY or --once", HINT.chat);
  }
  const adapter = parseAdapterFlag(flags.adapter);
  const engine = createLegionEngine(opts.project, {
    skillsDir: findSkillsDir(),
    chatActionFixture: fixtureFromEnv(),
  });
  const state = await engine.getState();
  if (state.phase === "uninitialized") {
    refuse("chat is refused until init", HINT.init);
  }

  try {
    let session = await resumeOrCreateChatSession(engine);
    if (once !== undefined) {
      if (opts.json) {
        const turn = await routeChatTurn(engine, session, once, {
          cliAdapter: adapter,
          fixtureAction: engine.chatActionFixture(),
        });
        if (turn.kind === "proposal" && isChatProposalAction(turn.action)) {
          if (opts.yes && turn.action.type === "discuss_decide") {
            refuse("discuss --yes cannot skip product decisions", HINT.discuss);
          }
          writeJson({
            ok: false,
            action: turn.action,
            proposed: turn.proposal,
            next: turn.nextHint,
          });
          return 1;
        }
        writeJson({
          ok: true,
          action: turn.action,
          next: turn.nextHint,
          paused: turn.paused,
          dropped: turn.kind === "dropped",
        });
        return 0;
      }
      const result = await handleTurn(opts, engine, session, once, { once: true, adapter });
      return result.code;
    }

    writeOut("legion-cli chat. /status /next /brief /help /search, or type freely.");
    for (;;) {
      const line = await readLine("> ");
      if (!line) continue;
      if (/^(exit|quit)$/i.test(line)) return 0;
      if (/^\/help$/i.test(line)) {
        writeOut("Chat routes into engine verbs. Read commands auto-apply; mutating actions print Proposed: … [Y/n].");
        writeOut(formatHelpLayer1().trimEnd());
        continue;
      }
      const result = await handleTurn(opts, engine, session, line, { once: false, adapter });
      session = result.session;
      if (result.stop) return result.code;
    }
  } finally {
    closePrompt();
  }
}
