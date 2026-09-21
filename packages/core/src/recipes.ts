import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { RecipeSchema, type Recipe, type RecipeStep } from "@9thlevelsoftware/legion-cli-schema";
import { refuse } from "./errors.js";

export type RecipeExecutionResult = {
  recipeName: string;
  success: boolean;
  stepsRun: number;
  stepOutputs: Array<{ id: string; success: boolean; output: string }>;
  error?: string;
};

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
  const mergedParams = { ...(opts.recipe.parameters ? Object.fromEntries(Object.entries(opts.recipe.parameters).map(([k, v]) => [k, v.default])) : {}), ...(opts.params ?? {}) };

  const outputs: Array<{ id: string; success: boolean; output: string }> = [];

  for (const step of opts.recipe.steps) {
    opts.onStepStart?.(step);

    if (step.action === "command") {
      let cmd = step.tool ?? "";
      for (const [k, v] of Object.entries(mergedParams)) {
        cmd = cmd.replaceAll(`{{${k}}}`, String(v ?? ""));
      }
      const res = spawnSync(cmd, {
        cwd: root,
        shell: true,
        encoding: "utf8",
        windowsHide: true,
      });
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
      const res = spawnSync(cmd, { cwd: root, shell: true, encoding: "utf8", windowsHide: true });
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
