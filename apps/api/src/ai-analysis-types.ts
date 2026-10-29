import { z } from "zod";
import { normalizeDtcStatus } from "./text-normalization.js";
import { reviewDecisionSchema, limitedGuidanceSchema } from "./report-review-schema.js";

export const DIAGNOSTIC_OUTPUT_SCHEMA_VERSION = "diagnostic_output_schema_v1";

const MAX_MODULES = 40;
export const MAX_ANALYSIS_DTCS = 50;
export const MAX_ANALYSIS_OBSERVATIONS = 200;
const MAX_DTCS_PER_MODULE = MAX_ANALYSIS_DTCS;
const MAX_TOTAL_DTCS = MAX_ANALYSIS_DTCS;
const NON_WHITESPACE_PATTERN = ".*\\S.*";
export const MAX_VEHICLE_OBSERVATIONS_LENGTH = 1_000;

export const actionableDtcStatusSchema = z.enum([
  "current",
  "confirmed",
  "stored",
  "pending",
  "permanent",
  "intermittent",
  "on_demand",
  "continuous_memory",
  "provisional",
  "reviewed_uncertain",
  "multiple_observed",
]);

const diagnosticDtcSchema = z
  .object({
    code: z.string().trim().min(1).max(32),
    description: z.string().trim().min(1).max(1_000),
    status: actionableDtcStatusSchema,
    alsoHistorical: z.boolean(),
    observations: z.array(z.object({
      description: z.string().trim().min(1).max(1_000),
      status: actionableDtcStatusSchema.exclude(["multiple_observed"]).or(z.enum(["history", "unknown"])),
      statusOriginal: z.string().trim().min(1).max(120).nullable(),
    }).strict()).min(1).max(MAX_ANALYSIS_OBSERVATIONS).optional(),
  })
  .strict();

const diagnosticModuleSchema = z
  .object({
    code: z.string().trim().min(1).max(32).nullable(),
    name: z.string().trim().min(1).max(160),
    dtcs: z.array(diagnosticDtcSchema).min(1).max(MAX_DTCS_PER_MODULE),
  })
  .strict();

const legacyReviewContextSchema = z.object({ version: z.literal("review_context_v1"), reason: z.string().trim().min(10).max(500),
  correctedFields: z.array(z.string().trim().min(1).max(120)).min(1).max(1400),
}).strict();
const reviewContextSchema = z.discriminatedUnion("version", [legacyReviewContextSchema, legacyReviewContextSchema.extend({
  version: z.literal("review_context_v2"), provenance: z.literal("user_review_unverified"),
  decisions: z.array(reviewDecisionSchema).min(1).max(1400),
  limited: limitedGuidanceSchema.optional(),
}).strict()]);

export const diagnosticAnalysisInputSchema = z
  .object({
    vehicle: z
      .object({
        make: z.string().trim().min(1).max(80).nullable(),
        model: z.string().trim().min(1).max(120).nullable(),
        year: z.number().int().min(1886).max(new Date().getUTCFullYear() + 1).nullable(),
      })
      .strict(),
    modules: z.array(diagnosticModuleSchema).min(1).max(MAX_MODULES),
    reviewContext: reviewContextSchema.optional(),
    observations: z.preprocess(
      (value) => {
        if (value === null) return undefined;
        if (typeof value !== "string") return value;
        return value.trim().length === 0 ? undefined : value;
      },
      z.string().max(MAX_VEHICLE_OBSERVATIONS_LENGTH)
        .transform((value) => value.replace(/\r\n?/gu, "\n").trim())
        .optional(),
    ),
  })
  .strict()
  .superRefine((value, context) => {
    if (Object.values(value.vehicle).some(v => v === null) && !(value.reviewContext?.version === "review_context_v2" && value.reviewContext.limited)) {
      context.addIssue({ code: "custom", message: "Los datos desconocidos requieren revisión limitada validada.", path: ["vehicle"] });
    }
    const totalDtcs = value.modules.reduce((total, module) => total + module.dtcs.length, 0);
    if (totalDtcs > MAX_TOTAL_DTCS) {
      context.addIssue({
        code: "custom",
        message: "La solicitud excede la cantidad permitida de DTC.",
        path: ["modules"],
      });
    }
    const dtcs = value.modules.flatMap(module => module.dtcs);
    const observations = dtcs.reduce((sum, dtc) => sum + (dtc.observations?.length ?? 1), 0);
    if (observations > MAX_ANALYSIS_OBSERVATIONS || JSON.stringify(value).length > 100_000) {
      context.addIssue({ code: "custom", message: "La solicitud supera los límites de observaciones o texto.", path: ["modules"] });
    }
    for (const dtc of dtcs) {
      if (dtc.status === "multiple_observed" && (!dtc.observations || new Set(dtc.observations.filter(row => row.status !== "history").map(row => row.status)).size < 2)) {
        context.addIssue({ code: "custom", message: "Faltan los estados observados de la identidad.", path: ["modules"] });
      }
      if (dtc.observations) {
        const observed = new Set(dtc.observations.filter(row => row.status !== "history").map(row => row.status));
        const expected = observed.size > 1 ? "multiple_observed" : [...observed][0];
        if (observed.has("unknown") || dtc.status !== expected || dtc.alsoHistorical !== dtc.observations.some(row => row.status === "history") ||
          dtc.observations.some(row => row.status !== "reviewed_uncertain" && normalizeDtcStatus(row.statusOriginal) !== row.status)) {
          context.addIssue({ code: "custom", message: "El estado agregado no representa todas las observaciones.", path: ["modules"] });
        }
      }
    }
  });

// Read-only compatibility with previously saved inputs. Never used to admit new
// requests: older releases allowed 100 total / 20 per module.
const legacyHistoryInputSchema = z.object({
  vehicle: diagnosticAnalysisInputSchema.shape.vehicle,
  modules: z.array(z.object({ code: z.string().trim().min(1).max(32).nullable(), name: z.string().trim().min(1).max(160),
    dtcs: z.array(z.object({ code: z.string().trim().min(1).max(32), description: z.string().trim().min(1).max(1000),
      status: z.enum(["current", "confirmed", "stored", "pending", "permanent", "intermittent"]), alsoHistorical: z.boolean(),
    }).strict()).min(1).max(20),
  }).strict()).min(1).max(40),
  observations: diagnosticAnalysisInputSchema.shape.observations,
}).strict().refine(value => value.modules.reduce((sum, m) => sum + m.dtcs.length, 0) <= 100);
export const historicalAnalysisInputSchema = z.union([diagnosticAnalysisInputSchema, legacyHistoryInputSchema]);

const diagnosticFindingSchema = z
  .object({
    relatedDtc: z
      .object({
        code: z.string().trim().min(1).max(32),
        moduleCode: z.string().trim().min(1).max(32).nullable(),
        moduleName: z.string().trim().min(1).max(160),
      })
      .strict()
      .nullable(),
    priority: z.enum(["critical", "high", "medium", "low"]),
    simpleExplanation: z.string().trim().min(1).max(1_000),
    possibleCauses: z.array(z.string().trim().min(1).max(500)).min(1).max(8),
    recommendedChecks: z.array(z.string().trim().min(1).max(500)).min(1).max(10),
    safetyWarnings: z.array(z.string().trim().min(1).max(500)).min(1).max(8),
    confidence: z.enum(["high", "medium", "low"]),
  })
  .strict();

const relatedDtcSchema = z
  .object({
    code: z.string().trim().min(1).max(32),
    moduleCode: z.string().trim().min(1).max(32).nullable(),
    moduleName: z.string().trim().min(1).max(160),
  })
  .strict();

const observationMatchSchema = z
  .object({
    relatedDtc: relatedDtcSchema,
    observation: z.string().trim().min(1).max(300),
    possibleRelation: z.string().trim().min(1).max(700),
    confidence: z.enum(["high", "medium", "low"]),
  })
  .strict();

const observationCorrelationSchema = z
  .object({
    status: z.enum(["not_provided", "no_clear_match", "matches_found"]),
    summary: z.string().trim().min(1).max(1_000),
    matches: z.array(observationMatchSchema).max(MAX_ANALYSIS_DTCS),
  })
  .strict()
  .superRefine((value, context) => {
    const shouldHaveMatches = value.status === "matches_found";
    if ((shouldHaveMatches && value.matches.length === 0) || (!shouldHaveMatches && value.matches.length > 0)) {
      context.addIssue({
        code: "custom",
        message: "El estado de correlación no coincide con sus asociaciones.",
        path: ["matches"],
      });
    }
  });

export const diagnosticAnalysisOutputSchema = z
  .object({
    technicalSummary: z.string().trim().min(1).max(1_500),
    findings: z.array(diagnosticFindingSchema).min(1).max(MAX_ANALYSIS_DTCS),
    observationCorrelation: observationCorrelationSchema,
    safetyWarnings: z.array(z.string().trim().min(1).max(500)).min(1).max(10),
    confidence: z.enum(["high", "medium", "low"]),
    requiresTechnicianConfirmation: z.literal(true),
  })
  .strict();

export type DiagnosticAnalysisInput = z.infer<typeof diagnosticAnalysisInputSchema>;
export type DiagnosticAnalysisOutput = z.infer<typeof diagnosticAnalysisOutputSchema>;

export const DIAGNOSTIC_ANALYSIS_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    technicalSummary: { type: "string", minLength: 1, maxLength: 1_500, pattern: NON_WHITESPACE_PATTERN },
    findings: {
      type: "array",
      minItems: 1,
      maxItems: MAX_ANALYSIS_DTCS,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          relatedDtc: {
            anyOf: [
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  code: { type: "string", minLength: 1, maxLength: 32, pattern: NON_WHITESPACE_PATTERN },
                  moduleCode: {
                    type: ["string", "null"],
                    minLength: 1,
                    maxLength: 32,
                    pattern: NON_WHITESPACE_PATTERN,
                  },
                  moduleName: { type: "string", minLength: 1, maxLength: 160, pattern: NON_WHITESPACE_PATTERN },
                },
                required: ["code", "moduleCode", "moduleName"],
              },
              { type: "null" },
            ],
          },
          priority: { type: "string", enum: ["critical", "high", "medium", "low"] },
          simpleExplanation: {
            type: "string",
            minLength: 1,
            maxLength: 1_000,
            pattern: NON_WHITESPACE_PATTERN,
          },
          possibleCauses: {
            type: "array",
            minItems: 1,
            maxItems: 8,
            items: { type: "string", minLength: 1, maxLength: 500, pattern: NON_WHITESPACE_PATTERN },
          },
          recommendedChecks: {
            type: "array",
            minItems: 1,
            maxItems: 10,
            items: { type: "string", minLength: 1, maxLength: 500, pattern: NON_WHITESPACE_PATTERN },
          },
          safetyWarnings: {
            type: "array",
            minItems: 1,
            maxItems: 8,
            items: { type: "string", minLength: 1, maxLength: 500, pattern: NON_WHITESPACE_PATTERN },
          },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
        },
        required: [
          "relatedDtc",
          "priority",
          "simpleExplanation",
          "possibleCauses",
          "recommendedChecks",
          "safetyWarnings",
          "confidence",
        ],
      },
    },
    observationCorrelation: {
      type: "object",
      additionalProperties: false,
      properties: {
        status: { type: "string", enum: ["not_provided", "no_clear_match", "matches_found"] },
        summary: { type: "string", minLength: 1, maxLength: 1_000, pattern: NON_WHITESPACE_PATTERN },
        matches: {
          type: "array",
          maxItems: MAX_ANALYSIS_DTCS,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              relatedDtc: {
                type: "object",
                additionalProperties: false,
                properties: {
                  code: { type: "string", minLength: 1, maxLength: 32, pattern: NON_WHITESPACE_PATTERN },
                  moduleCode: {
                    type: ["string", "null"],
                    minLength: 1,
                    maxLength: 32,
                    pattern: NON_WHITESPACE_PATTERN,
                  },
                  moduleName: { type: "string", minLength: 1, maxLength: 160, pattern: NON_WHITESPACE_PATTERN },
                },
                required: ["code", "moduleCode", "moduleName"],
              },
              observation: { type: "string", minLength: 1, maxLength: 300, pattern: NON_WHITESPACE_PATTERN },
              possibleRelation: { type: "string", minLength: 1, maxLength: 700, pattern: NON_WHITESPACE_PATTERN },
              confidence: { type: "string", enum: ["high", "medium", "low"] },
            },
            required: ["relatedDtc", "observation", "possibleRelation", "confidence"],
          },
        },
      },
      required: ["status", "summary", "matches"],
    },
    safetyWarnings: {
      type: "array",
      minItems: 1,
      maxItems: 10,
      items: { type: "string", minLength: 1, maxLength: 500, pattern: NON_WHITESPACE_PATTERN },
    },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    requiresTechnicianConfirmation: { type: "boolean", const: true },
  },
  required: [
    "technicalSummary",
    "findings",
    "observationCorrelation",
    "safetyWarnings",
    "confidence",
    "requiresTechnicianConfirmation",
  ],
} as const;
