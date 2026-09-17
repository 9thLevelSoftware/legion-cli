import type { MapLspMode, MapOptions as GenerateMapOptions } from "@9thlevelsoftware/legion-cli-map";

export type { MapLspMode };

export type MapOptions = {
  refresh?: boolean;
  lsp?: MapLspMode;
  resolveBinary?: GenerateMapOptions["resolveBinary"];
  spawnLsp?: GenerateMapOptions["spawnLsp"];
  lspDeadlineMs?: number;
};

export type MapResult = {
  path: string;
  fingerprintsPath: string;
  backend: "lsp" | "fallback";
  modules: number;
  changed: string[];
  next: string;
};

export const MAP_ARCHITECTURE_PATH = ".legion-cli/map/ARCHITECTURE.md";
export const MAP_FINGERPRINTS_PATH = ".legion-cli/map/fingerprints.json";
export const MAP_SHOW_NEXT = `legion-cli show ${MAP_ARCHITECTURE_PATH}`;

export const MAP_SPAWN_PROMPT = [
  "The architecture map is already generated in-process.",
  `You may rewrite human-editable sections of ${MAP_ARCHITECTURE_PATH} outside the generated markers.`,
  "Do not remove <!-- legion-cli:generated:start --> or <!-- legion-cli:generated:end --> or rewrite the block between them.",
  "Do not write product code (src/**).",
].join("\n");
