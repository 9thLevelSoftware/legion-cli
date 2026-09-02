import { existsSync } from "node:fs";
import { join } from "node:path";
import { DS_HINT, refuse } from "./errors.js";
import { LEGION_DIR } from "./paths.js";

export function assertInitialized(projectRoot: string): void {
  if (!existsSync(join(projectRoot, LEGION_DIR, "STATE.md"))) {
    refuse("this folder is not a Legion CLI project", DS_HINT.init);
  }
}
