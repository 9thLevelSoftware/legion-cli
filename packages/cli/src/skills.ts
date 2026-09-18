import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  findSkillsDir,
  installSkillOverlay,
  listResolvedSkillCatalog,
  parseIntegritySha256,
  parseSkillFrontmatter,
  resolveSkillDir,
  skillCatalogPath,
} from "@9thlevelsoftware/legion-cli-agents";
import { createLegionEngine, HINT, refuse } from "@9thlevelsoftware/legion-cli-core";
import { SkillIdSchema, type SkillId } from "@9thlevelsoftware/legion-cli-schema";
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
  const result = await listResolvedSkillCatalog({
    projectRoot: opts.project,
    packagedSkillsDir: packaged,
  });
  if (opts.json) {
    writeJson({
      skills: result.catalog.skills,
      skipped: result.skipped,
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
  writeOut(lines.join("\n"));
  return 0;
}

export async function runSkillsShow(opts: CliOpts, id: string): Promise<number> {
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

export type SkillsInstallFlags = {
  unsigned?: boolean;
  skill?: string;
  integrity?: string;
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
  try {
    const installed = await installSkillOverlay({
      projectRoot: opts.project,
      source: src,
      unsigned: Boolean(flags.unsigned),
      skillId,
      integritySha256,
      cwd: process.cwd(),
      trustKeys,
      ttyWarn: ttyWarn(),
    });
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
