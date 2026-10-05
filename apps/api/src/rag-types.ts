import { z } from "zod";

import { normalizeSafeHttpsUrl } from "./sensitive-data.js";

export const RAG_EMBEDDING_DIMENSIONS = 1_536;
export const RAG_SOURCE_EXCERPT_MAX_LENGTH = 320;

export const ragStatusSchema = z.enum([
  "used",
  "disabled",
  "not_configured",
  "no_matches",
  "unavailable",
]);

export const ragSourceSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string().trim().min(1).max(200),
    label: z.string().trim().min(1).max(200),
    url: z.string().url().refine((value) => normalizeSafeHttpsUrl(value) !== undefined).optional(),
    similarity: z.number().finite().min(0).max(1),
    excerpt: z.string().trim().min(1).max(RAG_SOURCE_EXCERPT_MAX_LENGTH),
  })
  .strict();

export const ragMetadataSchema = z
  .object({
    enabled: z.boolean(),
    used: z.boolean(),
    status: ragStatusSchema,
    querySummary: z.string().trim().min(1).max(240),
    sources: z.array(ragSourceSchema).max(10),
  })
  .strict()
  .superRefine((value, context) => {
    const shouldContainSources = value.status === "used";
    if (
      value.used !== shouldContainSources ||
      (shouldContainSources && value.sources.length === 0) ||
      (!shouldContainSources && value.sources.length > 0) ||
      (value.status === "disabled" && value.enabled)
    ) {
      context.addIssue({ code: "custom", message: "El estado RAG no es coherente.", path: ["status"] });
    }
  });

export type RagStatus = z.infer<typeof ragStatusSchema>;
export type RagSource = z.infer<typeof ragSourceSchema>;
export type RagMetadata = z.infer<typeof ragMetadataSchema>;

export interface RagEvidenceSource extends RagSource {
  content: string;
}

export interface RagRetrievalResult {
  metadata: RagMetadata;
  evidence: RagEvidenceSource[];
}
