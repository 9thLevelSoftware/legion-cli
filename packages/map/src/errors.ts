export class MapError extends Error {
  readonly nextHint: string;

  constructor(message: string, nextHint: string) {
    super(message);
    this.name = "MapError";
    this.nextHint = nextHint;
  }
}

export const MAP_HINT = {
  noLsp: "legion-cli map --no-lsp",
  concretePaths: "concrete paths",
  doctor: "legion-cli doctor",
} as const;

export function refuse(message: string, nextHint: string): never {
  throw new MapError(message, nextHint);
}
