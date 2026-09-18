---
name: chat
description: >
  Optional spawn that emits one ChatAction JSON object for the chat REPL.
  Activated only by `legion-cli chat` when a spawnable adapter exists. Do not load other skill bodies.
license: UNLICENSED
compatibility: "Legion CLI staging; not vendor auto-discovery"
metadata:
  legion:
    skillId: chat
    required: false
    allowedRootsRef: SKILL_CONTRACTS.chat
---

# chat

Optional spawn that chooses a ChatAction for the in-process router.

The engine, not this spawn, applies reads and prints proposals. Mutating actions need an explicit TTY Y. `--yes` cannot skip discuss. `--once` cannot skip gates.

## Contract

Allowed roots:

- `.legion-cli/cache/runs/<id>/**`

Do not write anything else. Do not `git add` or `git commit`.

Implicit forbidden still applies: `.git/**`, `.env*`, `.legion-cli/config.yaml`, `.legion-cli/index/**`.

## Task

Read the chat prompt. Wiki entries are titles and paths only. Untrusted page bodies are omitted on purpose — do not ask for them.

Write a single ChatAction JSON object to `.legion-cli/cache/runs/<id>/action.json`. Extra keys are stripped. Do not emit execute, ship, plan, spec_approve, control_mode, or wiki_trust.

Allowed types:

- `status`
- `search` with `q`
- `next_verb`
- `intent_answer` with 1–2 `answers` parsed from the user's last utterance, only in `intent_draft` / `intent_ready`
- `discuss_decide` with `id` and `status` accepted|rejected
- `ticket` with `title`
- `assume_answer` with `id` and `status` confirmed|rejected

When finished, write a short summary to `.legion-cli/cache/runs/<id>/summary.md`.
