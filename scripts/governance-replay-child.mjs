#!/usr/bin/env node
// Child process for the governance replay's interruptTask action. It runs one targeted step of
// task 0 against the replay's loopback provider; the parent holds that provider request open and
// SIGKILLs this process, so reaching the end of this script means the interruption was not exercised.
import { createLegionEngine } from "../packages/core/dist/index.js";

const [projectRoot, baseUrl, ...extra] = process.argv.slice(2);
if (!projectRoot || !baseUrl || extra.length > 0) {
  console.error("Usage: node scripts/governance-replay-child.mjs <projectRoot> <baseUrl>");
  process.exit(2);
}

const engine = createLegionEngine(projectRoot);
const config = await engine.store.readConfig();
if (config.adapter.http?.baseUrl !== baseUrl) {
  console.error(`project provider ${config.adapter.http?.baseUrl ?? "(none)"} is not the replay loopback ${baseUrl}`);
  process.exit(2);
}
const [task] = (await engine.listSliceTasks()).sort((left, right) => left.id.localeCompare(right.id));
if (!task) {
  console.error("project has no slice task to interrupt");
  process.exit(2);
}
const result = await engine.executeWorkflow({ taskId: task.id, step: true });
console.error(`task ${task.id} step finished without interruption: ${result.status}; ${result.blocker ?? "no blocker"}`);
process.exit(3);
