import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Spec } from "@9thlevelsoftware/legion-cli-schema";

export type QaChecklistReceipt = {
  specId: string;
  ticks: string[];
  updatedAt: string;
};

export const CHECKLIST_STORE_PATH = ".legion-cli/qa/checklist.json";

export function checklistComplete(spec: Pick<Spec, "id" | "acceptance">, receipt: QaChecklistReceipt | null): boolean {
  if (!receipt || receipt.specId !== spec.id) return false;
  const ticks = new Set(receipt.ticks);
  return spec.acceptance.every((ac) => ticks.has(ac.id));
}

export async function readChecklist(projectRoot: string): Promise<QaChecklistReceipt | null> {
  try {
    const raw = JSON.parse(await readFile(join(projectRoot, ".legion-cli", "qa", "checklist.json"), "utf8")) as unknown;
    if (!raw || typeof raw !== "object") return null;
    const rec = raw as { specId?: unknown; ticks?: unknown; updatedAt?: unknown };
    if (typeof rec.specId !== "string" || rec.specId.length === 0) return null;
    const ticks = Array.isArray(rec.ticks) ? rec.ticks.filter((id): id is string => typeof id === "string") : [];
    return {
      specId: rec.specId,
      ticks,
      updatedAt: typeof rec.updatedAt === "string" ? rec.updatedAt : "",
    };
  } catch {
    return null;
  }
}

export async function writeChecklist(projectRoot: string, receipt: QaChecklistReceipt): Promise<string> {
  const dir = join(projectRoot, ".legion-cli", "qa");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "checklist.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return CHECKLIST_STORE_PATH;
}
