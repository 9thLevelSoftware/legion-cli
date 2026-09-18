import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { seedFrozenSpec, withEngine } from "./helpers.js";

const skillsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "skills");

test("plan with adapter.default http refuses because http is not spawnable", async () => {
  await withEngine(
    async ({ engine, store }) => {
      await engine.init({
        name: "Checkin",
        adapter: "http",
        http: {
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-4",
          apiKeyEnv: "OPENAI_API_KEY",
        },
      });
      await seedFrozenSpec(store, { wireframesIndex: "wireframes/INDEX.html" });
      await assert.rejects(
        () => engine.plan("spec-checkin"),
        (err) => {
          assert.match(String(err.message ?? err), /spawnable adapter/);
          return true;
        },
      );
    },
    { skillsDir },
  );
});

test("http write_file is unreachable because http is not spawnable", async () => {
  await withEngine(
    async ({ engine, store }) => {
      await engine.init({
        name: "Checkin",
        adapter: "http",
        http: {
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-4",
          apiKeyEnv: "OPENAI_API_KEY",
        },
      });
      await seedFrozenSpec(store);
      await assert.rejects(
        () => engine.plan("spec-checkin"),
        (err) => {
          assert.match(String(err.message ?? err), /spawnable adapter/);
          return true;
        },
      );
    },
    { skillsDir },
  );
});
