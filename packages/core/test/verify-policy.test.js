import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { A007_FILE_COUNT, evaluateA007Gate } from "@9thlevelsoftware/legion-cli-persist";
import { LegionConfigSchema } from "@9thlevelsoftware/legion-cli-schema";

import {
  LegionRefuseError,
  resolveVerificationTrustTier,
  runRecipe,
  runVerificationCommands,
  verificationWork,
} from "../dist/index.js";
import { quoteArg, withEngine } from "./helpers.js";

const DEFAULT_SANDBOX = LegionConfigSchema.parse({
  schemaVersion: "legion-cli-config/v1",
  adapter: { default: "fake" },
}).sandbox;

function passingCommand() {
  return `${quoteArg(process.execPath)} -e process.exit(0)`;
}

function pwnCommand() {
  return `${quoteArg(process.execPath)} -e ${quoteArg("require('fs').writeFileSync('PWNED','x')")} && echo extra`;
}

function localRecipe(tool) {
  return {
    schemaVersion: "legion-cli-recipe/v1",
    name: "local-recipe",
    description: "local fixture",
    origin: "local",
    parameters: {},
    steps: [{ id: "step-1", description: "run", action: "command", tool }],
  };
}

test("default-config Windows-without-Docker fixture runs plain verify with no opt-out flag", async () => {
  await withEngine(async ({ dir }) => {
    verificationWork.copyFiles = -1;
    verificationWork.copyBytes = -1;
    const runs = await runVerificationCommands(dir, [passingCommand()], {
      sandbox: DEFAULT_SANDBOX,
      platform: "win32",
      dockerAvailable: false,
      allowNoSandbox: false,
    });
    assert.equal(runs[0]?.ok, true, "completes-without-flag");
    assert.equal(runs[0]?.trustTier, "allowlist");
    assert.match(runs[0]?.trustTierNote ?? "", /trust-tier: allowlist/, "human-visible");
    assert.doesNotMatch(runs[0]?.trustTierNote ?? "", /^\s*silent\s*$/i, "human-visible");
    assert.match(runs[0]?.trustTierNote ?? "", /privileges/, "human-visible");
    assert.equal(verificationWork.copyFiles, 0, "copy-cost");
    assert.equal(verificationWork.copyBytes, 0, "copy-cost");
  });
});

test("plain verify never requires --allow-no-sandbox on the host default config", async () => {
  await withEngine(async ({ dir }) => {
    const runs = await runVerificationCommands(dir, [passingCommand()], {
      sandbox: DEFAULT_SANDBOX,
      allowNoSandbox: false,
    });
    assert.equal(runs[0]?.ok, true, "completes-without-flag");
    assert.ok(runs[0]?.trustTierNote, "human-visible");
    assert.match(runs[0]?.trustTierNote ?? "", /trust-tier:/, "human-visible");
    assert.equal(verificationWork.copyFiles, 0, "copy-cost");
  });
});

test("pinned Docker is opt-in: auto on Windows does not select docker", () => {
  const posture = resolveVerificationTrustTier(DEFAULT_SANDBOX, {
    platform: "win32",
    dockerAvailable: true,
    bwrapAvailable: false,
    seatbeltAvailable: false,
  });
  assert.equal(posture.tier, "allowlist");
  assert.equal(posture.backend, "host");
  assert.equal(posture.copyJail, false);
  assert.match(posture.note, /trust-tier: allowlist/, "human-visible");
});

test("pinned Docker backend is used only when sandbox.backend is docker", () => {
  const posture = resolveVerificationTrustTier(
    { ...DEFAULT_SANDBOX, backend: "docker" },
    { platform: "win32", dockerAvailable: true },
  );
  assert.equal(posture.tier, "hardened-docker");
  assert.equal(posture.backend, "docker");
  assert.equal(posture.copyJail, false);
  assert.match(posture.note, /trust-tier: hardened-docker/, "human-visible");
});

test("copy jail is never the verify default", () => {
  const posture = resolveVerificationTrustTier(
    { ...DEFAULT_SANDBOX, allowCopyJail: true, backend: "copy", requireHardened: false },
    { platform: "win32", dockerAvailable: false },
  );
  assert.equal(posture.copyJail, false);
  assert.equal(posture.tier, "allowlist");
  assert.equal(verificationWork.copyFiles, 0);
});

test("Linux auto with bwrap is the hardened-bwrap tier", () => {
  const posture = resolveVerificationTrustTier(DEFAULT_SANDBOX, {
    platform: "linux",
    bwrapAvailable: true,
    dockerAvailable: false,
  });
  assert.equal(posture.tier, "hardened-bwrap");
  assert.equal(posture.backend, "bwrap");
  assert.equal(posture.copyJail, false);
  assert.match(posture.note, /trust-tier: hardened-bwrap/, "human-visible");
});

test("macOS auto with seatbelt is the hardened-seatbelt tier", () => {
  const posture = resolveVerificationTrustTier(DEFAULT_SANDBOX, {
    platform: "darwin",
    seatbeltAvailable: true,
    dockerAvailable: false,
  });
  assert.equal(posture.tier, "hardened-seatbelt");
  assert.equal(posture.backend, "seatbelt");
  assert.match(posture.note, /trust-tier: hardened-seatbelt/, "human-visible");
});

test("hostile recipe with shell metacharacters is a named refusal and does not execute", async () => {
  await withEngine(async ({ dir }) => {
    const marker = join(dir, "PWNED");
    await assert.rejects(
      () => runRecipe({ projectRoot: dir, recipe: localRecipe(pwnCommand()) }),
      (err) => {
        assert.equal(err instanceof LegionRefuseError, true);
        assert.match(err.message, /argv-only/, "recipe-metacharacter-refusal");
        return true;
      },
    );
    assert.equal(existsSync(marker), false, "recipe-metacharacter-refusal");
  });
});

test("community recipe without recipes.lock is a named refusal", async () => {
  await withEngine(async ({ dir }) => {
    const recipe = {
      ...localRecipe(`${quoteArg(process.execPath)} -e process.exit(0)`),
      name: "community-recipe",
      origin: "community",
    };
    await assert.rejects(
      () => runRecipe({ projectRoot: dir, recipe }),
      (err) => {
        assert.equal(err instanceof LegionRefuseError, true);
        assert.match(err.message, /recipes\.lock/, "community-recipe-lock-refusal");
        return true;
      },
    );
  });
});

test("community recipe with a verified recipes.lock runs argv-only", async () => {
  await withEngine(async ({ dir }) => {
    const yaml = [
      "schemaVersion: legion-cli-recipe/v1",
      "name: community-recipe",
      "description: locked community fixture",
      "origin: community",
      "steps:",
      "  - id: step-1",
      "    description: run",
      "    action: command",
      `    tool: ${JSON.stringify(`${quoteArg(process.execPath)} -e process.exit(0)`)}`,
      "",
    ].join("\n");
    const recipeDir = join(dir, ".legion-cli", "recipes");
    await mkdir(recipeDir, { recursive: true });
    const filePath = join(recipeDir, "community-recipe.yaml");
    await writeFile(filePath, yaml, "utf8");
    const sha256 = createHash("sha256").update(await readFile(filePath)).digest("hex");
    await writeFile(
      join(dir, ".legion-cli", "recipes.lock"),
      `${JSON.stringify({
        schemaVersion: "legion-cli-recipes-lock/v1",
        recipes: { "community-recipe": { sha256 } },
      })}\n`,
      "utf8",
    );
    const recipe = {
      schemaVersion: "legion-cli-recipe/v1",
      name: "community-recipe",
      description: "locked community fixture",
      origin: "community",
      parameters: {},
      steps: [
        {
          id: "step-1",
          description: "run",
          action: "command",
          tool: `${quoteArg(process.execPath)} -e process.exit(0)`,
        },
      ],
    };
    const result = await runRecipe({ projectRoot: dir, recipe });
    assert.equal(result.success, true);
    assert.equal(result.stepsRun, 1);
  });
});

test(
  "verify with enforcement active stays inside the A-007 budget at 50k files and copies nothing",
  { skip: process.env.LEGION_A007_GATE !== "1" },
  async () => {
    await withEngine(async ({ dir }) => {
      const n = A007_FILE_COUNT;
      const src = join(dir, "src");
      await mkdir(src, { recursive: true });
      const body = "export const x = 1;\n";
      const batch = 256;
      for (let i = 0; i < n; i += batch) {
        const jobs = [];
        const end = Math.min(n, i + batch);
        for (let j = i; j < end; j += 1) jobs.push(writeFile(join(src, `f${j}.ts`), body, "utf8"));
        await Promise.all(jobs);
      }
      const t0 = Date.now();
      const runs = await runVerificationCommands(dir, [passingCommand()], {
        sandbox: DEFAULT_SANDBOX,
        allowNoSandbox: false,
      });
      const ms = Date.now() - t0;
      assert.equal(runs[0]?.ok, true, "completes-without-flag");
      assert.match(runs[0]?.trustTierNote ?? "", /trust-tier:/, "human-visible");
      assert.equal(verificationWork.copyFiles, 0, "copy-cost");
      assert.equal(verificationWork.copyBytes, 0, "copy-cost");
      const gate = evaluateA007Gate([{ step: "verify", ms, files: n }]);
      assert.equal(gate.ok, true, gate.reason ?? "A-007 verify gate failed");
    });
  },
);
