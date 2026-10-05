import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  findExtensionsDir,
  findSkillsDir,
  installExtensionOverlay,
  installSkillOverlay,
  listExtensionCatalog,
  listResolvedSkillCatalog,
  parseIntegritySha256,
  parseExtensionFrontmatter,
  parseSkillFrontmatter,
  resolveExtensionDir,
  resolveSkillDir,
  readComponentInvocation,
  runGovernedExtension,
  exportUsageTelemetry,
  skillCatalogPath,
} from "@9thlevelsoftware/legion-cli-agents";
import { createHttpToolHost, createLegionEngine, HINT, refuse } from "@9thlevelsoftware/legion-cli-core";
import { appendAuditEvent } from "@9thlevelsoftware/legion-cli-persist";
import { SkillIdSchema, type SkillId } from "@9thlevelsoftware/legion-cli-schema";
import { installWithLock } from "./install-lock.js";
import type { CliOpts } from "./io.js";
import { writeErr, writeJson, writeOut } from "./io.js";

function parseSkillId(id: string): SkillId {
  const parsed = SkillIdSchema.safeParse(id.trim());
  if (!parsed.success) {
    refuse(`unknown skillId '${id}'`, HINT.skillsShow);
  }
  return parsed.data;
}

function ttyWarn(): ((message: string) => void) | undefined {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return undefined;
  return (message) => writeErr(`warning: ${message}`);
}

export async function runSkillsList(opts: CliOpts): Promise<number> {
  const packaged = findSkillsDir();
  const [result, extensionResult] = await Promise.all([
    listResolvedSkillCatalog({
      projectRoot: opts.project,
      packagedSkillsDir: packaged,
    }),
    listExtensionCatalog({
      projectRoot: opts.project,
      packagedExtensionsDir: findExtensionsDir(),
    }),
  ]);
  if (opts.json) {
    writeJson({
      skills: result.catalog.skills,
      extensions: extensionResult.extensions,
      skipped: result.skipped,
      extensionsSkipped: extensionResult.skipped,
      overlays: result.overlays.map((row) => ({
        skillId: row.skillId,
        source: row.pin?.source,
        sha256: row.pin?.integrity.sha256,
        digestOk: row.digestOk,
        pinError: row.pinError,
      })),
    });
    return 0;
  }
  const overlayIds = new Set(result.overlays.filter((row) => row.digestOk).map((row) => row.skillId));
  const lines = ["# Skills"];
  for (const skill of result.catalog.skills) {
    const source = overlayIds.has(skill.skillId) ? "overlay" : "packaged";
    const required = skill.required ? "required" : "optional";
    lines.push(`- ${skill.skillId}  ${source}  ${required}  ${skill.description}`);
  }
  for (const skipped of result.skipped) {
    if (skipped.reason === "missing SKILL.md") continue;
    lines.push(`- ${skipped.path}  skipped  ${skipped.required ? "required" : "optional"}  ${skipped.reason}`);
  }
  lines.push("", "# Extensions");
  for (const extension of extensionResult.extensions) {
    lines.push(`- ${extension.ref}  ${extension.version}  ${extension.description}`);
  }
  for (const skipped of extensionResult.skipped) {
    lines.push(`- ${skipped.path}  skipped  ${skipped.reason}`);
  }
  writeOut(lines.join("\n"));
  return 0;
}

export async function runSkillsShow(opts: CliOpts, id: string): Promise<number> {
  if (id.trim().startsWith("extension:")) {
    return runExtensionShow(opts, id.trim());
  }
  const skillId = parseSkillId(id);
  const packaged = findSkillsDir();
  const resolved = await resolveSkillDir({
    projectRoot: opts.project,
    skillId,
    packagedSkillsDir: packaged,
  });
  if (!resolved.ok) {
    refuse(resolved.reason, HINT.skillsShow);
  }
  const skillMd = join(resolved.skillDir, "SKILL.md");
  const raw = await readFile(skillMd, "utf8");
  const parsed = parseSkillFrontmatter(raw, skillCatalogPath(skillId, resolved.source));
  if (!parsed.ok) {
    refuse(
      `${skillId} requires valid ${skillCatalogPath(skillId, resolved.source)} frontmatter (${parsed.reason})`,
      HINT.skillsShow,
    );
  }
  const payload = {
    skillId,
    source: resolved.source,
    path: skillCatalogPath(skillId, resolved.source),
    description: parsed.entry.description,
    required: parsed.entry.required,
    bodyChars: parsed.entry.bodyChars,
    pin: resolved.pin
      ? {
          sha256: resolved.pin.integrity.sha256,
          origin: resolved.pin.source.origin,
          type: resolved.pin.source.type,
          ref: resolved.pin.source.ref,
        }
      : null,
  };
  if (opts.json) {
    writeJson(payload);
    return 0;
  }
  const lines = [
    `skillId: ${payload.skillId}`,
    `source: ${payload.source}`,
    `path: ${payload.path}`,
    `required: ${payload.required}`,
    `bodyChars: ${payload.bodyChars}`,
    `description: ${payload.description}`,
  ];
  if (payload.pin) {
    lines.push(`pin: ${payload.pin.sha256}`);
    lines.push(`origin: ${payload.pin.type} ${payload.pin.origin}${payload.pin.ref ? `@${payload.pin.ref}` : ""}`);
  }
  writeOut(lines.join("\n"));
  return 0;
}

function parseExtensionRef(ref: string): string {
  const match = /^extension:([a-z][a-z0-9-]{0,63})$/.exec(ref.trim());
  if (!match?.[1]) refuse(`unknown extension reference '${ref}'`, HINT.skillsShow);
  return match[1];
}

async function runExtensionShow(opts: CliOpts, ref: string): Promise<number> {
  const extensionId = parseExtensionRef(ref);
  const resolved = await resolveExtensionDir({
    projectRoot: opts.project,
    extensionId,
    packagedExtensionsDir: findExtensionsDir(),
  });
  if (!resolved.ok) refuse(resolved.reason, HINT.skillsShow);
  let file = join(resolved.extensionDir, "EXTENSION.md");
  try {
    await readFile(file, "utf8");
  } catch {
    file = join(resolved.extensionDir, "SKILL.md");
  }
  const parsed = parseExtensionFrontmatter(
    await readFile(file, "utf8"),
    `${resolved.source === "overlay" ? ".legion-cli/extensions" : "extensions"}/${extensionId}/${file.endsWith("EXTENSION.md") ? "EXTENSION.md" : "SKILL.md"}`,
  );
  if (!parsed.ok) refuse(parsed.reason, HINT.skillsShow);
  const payload = {
    ...parsed.manifest,
    source: resolved.source,
    pin: resolved.pin ?? null,
  };
  if (opts.json) {
    writeJson(payload);
    return 0;
  }
  writeOut([
    `ref: ${payload.ref}`,
    `source: ${payload.source}`,
    `version: ${payload.version}`,
    `description: ${payload.description}`,
    `requiredTools: ${payload.requiredTools.join(", ") || "(none)"}`,
    `write: ${payload.permissions.write.join(", ")}`,
  ].join("\n"));
  return 0;
}

export type SkillsInstallFlags = {
  unsigned?: boolean;
  skill?: string;
  integrity?: string;
  extension?: string;
};

export async function runSkillsInstall(opts: CliOpts, source: string, flags: SkillsInstallFlags = {}): Promise<number> {
  const src = source.trim();
  if (!src) {
    refuse("skills install requires a local directory or github:owner/repo@tag", HINT.skillsInstall);
  }
  const engine = createLegionEngine(opts.project);
  if (!(await engine.store.pathExists(".legion-cli/config.yaml"))) {
    refuse("skills install needs a Legion CLI project first", HINT.init);
  }
  let trustKeys: string[] = [];
  try {
    const config = await engine.store.readConfig();
    trustKeys = config.skills.trustKeys;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    refuse(message, HINT.init);
  }
  let skillId: SkillId | undefined;
  if (flags.skill) {
    const parsedSkill = SkillIdSchema.safeParse(flags.skill.trim());
    if (!parsedSkill.success) {
      refuse(`unknown skillId '${flags.skill}'`, HINT.skillsInstall);
    }
    skillId = parsedSkill.data;
  }
  let integritySha256: string | undefined;
  if (flags.integrity) {
    try {
      integritySha256 = parseIntegritySha256(flags.integrity);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      refuse(message, HINT.skillsInstall);
    }
  }
  if (flags.extension) {
    try {
      const installed = await installWithLock(opts.project, /^github:/i.test(src.trim()), (fetchZip) =>
        installExtensionOverlay({
          projectRoot: opts.project,
          source: src,
          extensionId: flags.extension,
          unsigned: Boolean(flags.unsigned),
          integritySha256,
          cwd: process.cwd(),
          trustKeys,
          ...(fetchZip ? { fetchZip } : {}),
        }),
      );
      if (opts.json) {
        writeJson({ ok: true, ref: `extension:${installed.extensionId}`, dest: installed.dest, pin: installed.pin, next: `legion-cli skills show extension:${installed.extensionId}` });
        return 0;
      }
      writeOut([
        `Installed extension:${installed.extensionId}.`,
        `Pin: ${installed.pin.integrity.sha256}`,
        `Next: legion-cli skills show extension:${installed.extensionId}`,
      ].join("\n"));
      return 0;
    } catch (err) {
      refuse(err instanceof Error ? err.message : String(err), HINT.skillsInstall);
    }
  }
  try {
    // The overlay lives under .legion-cli/: replace it under engine.lock (FP-3), but download a
    // github: source before taking it.
    const installed = await installWithLock(opts.project, /^github:/i.test(src.trim()), (fetchZip) =>
      installSkillOverlay({
        projectRoot: opts.project,
        source: src,
        unsigned: Boolean(flags.unsigned),
        skillId,
        integritySha256,
        cwd: process.cwd(),
        trustKeys,
        ttyWarn: ttyWarn(),
        ...(fetchZip ? { fetchZip } : {}),
      }),
    );
    if (opts.json) {
      writeJson({
        ok: true,
        skillId: installed.skillId,
        dest: installed.dest,
        source: installed.pin.source,
        sha256: installed.pin.integrity.sha256,
        next: `legion-cli skills show ${installed.skillId}`,
      });
      return 0;
    }
    writeOut(
      [
        `Installed overlay ${installed.skillId}.`,
        `Pin: ${installed.pin.integrity.sha256}`,
        "Packaged skills/ was not mutated.",
        `Next: legion-cli skills show ${installed.skillId}`,
      ].join("\n"),
    );
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    refuse(message, HINT.skillsInstall);
  }
}

export async function runSkillsRun(opts: CliOpts, ref: string, flags: { profile?: string; validatorInput?: string } = {}): Promise<number> {
  const extensionId = parseExtensionRef(ref);
  const engine = createLegionEngine(opts.project);
  if (!(await engine.store.pathExists(".legion-cli/config.yaml"))) {
    refuse("skills run needs a Legion CLI project first", HINT.init);
  }
  const resolved = await resolveExtensionDir({
    projectRoot: opts.project,
    extensionId,
    packagedExtensionsDir: findExtensionsDir(),
  });
  if (!resolved.ok) refuse(resolved.reason, HINT.skillsShow);
  let manifestFile = join(resolved.extensionDir, "EXTENSION.md");
  try {
    await readFile(manifestFile, "utf8");
  } catch {
    manifestFile = join(resolved.extensionDir, "SKILL.md");
  }
  const parsed = parseExtensionFrontmatter(
    await readFile(manifestFile, "utf8"),
    `extensions/${extensionId}/${manifestFile.endsWith("EXTENSION.md") ? "EXTENSION.md" : "SKILL.md"}`,
  );
  if (!parsed.ok) refuse(parsed.reason, HINT.skillsShow);
  let result;
  const config = await engine.store.readConfig();
  try {
    if (parsed.manifest.runtime && flags.profile !== undefined) refuse("--profile is not supported for component runtimes", `legion-cli skills run ${ref} --validator-input <json-file>`);
    if (parsed.manifest.runtime && flags.validatorInput === undefined) refuse("component runtimes require --validator-input", `legion-cli skills run ${ref} --validator-input <json-file>`);
    if (!parsed.manifest.runtime && flags.validatorInput !== undefined) refuse("--validator-input is only supported for component runtimes", `legion-cli skills run ${ref}`);
    const componentInvocation = flags.validatorInput !== undefined ? await readComponentInvocation(flags.validatorInput) : undefined;
    result = await runGovernedExtension({
      projectRoot: opts.project,
      extensionDir: resolved.extensionDir,
      manifest: parsed.manifest,
      config,
      profile: flags.profile,
      ...(componentInvocation ? { componentInvocation } : {}),
      createHttpToolHost,
    });
  } catch (err) {
    refuse(err instanceof Error ? err.message : String(err), `legion-cli skills run ${ref}`);
  }
  const tickets: string[] = [];
  for (const recommendation of result.recommendations) {
    const ticket = await engine.fileTicket({
      title: recommendation.title,
      type: recommendation.type,
      priority: recommendation.priority,
      notes: [`Recommended by ${ref} run ${result.runId}.`, recommendation.detail ?? ""].filter(Boolean).join("\n"),
    });
    tickets.push(ticket.id);
  }
  const state = await engine.getState();
  const counts = { passed: 0, failed: 0, unavailable: 0 };
  for (const check of result.evidence.checks) counts[check.status] += 1;
  await appendAuditEvent(opts.project, {
    ts: new Date().toISOString(),
    type: "extension_run",
    phase: state.phase,
    actor: "user",
    data: {
      extension: ref,
      runId: result.runId,
      adapterId: result.adapterId,
      profile: result.profile ?? null,
      outcome: result.status,
      checks: counts,
      tickets: tickets.length,
      usage: result.usage ?? null,
      limitReason: result.limitReason ?? null,
    },
  });
  await exportUsageTelemetry({
    endpoint: config.telemetry.otlpEndpoint,
    adapter: result.adapterId,
    profile: result.profile,
    skill: ref,
    outcome: result.status,
    usage: result.usage,
  });
  const pass = result.status === "complete" && counts.failed === 0 && counts.unavailable === 0;
  if (opts.json) {
    writeJson({ ok: pass, ...result, counts, tickets, next: tickets.length > 0 ? "legion-cli next" : `legion-cli skills show ${ref}` });
    return pass ? 0 : 1;
  }
  writeOut(`${ref} run ${result.runId}: ${counts.passed} passed, ${counts.failed} failed, ${counts.unavailable} unavailable.`);
  writeOut(`Evidence: ${result.evidencePath}`);
  if (tickets.length > 0) writeOut(`Filed tickets: ${tickets.join(", ")}`);
  if (result.limitReason) writeOut(`Stopped: ${result.limitReason}`);
  writeOut(`Next: ${tickets.length > 0 ? "legion-cli next" : `legion-cli skills show ${ref}`}`);
  return pass ? 0 : 1;
}
