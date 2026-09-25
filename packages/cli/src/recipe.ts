import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { assertRecipeExecutionPolicy, loadRecipe, loadRecipeFile, runRecipe } from "@9thlevelsoftware/legion-cli-core";
import { LegionMcpClientPool } from "@9thlevelsoftware/legion-cli-mcp";
import { createLegionStore } from "@9thlevelsoftware/legion-cli-persist";
import type { CliOpts } from "./io.js";
import { writeErr, writeJson, writeOut } from "./io.js";

export type RecipeRunOpts = CliOpts & {
  param?: string[];
};

export async function runRecipeList(opts: CliOpts): Promise<number> {
  const dir = join(opts.project, ".legion-cli", "recipes");
  const recipes: Array<{ name: string; description: string }> = [];

  if (existsSync(dir)) {
    const files = await readdir(dir);
    for (const f of files) {
      if (f.endsWith(".yaml") || f.endsWith(".yml")) {
        try {
          const rec = await loadRecipe(join(dir, f), opts.project);
          recipes.push({ name: rec.name, description: rec.description });
        } catch {
          // ignore unparseable recipes in list
        }
      }
    }
  }

  if (opts.json) {
    writeJson({ recipes });
    return 0;
  }

  if (recipes.length === 0) {
    writeOut("No recipes found in .legion-cli/recipes/");
    writeOut("Create a recipe: .legion-cli/recipes/<name>.yaml");
    return 0;
  }

  writeOut("Available recipes:");
  for (const r of recipes) {
    writeOut(`  ${r.name.padEnd(20)} ${r.description}`);
  }
  writeOut("\nRun a recipe: legion-cli recipe run <name>");
  return 0;
}

export async function runRecipeRun(recipeName: string, opts: RecipeRunOpts): Promise<number> {
  if (!recipeName) {
    writeErr("recipe name is required\nNext: legion-cli recipe list");
    return 1;
  }

  const loaded = await loadRecipeFile(recipeName, opts.project);
  const recipe = loaded.recipe;
  await assertRecipeExecutionPolicy({
    projectRoot: opts.project,
    recipe,
    filePath: loaded.filePath,
    bytes: loaded.bytes,
  });

  // Parse CLI params: --param key=value
  const parsedParams: Record<string, unknown> = {};
  for (const item of opts.param ?? []) {
    const eqIdx = item.indexOf("=");
    if (eqIdx > 0) {
      const key = item.slice(0, eqIdx);
      const val = item.slice(eqIdx + 1);
      parsedParams[key] = val;
    }
  }

  const store = createLegionStore(opts.project);
  const config = await store.readConfig();
  const mcpPool = new LegionMcpClientPool(config.mcpServers ?? {});

  writeOut(`Executing recipe '${recipe.name}' (${recipe.steps.length} steps)...`);

  const result = await runRecipe({
    projectRoot: opts.project,
    recipe,
    sourcePath: loaded.filePath,
    params: parsedParams,
    onStepStart: (step) => {
      writeOut(`  -> [${step.id}] ${step.description}`);
    },
    callMcpTool: async (tool, args) => {
      return mcpPool.callTool(tool, args);
    },
  });

  await mcpPool.closeAll();

  if (opts.json) {
    writeJson(result);
    return result.success ? 0 : 1;
  }

  if (result.success) {
    for (const s of result.stepOutputs) {
      if (s.output) writeOut(`     ${s.output}`);
    }
    writeOut(`\nRecipe '${recipe.name}' completed successfully (${result.stepsRun} steps).`);
    return 0;
  } else {
    writeErr(`\nRecipe failed: ${result.error}`);
    return 1;
  }
}
