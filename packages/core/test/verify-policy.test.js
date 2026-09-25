import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { A007_FILE_COUNT, evaluateA007Gate } from "@9thlevelsoftware/legion-cli-persist";
import {
  DOCKER_HOST_EXEC_REFUSAL,
  translateHostPathToDocker,
  verificationSeatbeltProfile,
} from "@9thlevelsoftware/legion-cli-sandbox";
import { LegionConfigSchema } from "@9thlevelsoftware/legion-cli-schema";

import {
  LegionRefuseError,
  loadRecipe,
  resolveVerificationTrustTier,
  runRecipe,
  runVerificationCommands,
  verificationWork,
} from "../dist/index.js";
import {
  initGitRepo,
  initProject,
  quoteArg,
  seedPlanReady,
  withEngine,
  withFakeAdapter,
} from "./helpers.js";

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

test("community recipe from a non-canonical path is refused", async () => {
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
    const canonical = join(recipeDir, "community-recipe.yaml");
    await writeFile(canonical, yaml, "utf8");
    const sha256 = createHash("sha256").update(await readFile(canonical)).digest("hex");
    await writeFile(
      join(dir, ".legion-cli", "recipes.lock"),
      `${JSON.stringify({
        schemaVersion: "legion-cli-recipes-lock/v1",
        recipes: { "community-recipe": { sha256 } },
      })}\n`,
      "utf8",
    );
    const outside = join(dir, "other.yaml");
    const hostile = yaml.replace("process.exit(0)", "require('fs').writeFileSync('PWNED','x')");
    await writeFile(outside, hostile, "utf8");
    await assert.rejects(
      () => loadRecipe(outside, dir),
      (err) => {
        assert.equal(err instanceof LegionRefuseError, true);
        assert.match(err.message, /must be \.legion-cli\/recipes/, "community-canonical-path");
        return true;
      },
    );
    assert.equal(existsSync(join(dir, "PWNED")), false, "community-canonical-path");
  });
});

test("community recipe executes locked canonical bytes, not a hostile in-memory object", async () => {
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
    const canonical = join(recipeDir, "community-recipe.yaml");
    await writeFile(canonical, yaml, "utf8");
    const sha256 = createHash("sha256").update(await readFile(canonical)).digest("hex");
    await writeFile(
      join(dir, ".legion-cli", "recipes.lock"),
      `${JSON.stringify({
        schemaVersion: "legion-cli-recipes-lock/v1",
        recipes: { "community-recipe": { sha256 } },
      })}\n`,
      "utf8",
    );
    const hostile = {
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
          tool: `${quoteArg(process.execPath)} -e ${quoteArg("require('fs').writeFileSync('PWNED','x')")}`,
        },
      ],
    };
    const result = await runRecipe({ projectRoot: dir, recipe: hostile });
    assert.equal(result.success, true, "community-canonical-bytes");
    assert.equal(existsSync(join(dir, "PWNED")), false, "community-canonical-bytes");
  });
});

test("recipe command steps start PATH shims through runCommand", async () => {
  await withEngine(async ({ dir }) => {
    const result = await runRecipe({
      projectRoot: dir,
      recipe: localRecipe("pnpm --version"),
    });
    assert.equal(result.success, true, result.error ?? result.stepOutputs[0]?.output ?? "recipe-cmd-shim");
    assert.match(result.stepOutputs[0]?.output ?? "", /\d+\.\d+/, "recipe-cmd-shim");
  });
});

test("seatbelt verify profile allows reading process.execPath", async () => {
  await withEngine(async ({ dir }) => {
    const profile = verificationSeatbeltProfile(dir);
    const execReal = realpathSync(process.execPath);
    assert.ok(profile.includes(JSON.stringify(execReal)), "seatbelt-exec-path");
  });
});

test("execute result carries the human-visible trust-tier note", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ engine, store, dir }) => {
      await initProject(engine);
      await seedPlanReady(store, {
        task: {
          contract: {
            filesAllowed: ["src/main.ts"],
            expectedArtifacts: ["src/main.ts"],
            verificationCommands: [passingCommand()],
          },
        },
      });
      initGitRepo(dir);
      const result = await engine.execute("auto");
      assert.equal(result.status, "done");
      assert.match(result.tasks[0]?.trustTierNote ?? "", /trust-tier:/, "human-visible");
    });
  });
});

test("verify wrapper source never calls materializeJail or copyTree", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const verifySrc = readFileSync(join(here, "..", "src", "verify.ts"), "utf8");
  const sandboxSrc = readFileSync(join(here, "..", "..", "sandbox", "src", "sandbox.ts"), "utf8");
  const start = sandboxSrc.indexOf("export async function prepareVerificationWrapper");
  const end = sandboxSrc.indexOf("function assertPolicyPath", start);
  assert.ok(start >= 0 && end > start, "no-copy-jail");
  const wrapperSrc = sandboxSrc.slice(start, end);
  assert.doesNotMatch(verifySrc, /\bmaterializeJail\b/, "no-copy-jail");
  assert.doesNotMatch(verifySrc, /\bcopyTree\b/, "no-copy-jail");
  assert.doesNotMatch(wrapperSrc, /\bmaterializeJail\b/, "no-copy-jail");
  assert.doesNotMatch(wrapperSrc, /\bcopyTree\b/, "no-copy-jail");
  assert.doesNotMatch(wrapperSrc, /\bcopySparsePath\b/, "no-copy-jail");
});

test("opt-in docker translateInvoke throw is a started:false run", async () => {
  await withEngine(async ({ dir }) => {
    const hostExec = process.platform === "win32" ? "C:\\Windows\\System32\\notepad.exe" : "/usr/bin/true";
    const runs = await runVerificationCommands(dir, [hostExec], {
      sandbox: { ...DEFAULT_SANDBOX, backend: "docker" },
      dockerAvailable: true,
      wrapper: {
        bin: "docker",
        argvPrefix: ["run", "--rm", "node:22-alpine"],
        translateInvoke: (invoke) => translateHostPathToDocker(invoke, dir),
      },
    });
    assert.equal(runs[0]?.started, false, "docker-translate-started-false");
    assert.equal(runs[0]?.ok, false, "docker-translate-started-false");
    assert.equal(runs[0]?.error, DOCKER_HOST_EXEC_REFUSAL, "docker-translate-started-false");
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
