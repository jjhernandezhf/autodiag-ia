import { z } from "zod";

const MAX_MODULES = 40;
const MAX_DTCS_PER_MODULE = 20;
const MAX_TOTAL_DTCS = 100;
const NON_WHITESPACE_PATTERN = ".*\\S.*";
export const MAX_VEHICLE_OBSERVATIONS_LENGTH = 1_000;

export const actionableDtcStatusSchema = z.enum([
  "current",
  "confirmed",
  "stored",
  "pending",
  "permanent",
  "intermittent",
]);

const diagnosticDtcSchema = z
  .object({
    code: z.string().trim().min(1).max(32),
    description: z.string().trim().min(1).max(1_000),
    status: actionableDtcStatusSchema,
    alsoHistorical: z.boolean(),
  })
  .strict();

const diagnosticModuleSchema = z
  .object({
    code: z.string().trim().min(1).max(32).nullable(),
    name: z.string().trim().min(1).max(160),
    dtcs: z.array(diagnosticDtcSchema).min(1).max(MAX_DTCS_PER_MODULE),
  })
  .strict();

export const diagnosticAnalysisInputSchema = z
  .object({
    vehicle: z
      .object({
        make: z.string().trim().min(1).max(80),
        model: z.string().trim().min(1).max(120),
        year: z.number().int().min(1886).max(new Date().getUTCFullYear() + 1),
      })
      .strict(),
    modules: z.array(diagnosticModuleSchema).min(1).max(MAX_MODULES),
    observations: z.preprocess(
      (value) => {
        if (value === null) return undefined;
        if (typeof value !== "string") return value;
        return value.trim().length === 0 ? undefined : value;
      },
      z.string().max(MAX_VEHICLE_OBSERVATIONS_LENGTH).transform((value) => value.trim()).optional(),
    ),
  })
  .strict()
  .superRefine((value, context) => {
    const totalDtcs = value.modules.reduce((total, module) => total + module.dtcs.length, 0);
    if (totalDtcs > MAX_TOTAL_DTCS) {
      context.addIssue({
        code: "custom",
        message: "La solicitud excede la cantidad permitida de DTC.",
        path: ["modules"],
      });
    }
  });

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
    matches: z.array(observationMatchSchema).max(20),
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
    findings: z.array(diagnosticFindingSchema).min(1).max(20),
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
      maxItems: 20,
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
          maxItems: 20,
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
