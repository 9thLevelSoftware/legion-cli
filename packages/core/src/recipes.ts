import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { ARGV_ONLY_MESSAGE, parseCommandLine } from "@9thlevelsoftware/legion-cli-agents";
import {
  RecipeSchema,
  RecipesLockSchema,
  type Recipe,
  type RecipeStep,
} from "@9thlevelsoftware/legion-cli-schema";
import { refuse } from "./errors.js";

export const RECIPE_ARGV_ONLY_MESSAGE = "recipe commands are argv-only; split it into separate commands";
export const COMMUNITY_RECIPE_LOCK_MESSAGE = "community recipe requires a verified recipes.lock";

export type RecipeExecutionResult = {
  recipeName: string;
  success: boolean;
  stepsRun: number;
  stepOutputs: Array<{ id: string; success: boolean; output: string }>;
  error?: string;
};

export function recipesLockPath(projectRoot: string): string {
  return join(projectRoot, ".legion-cli", "recipes.lock");
}

function sha256Bytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function recipeFileBytes(projectRoot: string, recipe: Recipe): Promise<Buffer | undefined> {
  for (const ext of ["yaml", "yml"]) {
    const candidate = join(projectRoot, ".legion-cli", "recipes", `${recipe.name}.${ext}`);
    if (existsSync(candidate)) return readFile(candidate);
  }
  return undefined;
}

export async function assertRecipeExecutionPolicy(opts: {
  projectRoot: string;
  recipe: Recipe;
}): Promise<void> {
  const origin = opts.recipe.origin ?? "local";
  if (origin !== "community") return;
  const lockPath = recipesLockPath(opts.projectRoot);
  if (!existsSync(lockPath)) {
    refuse(COMMUNITY_RECIPE_LOCK_MESSAGE, "legion-cli recipe list");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(lockPath, "utf8"));
  } catch {
    refuse(COMMUNITY_RECIPE_LOCK_MESSAGE, "legion-cli recipe list");
  }
  const lock = RecipesLockSchema.safeParse(parsed);
  if (!lock.success) {
    refuse("invalid recipes.lock", "legion-cli recipe list");
  }
  const entry = lock.data.recipes[opts.recipe.name];
  if (!entry) {
    refuse(COMMUNITY_RECIPE_LOCK_MESSAGE, "legion-cli recipe list");
  }
  const bytes = await recipeFileBytes(opts.projectRoot, opts.recipe);
  if (!bytes) {
    refuse(COMMUNITY_RECIPE_LOCK_MESSAGE, "legion-cli recipe list");
  }
  if (sha256Bytes(bytes) !== entry.sha256) {
    refuse(`recipes.lock hash mismatch for recipe '${opts.recipe.name}'`, "legion-cli recipe list");
  }
}

function spawnRecipeCommand(cmd: string, root: string) {
  const parsed = parseCommandLine(cmd);
  if ("error" in parsed) {
    refuse(
      parsed.error === ARGV_ONLY_MESSAGE ? RECIPE_ARGV_ONLY_MESSAGE : parsed.error,
      "legion-cli recipe list",
    );
  }
  return spawnSync(parsed.argv[0], parsed.argv.slice(1), {
    cwd: root,
    shell: false,
    encoding: "utf8",
    windowsHide: true,
  });
}

export async function loadRecipe(recipePathOrName: string, projectRoot: string): Promise<Recipe> {
  let fileToRead = recipePathOrName;
  if (!existsSync(fileToRead)) {
    const candidate = join(projectRoot, ".legion-cli", "recipes", `${recipePathOrName}.yaml`);
    const candidateYml = join(projectRoot, ".legion-cli", "recipes", `${recipePathOrName}.yml`);
    if (existsSync(candidate)) fileToRead = candidate;
    else if (existsSync(candidateYml)) fileToRead = candidateYml;
    else {
      refuse(`recipe '${recipePathOrName}' not found in .legion-cli/recipes/`, "legion-cli recipe list");
    }
  }

  const content = await readFile(fileToRead, "utf8");
  const parsed = parseYaml(content);
  const result = RecipeSchema.safeParse(parsed);
  if (!result.success) {
    refuse(`invalid recipe schema in ${fileToRead}: ${result.error.message}`, "legion-cli help --all");
  }
  return result.data;
}

export async function runRecipe(opts: {
  projectRoot: string;
  recipe: Recipe;
  params?: Record<string, unknown>;
  onStepStart?: (step: RecipeStep) => void;
  callMcpTool?: (tool: string, args: Record<string, unknown>) => Promise<{ content: Array<{ text?: string }>; isError?: boolean } | null>;
}): Promise<RecipeExecutionResult> {
  const root = resolve(opts.projectRoot);
  await assertRecipeExecutionPolicy({ projectRoot: root, recipe: opts.recipe });
  const mergedParams = { ...(opts.recipe.parameters ? Object.fromEntries(Object.entries(opts.recipe.parameters).map(([k, v]) => [k, v.default])) : {}), ...(opts.params ?? {}) };

  const outputs: Array<{ id: string; success: boolean; output: string }> = [];

  for (const step of opts.recipe.steps) {
    opts.onStepStart?.(step);

    if (step.action === "command") {
      let cmd = step.tool ?? "";
      for (const [k, v] of Object.entries(mergedParams)) {
        cmd = cmd.replaceAll(`{{${k}}}`, String(v ?? ""));
      }
      const res = spawnRecipeCommand(cmd, root);
      const success = res.status === 0;
      const output = `${res.stdout}\n${res.stderr}`.trim();
      outputs.push({ id: step.id, success, output });
      if (!success) {
        return {
          recipeName: opts.recipe.name,
          success: false,
          stepsRun: outputs.length,
          stepOutputs: outputs,
          error: `step '${step.id}' command failed: ${output}`,
        };
      }
    } else if (step.action === "mcp_tool") {
      if (!opts.callMcpTool || !step.tool) {
        outputs.push({ id: step.id, success: false, output: "MCP tool executor not configured" });
        return {
          recipeName: opts.recipe.name,
          success: false,
          stepsRun: outputs.length,
          stepOutputs: outputs,
          error: `MCP tool executor not available for step '${step.id}'`,
        };
      }
      const toolRes = await opts.callMcpTool(step.tool, step.params ?? {});
      const success = toolRes ? !toolRes.isError : false;
      const text = toolRes?.content.map((c) => c.text ?? "").join("\n") ?? "";
      outputs.push({ id: step.id, success, output: text });
      if (!success) {
        return {
          recipeName: opts.recipe.name,
          success: false,
          stepsRun: outputs.length,
          stepOutputs: outputs,
          error: `MCP tool '${step.tool}' failed in step '${step.id}'`,
        };
      }
    } else if (step.action === "verify") {
      const cmd = step.tool ?? "npm test";
      const res = spawnRecipeCommand(cmd, root);
      const success = res.status === 0;
      const output = `${res.stdout}\n${res.stderr}`.trim();
      outputs.push({ id: step.id, success, output });
      if (!success) {
        return {
          recipeName: opts.recipe.name,
          success: false,
          stepsRun: outputs.length,
          stepOutputs: outputs,
          error: `verification step '${step.id}' failed`,
        };
      }
    } else {
      outputs.push({ id: step.id, success: true, output: `Prompt step completed: ${step.description}` });
    }
  }

  return {
    recipeName: opts.recipe.name,
    success: true,
    stepsRun: outputs.length,
    stepOutputs: outputs,
  };
}
