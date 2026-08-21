import { z } from "zod";

const MAX_MODULES = 40;
const MAX_DTCS_PER_MODULE = 20;
const MAX_TOTAL_DTCS = 100;
const NON_WHITESPACE_PATTERN = ".*\\S.*";

const diagnosticDtcSchema = z
  .object({
    code: z.string().trim().min(1).max(32),
    description: z.string().trim().min(1).max(1_000),
    status: z.enum(["current", "stored", "pending", "permanent", "history", "unknown"]),
  })
  .strict();

const diagnosticModuleSchema = z
  .object({
    code: z.string().trim().min(1).max(32).nullable(),
    name: z.string().trim().min(1).max(160),
    dtcs: z.array(diagnosticDtcSchema).max(MAX_DTCS_PER_MODULE),
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
    relatedDtcCode: z.string().trim().min(1).max(32).nullable(),
    priority: z.enum(["critical", "high", "medium", "low"]),
    simpleExplanation: z.string().trim().min(1).max(1_000),
    possibleCauses: z.array(z.string().trim().min(1).max(500)).min(1).max(8),
    recommendedChecks: z.array(z.string().trim().min(1).max(500)).min(1).max(10),
    safetyWarnings: z.array(z.string().trim().min(1).max(500)).min(1).max(8),
    confidence: z.enum(["high", "medium", "low"]),
  })
  .strict();

export const diagnosticAnalysisOutputSchema = z
  .object({
    technicalSummary: z.string().trim().min(1).max(1_500),
    findings: z.array(diagnosticFindingSchema).min(1).max(20),
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
          relatedDtcCode: {
            type: ["string", "null"],
            minLength: 1,
            maxLength: 32,
            pattern: NON_WHITESPACE_PATTERN,
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
          "relatedDtcCode",
          "priority",
          "simpleExplanation",
          "possibleCauses",
          "recommendedChecks",
          "safetyWarnings",
          "confidence",
        ],
      },
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
  required: ["technicalSummary", "findings", "safetyWarnings", "confidence", "requiresTechnicianConfirmation"],
} as const;
