import { z } from "zod";

export const OD_SCHEMA_VERSION = "od-design-system-project/v1" as const;

const OdSourceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("bundled"), origin: z.string().min(1).optional() }),
  z.object({
    type: z.literal("local"),
    path: z.string().min(1),
    importedAt: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("github"),
    url: z.string().min(1),
    branch: z.string().min(1).optional(),
    commit: z.string().min(1).optional(),
    importedAt: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("shadcn"),
    reference: z.string().min(1),
    registryUrl: z.string().min(1).optional(),
    item: z.string().min(1).optional(),
    homepage: z.string().min(1).optional(),
    importedAt: z.string().min(1).optional(),
  }),
]);

export const OpenDesignManifestSchema = z.object({
  schemaVersion: z.literal(OD_SCHEMA_VERSION),
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  name: z.string().min(1),
  category: z.string().min(1),
  description: z.string().min(1).optional(),
  source: OdSourceSchema,
  files: z.object({
    design: z.literal("DESIGN.md"),
    tokens: z.literal("tokens.css"),
    designTokens: z.literal("design-tokens.json").optional(),
    tailwind: z.literal("tailwind-v4.css").optional(),
    components: z.literal("components.html").optional(),
  }),
  usage: z.string().min(1).optional(),
});
export type OpenDesignManifest = z.infer<typeof OpenDesignManifestSchema>;

export function parseOpenDesignManifest(raw: unknown): OpenDesignManifest {
  return OpenDesignManifestSchema.parse(raw);
}
