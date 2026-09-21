import assert from "node:assert/strict";
import test from "node:test";
import { runRecipe } from "../dist/index.js";
import { withEngine } from "./helpers.js";

test("runRecipe executes command steps and validates parameters", async () => {
  await withEngine(async ({ dir }) => {
    const recipe = {
      schemaVersion: "legion-cli-recipe/v1",
      name: "test-recipe",
      description: "Test recipe execution",
      parameters: {
        msg: {
          type: "string",
          description: "message to print",
          default: "hello-world",
        },
      },
      steps: [
        {
          id: "step-1",
          description: "echo message",
          action: "command",
          tool: "node -e \"console.log('OUTPUT: {{msg}}')\"",
        },
      ],
    };

    const result = await runRecipe({
      projectRoot: dir,
      recipe,
      params: { msg: "custom-message" },
    });

    assert.equal(result.success, true);
    assert.equal(result.stepsRun, 1);
    assert.match(result.stepOutputs[0].output, /OUTPUT: custom-message/);
  });
});

test("runRecipe executes MCP tool step when provided", async () => {
  await withEngine(async ({ dir }) => {
    const recipe = {
      schemaVersion: "legion-cli-recipe/v1",
      name: "mcp-recipe",
      description: "Test MCP tool step",
      parameters: {},
      steps: [
        {
          id: "mcp-step",
          description: "call external mcp tool",
          action: "mcp_tool",
          tool: "test-server:ping",
          params: { query: "ping" },
        },
      ],
    };

    const result = await runRecipe({
      projectRoot: dir,
      recipe,
      callMcpTool: async (tool, args) => {
        assert.equal(tool, "test-server:ping");
        return { content: [{ text: "pong" }], isError: false };
      },
    });

    assert.equal(result.success, true);
    assert.equal(result.stepOutputs[0].output, "pong");
  });
});
