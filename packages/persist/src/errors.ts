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

export class PersistValidationError extends PersistError {
  constructor(path: string, cause?: unknown) {
    super(`Invalid Legion CLI document: ${path}`, { cause });
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
