export class DesignSystemError extends Error {
  readonly nextHint: string;

  constructor(message: string, nextHint: string) {
    super(message);
    this.name = "DesignSystemError";
    this.nextHint = nextHint;
  }
}

export const DS_HINT = {
  init: "legion-cli init",
  show: "legion-cli design-system show",
  install: "legion-cli design-system install <dir|github:owner/repo@tag>",
  importOd: "legion-cli design-system import-od <dir>",
  generate: "legion-cli design-system generate",
  localOnly: "legion-cli design-system install <dir|github:owner/repo@tag>",
} as const;

export function refuse(message: string, nextHint: string): never {
  throw new DesignSystemError(message, nextHint);
}
