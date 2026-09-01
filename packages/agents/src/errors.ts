import type { AgentAdapterId } from "./types.js";

export class AgentError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AgentError";
  }
}

export class AdapterNotEnabled extends AgentError {
  readonly id: AgentAdapterId;

  constructor(id: AgentAdapterId) {
    super(`${id} is detect-only in v0`);
    this.name = "AdapterNotEnabled";
    this.id = id;
  }
}

export class AdapterConfigError extends AgentError {
  constructor(message: string) {
    super(message);
    this.name = "AdapterConfigError";
  }
}
