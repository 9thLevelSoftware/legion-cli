import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  SCHEMA_VERSION,
  SkillCatalogEntrySchema,
  SkillIdSchema,
  type SkillCatalog,
  type SkillCatalogEntry,
  type SkillId,
} from "@9thlevelsoftware/legion-cli-schema";
import { toPosixPath } from "./paths.js";

export const SKILL_DESCRIPTION_MAX_CHARS = 400;
export const SKILL_BODY_WARN_CHARS = 20_000;
export const SKILL_LEVEL1_LINE_MAX_CHARS = 480;

export type SkillResourceKind = "scripts" | "references" | "assets";

export const REQUIRED_SKILL_IDS = ["plan", "execute", "review"] as const satisfies readonly SkillId[];

export function isRequiredSkillId(id: string): id is (typeof REQUIRED_SKILL_IDS)[number] {
  return (REQUIRED_SKILL_IDS as readonly string[]).includes(id);
}

export type ParsedSkill =
  | {
      ok: true;
      entry: SkillCatalogEntry;
      body: string;
    }
  | {
      ok: false;
      skillIdGuess: string;
      path: string;
      reason: string;
    };

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function failParse(path: string, skillIdGuess: string, reason: string): ParsedSkill {
  return { ok: false, skillIdGuess, path, reason };
}

function directoryFromSkillPath(path: string): string {
  const posix = toPosixPath(path).replace(/\/+$/, "");
  const parts = posix.split("/").filter(Boolean);
  if (parts.length === 0) return "";
  const last = parts[parts.length - 1] ?? "";
  if (last.toLowerCase() === "skill.md") return parts[parts.length - 2] ?? "";
  return last;
}

function catalogPathFor(directory: string, fallbackPath: string): string {
  if (directory) return `skills/${directory}/SKILL.md`;
  return toPosixPath(fallbackPath);
}

function yamlRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function listRelFiles(absDir: string, prefix: string): string[] {
  if (!existsSync(absDir)) return [];
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(absDir);
  } catch {
    return [];
  }
  if (!st.isDirectory()) return [];
  const out: string[] = [];
  const walk = (dir: string, relPrefix: string): void => {
    let ents;
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      const rel = relPrefix ? `${relPrefix}/${ent.name}` : `${prefix}/${ent.name}`;
      const abs = join(dir, ent.name);
      if (ent.isDirectory()) walk(abs, rel);
      else if (ent.isFile()) out.push(toPosixPath(rel));
    }
  };
  walk(absDir, prefix);
  return out.sort();
}

export function listLevel3Resources(skillDir: string): {
  scripts: string[];
  references: string[];
  assets: string[];
} {
  return {
    scripts: listRelFiles(join(skillDir, "scripts"), "scripts"),
    references: listRelFiles(join(skillDir, "references"), "references"),
    assets: listRelFiles(join(skillDir, "assets"), "assets"),
  };
}

export function parseSkillFrontmatter(raw: string, path: string): ParsedSkill {
  const directory = directoryFromSkillPath(path);
  const catalogPath = catalogPathFor(directory, path);
  const skillIdGuess = directory;
  try {
    const match = FRONTMATTER_RE.exec(raw);
    if (!match) {
      return failParse(catalogPath, skillIdGuess, "missing YAML frontmatter");
    }
    const parsed = parseYaml(match[1] ?? "");
    const data = yamlRecord(parsed);
    if (!data) {
      return failParse(catalogPath, skillIdGuess, "frontmatter must be a YAML mapping");
    }
    const name = asString(data.name)?.trim() ?? "";
    if (!name || !SKILL_NAME_RE.test(name) || name.length > 64) {
      return failParse(
        catalogPath,
        skillIdGuess,
        `name must be a 1–64 character slug matching ${SKILL_NAME_RE}`,
      );
    }
    const description = asString(data.description)?.trim() ?? "";
    if (!description) {
      return failParse(catalogPath, skillIdGuess, "description is required");
    }
    if (description.length > SKILL_DESCRIPTION_MAX_CHARS) {
      return failParse(
        catalogPath,
        skillIdGuess,
        `description exceeds ${SKILL_DESCRIPTION_MAX_CHARS} characters`,
      );
    }
    const metadata = yamlRecord(data.metadata);
    const legion = yamlRecord(metadata?.legion);
    if (!legion) {
      return failParse(catalogPath, skillIdGuess, "metadata.legion is required");
    }
    const skillIdRaw = asString(legion.skillId)?.trim() ?? "";
    const skillIdParsed = SkillIdSchema.safeParse(skillIdRaw);
    if (!skillIdParsed.success) {
      return failParse(catalogPath, skillIdGuess, `metadata.legion.skillId is not a SkillId (${skillIdRaw})`);
    }
    const skillId = skillIdParsed.data;
    if (name !== directory || name !== skillId || skillId !== directory) {
      return failParse(
        catalogPath,
        skillIdGuess,
        `name "${name}" must equal directory "${directory}" and skillId "${skillId}"`,
      );
    }
    if (typeof legion.required !== "boolean") {
      return failParse(catalogPath, skillIdGuess, "metadata.legion.required must be a boolean");
    }
    const expectedRequired = isRequiredSkillId(skillId);
    if (legion.required !== expectedRequired) {
      return failParse(
        catalogPath,
        skillIdGuess,
        `metadata.legion.required must be ${expectedRequired} for ${skillId}`,
      );
    }
    const body = raw.slice(match[0].length).replace(/^\r?\n/, "");
    const entry = SkillCatalogEntrySchema.safeParse({
      skillId,
      name,
      description,
      required: legion.required,
      compatibility: asString(data.compatibility),
      resources: { scripts: [], references: [], assets: [] },
      bodyChars: body.length,
      path: catalogPath,
    });
    if (!entry.success) {
      const issue = entry.error.issues[0];
      const reason = issue ? `${issue.path.join(".")}: ${issue.message}` : "invalid catalog entry";
      return failParse(catalogPath, skillIdGuess, reason);
    }
    return { ok: true, entry: entry.data, body };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return failParse(catalogPath, skillIdGuess, reason);
  }
}

export function listSkillCatalog(skillsDir: string): {
  catalog: SkillCatalog;
  skipped: Array<{ path: string; reason: string; required: boolean }>;
} {
  const skills: SkillCatalogEntry[] = [];
  const skipped: Array<{ path: string; reason: string; required: boolean }> = [];
  let readable = true;
  try {
    statSync(skillsDir);
  } catch (err) {
    readable = false;
    const reason = err instanceof Error ? err.message : String(err);
    for (const skillId of SkillIdSchema.options) {
      skipped.push({
        path: `skills/${skillId}/SKILL.md`,
        reason: `skills dir unreadable: ${reason}`,
        required: isRequiredSkillId(skillId),
      });
    }
  }
  if (readable) {
    for (const skillId of SkillIdSchema.options) {
      const catalogPath = `skills/${skillId}/SKILL.md`;
      const required = isRequiredSkillId(skillId);
      const skillMd = join(skillsDir, skillId, "SKILL.md");
      if (!existsSync(skillMd)) {
        skipped.push({ path: catalogPath, reason: "missing SKILL.md", required });
        continue;
      }
      let raw: string;
      try {
        raw = readFileSync(skillMd, "utf8");
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        skipped.push({ path: catalogPath, reason, required });
        continue;
      }
      const parsed = parseSkillFrontmatter(raw, catalogPath);
      if (!parsed.ok) {
        skipped.push({ path: parsed.path, reason: parsed.reason, required });
        continue;
      }
      const resources = listLevel3Resources(join(skillsDir, skillId));
      skills.push({ ...parsed.entry, resources });
    }
  }
  return {
    catalog: { schemaVersion: SCHEMA_VERSION.skillCatalog, skills },
    skipped,
  };
}

export function renderSkillCatalog(
  catalog: SkillCatalog,
  opts?: { activeSkillId?: SkillId },
): string {
  const lines = ["# Skills (Level 1 catalog)"];
  for (const skill of catalog.skills) {
    const active = opts?.activeSkillId === skill.skillId ? " (active)" : "";
    let line = `- ${skill.name}${active}: ${skill.description}`;
    if (line.length > SKILL_LEVEL1_LINE_MAX_CHARS) {
      line = line.slice(0, SKILL_LEVEL1_LINE_MAX_CHARS);
    }
    lines.push(line);
  }
  lines.push("Do not load other skill bodies. The engine already chose the active skill.");
  return `${lines.join("\n")}\n`;
}

export function findSkillsDir(from = process.cwd()): string | undefined {
  const env = process.env.LEGION_CLI_SKILLS_DIR?.trim();
  if (env) return env;
  const starts = [from];
  try {
    starts.push(dirname(fileURLToPath(import.meta.url)));
  } catch {
    // ignore
  }
  for (const start of starts) {
    let dir = start;
    for (let i = 0; i < 10; i++) {
      const candidate = join(dir, "skills");
      if (
        existsSync(join(candidate, "interview", "SKILL.md")) ||
        existsSync(join(candidate, "plan", "SKILL.md")) ||
        existsSync(join(candidate, "execute", "SKILL.md"))
      ) {
        return candidate;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return undefined;
}
