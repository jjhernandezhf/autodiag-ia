import { z } from "zod";

const text = (max: number) => z.string().trim().min(1).max(max);
export const reportedStatusSchema = z.enum(["current", "confirmed", "stored", "pending", "permanent", "intermittent",
  "on_demand", "continuous_memory", "provisional", "reviewed_uncertain", "history", "unknown"]);
export const reviewVehicleSchema = z.object({
  year: z.number().int().min(1886).max(9999).nullable(), make: text(80).nullable(), model: text(120).nullable(),
  engine: text(160).nullable(), odometer: z.object({ value: z.number().finite().nonnegative().max(100_000_000), unit: z.enum(["km", "mi"]) }).strict().nullable(),
  odometerRaw: text(80).optional(),
}).strict();
export const reviewSystemSchema = z.object({ code: text(32).nullable(), name: text(160), dtcCount: z.number().int().nonnegative().max(100_000) }).strict();
export const reviewDtcSchema = z.object({ code: z.string().max(32), moduleCode: text(32).nullable(), moduleName: text(160),
  descriptionOriginal: z.string().max(1000), status: reportedStatusSchema, statusOriginal: text(120).nullable(),
  classification: z.enum(["actionable", "historical", "unknown"]),
}).strict();
export const reviewSummarySchema = z.object({ declaredSystems: z.number().int().nonnegative().max(10000).nullable(),
  parsedSystems: z.number().int().nonnegative().max(10000), declaredDtcs: z.number().int().nonnegative().max(100000).nullable(),
  parsedDtcs: z.number().int().nonnegative().max(100000),
}).strict();
export const reviewDecisionSchema = z.object({ path: z.string().regex(/^(?:vehicle\.(?:make|model|year)|rows\.\d+\.(?:code|module|description|status)|counts|extraction)$/u),
  before: z.string().max(2000).nullable(), after: z.string().max(2000).nullable(), reason: text(500).min(10),
}).strict();
export const limitedGuidanceSchema = z.object({
  mode: z.literal("limited_guidance_v1"), coverage: z.literal("reviewed_rows_only"),
  limitations: z.array(text(500)).min(1).max(510),
  positions: z.array(z.object({ rowIndex: z.number().int().min(0).max(199),
    page: z.number().int().min(1).max(1000).nullable(), line: z.number().int().min(1).max(100000).nullable(),
    provenance: z.enum(["parser_row_reviewed", "manual_transcription"]), reason: text(500).min(10),
  }).strict()).min(1).max(200),
}).strict();
export const reportReviewEvidenceSchema = z.object({
  limited: limitedGuidanceSchema.optional(),
  version: z.literal("report_review_v1"), reason: text(500).min(10),
  original: z.object({ status: z.enum(["completed", "partial"]), requiresManualReview: z.boolean(), vehicle: reviewVehicleSchema,
    scanSummary: reviewSummarySchema, systems: z.array(reviewSystemSchema).max(100), dtcs: z.array(reviewDtcSchema).max(200),
    warnings: z.array(z.object({ code: text(80), message: text(500) }).strict()).max(100),
  }).strict(),
  decisions: z.array(reviewDecisionSchema).min(1).max(1400),
}).strict();
export type ReportReviewEvidence = z.infer<typeof reportReviewEvidenceSchema>;
