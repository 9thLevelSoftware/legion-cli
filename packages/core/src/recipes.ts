import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { ARGV_ONLY_MESSAGE, parseCommandLine, runCommand } from "@9thlevelsoftware/legion-cli-agents";
import {
  RecipeSchema,
  RecipesLockSchema,
  type Recipe,
  type RecipeStep,
} from "@9thlevelsoftware/legion-cli-schema";
import { refuse } from "./errors.js";
import { DEFAULT_VERIFICATION_TIMEOUT_MS } from "./verify.js";

export const RECIPE_ARGV_ONLY_MESSAGE = "recipe commands are argv-only; split it into separate commands";
export const COMMUNITY_RECIPE_LOCK_MESSAGE = "community recipe requires a verified recipes.lock";
export const COMMUNITY_RECIPE_PATH_MESSAGE =
  "community recipe must be .legion-cli/recipes/<name>.yaml (or .yml)";

export type RecipeExecutionResult = {
  recipeName: string;
  success: boolean;
  stepsRun: number;
  stepOutputs: Array<{ id: string; success: boolean; output: string }>;
  error?: string;
};

export type LoadedRecipe = {
  recipe: Recipe;
  filePath: string;
  bytes: Buffer;
};

export function recipesLockPath(projectRoot: string): string {
  return join(projectRoot, ".legion-cli", "recipes.lock");
}

function sha256Bytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sameRecipePath(a: string, b: string): boolean {
  const left = resolve(a);
  const right = resolve(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export function canonicalCommunityRecipePath(projectRoot: string, name: string): string | undefined {
  const yaml = join(projectRoot, ".legion-cli", "recipes", `${name}.yaml`);
  const yml = join(projectRoot, ".legion-cli", "recipes", `${name}.yml`);
  if (existsSync(yaml)) return resolve(yaml);
  if (existsSync(yml)) return resolve(yml);
  return undefined;
}

export async function assertRecipeExecutionPolicy(opts: {
  projectRoot: string;
  recipe: Recipe;
  filePath?: string;
  bytes?: Buffer;
}): Promise<void> {
  const origin = opts.recipe.origin ?? "local";
  if (origin !== "community") return;
  const canonical = canonicalCommunityRecipePath(opts.projectRoot, opts.recipe.name);
  if (!canonical) {
    refuse(COMMUNITY_RECIPE_LOCK_MESSAGE, "legion-cli recipe list");
  }
  if (opts.filePath && !sameRecipePath(opts.filePath, canonical)) {
    refuse(COMMUNITY_RECIPE_PATH_MESSAGE, "legion-cli recipe list");
  }
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
  const bytes = opts.bytes ?? (await readFile(canonical));
  if (sha256Bytes(bytes) !== entry.sha256) {
    refuse(`recipes.lock hash mismatch for recipe '${opts.recipe.name}'`, "legion-cli recipe list");
  }
}

async function spawnRecipeCommand(
  cmd: string,
  root: string,
  logPath: string,
): Promise<{ success: boolean; output: string }> {
  const parsed = parseCommandLine(cmd);
  if ("error" in parsed) {
    refuse(
      parsed.error === ARGV_ONLY_MESSAGE ? RECIPE_ARGV_ONLY_MESSAGE : parsed.error,
      "legion-cli recipe list",
    );
  }
  const result = await runCommand(parsed.argv, {
    cwd: root,
    timeoutMs: DEFAULT_VERIFICATION_TIMEOUT_MS,
    logPath,
  });
  let output = "";
  try {
    output = (await readFile(logPath, "utf8")).trim();
  } catch {
    output = "";
  }
  if (result.error) output = output ? `${output}\n${result.error}` : result.error;
  const success = result.started && result.exitCode === 0 && !result.timedOut;
  return { success, output };
}

export async function loadRecipeFile(recipePathOrName: string, projectRoot: string): Promise<LoadedRecipe> {
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

  const bytes = await readFile(fileToRead);
  const parsed = parseYaml(bytes.toString("utf8"));
  const result = RecipeSchema.safeParse(parsed);
  if (!result.success) {
    refuse(`invalid recipe schema in ${fileToRead}: ${result.error.message}`, "legion-cli help --all");
  }
  if ((result.data.origin ?? "local") === "community") {
    const canonical = canonicalCommunityRecipePath(projectRoot, result.data.name);
    if (!canonical || !sameRecipePath(fileToRead, canonical)) {
      refuse(COMMUNITY_RECIPE_PATH_MESSAGE, "legion-cli recipe list");
    }
  }
  return { recipe: result.data, filePath: resolve(fileToRead), bytes };
}

export async function loadRecipe(recipePathOrName: string, projectRoot: string): Promise<Recipe> {
  return (await loadRecipeFile(recipePathOrName, projectRoot)).recipe;
}

async function recipeForExecution(opts: {
  projectRoot: string;
  recipe: Recipe;
  sourcePath?: string;
}): Promise<Recipe> {
  const origin = opts.recipe.origin ?? "local";
  if (origin !== "community") {
    await assertRecipeExecutionPolicy({ projectRoot: opts.projectRoot, recipe: opts.recipe });
    return opts.recipe;
  }
  const canonical = canonicalCommunityRecipePath(opts.projectRoot, opts.recipe.name);
  if (!canonical) {
    refuse(COMMUNITY_RECIPE_LOCK_MESSAGE, "legion-cli recipe list");
  }
  if (opts.sourcePath && !sameRecipePath(opts.sourcePath, canonical)) {
    refuse(COMMUNITY_RECIPE_PATH_MESSAGE, "legion-cli recipe list");
  }
  const bytes = await readFile(canonical);
  await assertRecipeExecutionPolicy({
    projectRoot: opts.projectRoot,
    recipe: opts.recipe,
    filePath: canonical,
    bytes,
  });
  const parsed = RecipeSchema.safeParse(parseYaml(bytes.toString("utf8")));
  if (!parsed.success) {
    refuse(`invalid recipe schema in ${canonical}: ${parsed.error.message}`, "legion-cli help --all");
  }
  return parsed.data;
}

export async function runRecipe(opts: {
  projectRoot: string;
  recipe: Recipe;
  sourcePath?: string;
  params?: Record<string, unknown>;
  onStepStart?: (step: RecipeStep) => void;
  callMcpTool?: (tool: string, args: Record<string, unknown>) => Promise<{ content: Array<{ text?: string }>; isError?: boolean } | null>;
}): Promise<RecipeExecutionResult> {
  const root = resolve(opts.projectRoot);
  const recipe = await recipeForExecution({ projectRoot: root, recipe: opts.recipe, sourcePath: opts.sourcePath });
  const mergedParams = { ...(recipe.parameters ? Object.fromEntries(Object.entries(recipe.parameters).map(([k, v]) => [k, v.default])) : {}), ...(opts.params ?? {}) };

  const outputs: Array<{ id: string; success: boolean; output: string }> = [];
  const runId = `recipe-${Date.now()}`;

  for (const step of recipe.steps) {
    opts.onStepStart?.(step);

    if (step.action === "command") {
      let cmd = step.tool ?? "";
      for (const [k, v] of Object.entries(mergedParams)) {
        cmd = cmd.replaceAll(`{{${k}}}`, String(v ?? ""));
      }
      const logPath = join(root, ".legion-cli", "cache", "runs", runId, `${step.id}.log`);
      const res = await spawnRecipeCommand(cmd, root, logPath);
      outputs.push({ id: step.id, success: res.success, output: res.output });
      if (!res.success) {
        return {
          recipeName: recipe.name,
          success: false,
          stepsRun: outputs.length,
          stepOutputs: outputs,
          error: `step '${step.id}' command failed: ${res.output}`,
        };
      }
    } else if (step.action === "mcp_tool") {
      if (!opts.callMcpTool || !step.tool) {
        outputs.push({ id: step.id, success: false, output: "MCP tool executor not configured" });
        return {
          recipeName: recipe.name,
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
          recipeName: recipe.name,
          success: false,
          stepsRun: outputs.length,
          stepOutputs: outputs,
          error: `MCP tool '${step.tool}' failed in step '${step.id}'`,
        };
      }
    } else if (step.action === "verify") {
      const cmd = step.tool ?? "npm test";
      const logPath = join(root, ".legion-cli", "cache", "runs", runId, `${step.id}.log`);
      const res = await spawnRecipeCommand(cmd, root, logPath);
      outputs.push({ id: step.id, success: res.success, output: res.output });
      if (!res.success) {
        return {
          recipeName: recipe.name,
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
    recipeName: recipe.name,
    success: true,
    stepsRun: outputs.length,
    stepOutputs: outputs,
  };
}
