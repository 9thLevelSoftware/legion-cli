import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extractHexColors } from "./tokens.js";

export type LensId = "brand" | "ux" | "research";

export type LensResult = {
  id: LensId;
  pass: boolean;
  notes: string;
};

export type ThreeLensReview = {
  brandViolation: boolean;
  lenses: LensResult[];
};

export type ReviewInput = {
  workType: string;
  platforms: string;
  wcag: "A" | "AA" | "AAA";
  brand: string;
  designMd: string;
  tokensCss: string;
  brandFileText?: string;
};

/** Three-lens review (brand / ux / research). Brand violation is a blocker. */
export function threeLensReview(input: ReviewInput): ThreeLensReview {
  const brandNone = /^(none|no|n\/a|-)?$/i.test(input.brand.trim());
  const brandColors = input.brandFileText ? extractHexColors(input.brandFileText) : [];
  const tokenText = input.tokensCss.toLowerCase();
  const missingColors = brandColors.filter((color) => !tokenText.includes(color.toLowerCase()));
  const brandPass =
    Boolean(input.designMd.trim()) &&
    Boolean(input.tokensCss.trim()) &&
    (brandNone || (Boolean(input.brandFileText) && missingColors.length === 0));
  const brandNotes = brandNone
    ? "No brand file; craft defaults apply."
    : missingColors.length > 0
      ? `Brand colors missing from tokens.css: ${missingColors.join(", ")}.`
      : "Brand file colors are present in tokens.css.";

  const uxPass = Boolean(input.workType.trim()) && Boolean(input.platforms.trim());
  const researchPass = Boolean(input.wcag);

  const lenses: LensResult[] = [
    { id: "brand", pass: brandPass, notes: brandNotes },
    {
      id: "ux",
      pass: uxPass,
      notes: uxPass ? `Work type ${input.workType} on ${input.platforms}.` : "Work type and platforms are required.",
    },
    {
      id: "research",
      pass: researchPass,
      notes: `WCAG ${input.wcag}.`,
    },
  ];

  return {
    brandViolation: !brandPass,
    lenses,
  };
}

export async function readOptionalText(path: string | undefined): Promise<string | undefined> {
  if (!path || !existsSync(path)) return undefined;
  return readFile(path, "utf8");
}

export function isUiWork(spec: { wireframesIndex?: string | null }, screens: string[]): boolean {
  return Boolean(spec.wireframesIndex) || screens.length > 0;
}
