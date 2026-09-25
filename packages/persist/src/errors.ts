export class PersistError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PersistError";
  }
}

export class EngineLockedError extends PersistError {
  constructor(message = "another legion-cli is running.") {
    super(message);
    this.name = "EngineLockedError";
  }
}

export class PathEscapeError extends PersistError {
  constructor(path: string) {
    super(`path is outside the project workspace: ${path}`);
    this.name = "PathEscapeError";
  }
}

function firstCauseIssue(cause: unknown): string | undefined {
  const issues = (cause as { issues?: Array<{ message?: string }> } | undefined)?.issues;
  if (Array.isArray(issues)) {
    const message = issues[0]?.message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  if (cause instanceof Error && cause.message) return cause.message;
  return undefined;
}

export class PersistValidationError extends PersistError {
  constructor(path: string, cause?: unknown) {
    const detail = firstCauseIssue(cause);
    super(detail ? `Invalid Legion CLI document: ${path}: ${detail}` : `Invalid Legion CLI document: ${path}`, {
      cause,
    });
    this.name = "PersistValidationError";
  }
}

export class MinisignError extends PersistError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MinisignError";
  }
}

/** A write target, or a directory between the project root and it, is a symlink or junction. */
export class SymlinkRefusedError extends PersistError {
  readonly path: string;
  constructor(message: string, path: string) {
    super(message);
    this.name = "SymlinkRefusedError";
    this.path = path;
  }
}

/** Restore refused: agent still alive, jail still writable, or git failed closed. */
export class RestoreRefusedError extends PersistError {
  constructor(message: string) {
    super(message);
    this.name = "RestoreRefusedError";
  }
}

/** Audit digest chain gap or rewrite. Never byte-exact rewind. */
export class AuditTamperError extends PersistError {
  constructor(message: string) {
    super(message);
    this.name = "AuditTamperError";
  }
}
