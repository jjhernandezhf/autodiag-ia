import { z } from "zod";

import { prepareAiAnalysis } from "./ai-analysis-adapter.js";
import {
  diagnosticAnalysisOutputSchema,
  type DiagnosticAnalysisOutput,
} from "./ai-analysis-types.js";
import type { AutelExtraction, DtcStatus } from "./report-types.js";
import { containsVinCandidate } from "./text-normalization.js";

const nullableTextSchema = z.string().nullable();

const extractionSchema = z
  .object({
    status: z.enum(["completed", "partial"]),
    format: z.literal("autel_vehicle_diagnostic_report"),
    requiresManualReview: z.boolean(),
    vehicle: z
      .object({
        year: z.number().int().nullable(),
        make: nullableTextSchema,
        model: nullableTextSchema,
        engine: nullableTextSchema,
        odometer: z
          .object({
            value: z.number().finite().nonnegative(),
            unit: z.enum(["km", "mi"]),
          })
          .strict()
          .nullable(),
        vinMasked: nullableTextSchema,
        vinPseudonym: nullableTextSchema,
      })
      .strict(),
    scanSummary: z
      .object({
        declaredSystems: z.number().int().nonnegative().nullable(),
        parsedSystems: z.number().int().nonnegative(),
        declaredDtcs: z.number().int().nonnegative().nullable(),
        parsedDtcs: z.number().int().nonnegative(),
      })
      .strict(),
    systems: z.array(
      z
        .object({
          code: nullableTextSchema,
          name: z.string(),
          dtcCount: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    dtcs: z.array(
      z
        .object({
          code: z.string(),
          moduleCode: nullableTextSchema,
          moduleName: z.string(),
          status: z.enum(["current", "stored", "pending", "permanent", "history", "unknown"]),
          statusOriginal: nullableTextSchema,
          descriptionOriginal: z.string(),
        })
        .strict(),
    ),
    warnings: z.array(
      z
        .object({
          code: z.string(),
          message: z.string(),
        })
        .strict(),
    ),
  })
  .strict();

const completedAnalysisSchema = z
  .object({
    status: z.literal("completed"),
    analysis: diagnosticAnalysisOutputSchema,
  })
  .strict();

export type DiagnosticPersistenceFailureCode =
  | "EXTRACTION_INVALID"
  | "EXTRACTION_INCOMPLETE"
  | "ANALYSIS_NOT_COMPLETED"
  | "ANALYSIS_INVALID"
  | "DTC_REFERENCE_INVALID"
  | "SENSITIVE_CONTENT_DETECTED";

export interface PersistablePositionedText {
  value: string;
  position: number;
}

export interface PersistableDiagnosticDtc {
  code: string;
  description: string;
  status: DtcStatus;
  position: number;
}

export interface PersistableDiagnosticModule {
  code: string | null;
  name: string;
  position: number;
  dtcs: PersistableDiagnosticDtc[];
}

export interface PersistableDiagnosticFinding {
  relatedDtcCode: string | null;
  priority: DiagnosticAnalysisOutput["findings"][number]["priority"];
  simpleExplanation: string;
  confidence: DiagnosticAnalysisOutput["findings"][number]["confidence"];
  position: number;
  possibleCauses: PersistablePositionedText[];
  recommendedChecks: PersistablePositionedText[];
  safetyWarnings: PersistablePositionedText[];
}

export interface PersistableDiagnosticRecord {
  report: {
    make: string;
    model: string;
    year: number;
    extractionStatus: "completed";
    analysisStatus: "completed";
  };
  modules: PersistableDiagnosticModule[];
  analysis: {
    technicalSummary: string;
    confidence: DiagnosticAnalysisOutput["confidence"];
    requiresTechnicianConfirmation: true;
    findings: PersistableDiagnosticFinding[];
    safetyWarnings: PersistablePositionedText[];
  };
}

export type DiagnosticPersistenceResult =
  | { persistable: true; record: PersistableDiagnosticRecord }
  | { persistable: false; code: DiagnosticPersistenceFailureCode; message: string };

const FAILURE_MESSAGES: Record<DiagnosticPersistenceFailureCode, string> = {
  EXTRACTION_INVALID: "La extracción no cumple el contrato requerido para persistencia.",
  EXTRACTION_INCOMPLETE: "La extracción debe estar completa y no requerir revisión manual.",
  ANALYSIS_NOT_COMPLETED: "La orientación de IA debe estar completada antes de persistirse.",
  ANALYSIS_INVALID: "La orientación de IA no cumple el contrato requerido para persistencia.",
  DTC_REFERENCE_INVALID: "Un hallazgo no puede asociarse de forma inequívoca con un DTC del reporte.",
  SENSITIVE_CONTENT_DETECTED: "El registro contiene información potencialmente sensible y no puede persistirse.",
};

function failure(code: DiagnosticPersistenceFailureCode): DiagnosticPersistenceResult {
  return { persistable: false, code, message: FAILURE_MESSAGES[code] };
}

function containsSensitiveContent(value: unknown): boolean {
  if (typeof value === "string") {
    return (
      containsVinCandidate(value) ||
      /(?:^|[^\p{L}\p{N}_])vin_v1_[a-z0-9_-]+/iu.test(value) ||
      /(?:^|[^\p{L}\p{N}])\*{13}[A-HJ-NPR-Z0-9]{4}(?=$|[^\p{L}\p{N}])/iu.test(value)
    );
  }
  if (Array.isArray(value)) return value.some(containsSensitiveContent);
  if (value !== null && typeof value === "object") return Object.values(value).some(containsSensitiveContent);
  return false;
}

function positioned(values: string[]): PersistablePositionedText[] {
  return values.map((value, position) => ({ value, position }));
}

export function buildDiagnosticPersistenceRecord(
  rawExtraction: unknown,
  rawCompletedAnalysis: unknown,
): DiagnosticPersistenceResult {
  const extractionValidation = extractionSchema.safeParse(rawExtraction);
  if (!extractionValidation.success) return failure("EXTRACTION_INVALID");

  const extraction: AutelExtraction = extractionValidation.data;
  if (extraction.status !== "completed" || extraction.requiresManualReview) {
    return failure("EXTRACTION_INCOMPLETE");
  }

  const preparation = prepareAiAnalysis(extraction);
  if (!preparation.available) {
    if (preparation.reasons.some((reason) => reason.code === "SENSITIVE_CONTENT_DETECTED")) {
      return failure("SENSITIVE_CONTENT_DETECTED");
    }
    return failure("EXTRACTION_INVALID");
  }

  if (
    rawCompletedAnalysis === null ||
    typeof rawCompletedAnalysis !== "object" ||
    !("status" in rawCompletedAnalysis) ||
    rawCompletedAnalysis.status !== "completed"
  ) {
    return failure("ANALYSIS_NOT_COMPLETED");
  }

  const analysisValidation = completedAnalysisSchema.safeParse(rawCompletedAnalysis);
  if (!analysisValidation.success) return failure("ANALYSIS_INVALID");
  const analysis = analysisValidation.data.analysis;

  const dtcOccurrences = new Map<string, number>();
  for (const module of preparation.input.modules) {
    for (const dtc of module.dtcs) {
      dtcOccurrences.set(dtc.code, (dtcOccurrences.get(dtc.code) ?? 0) + 1);
    }
  }
  if (
    analysis.findings.some(
      (finding) => finding.relatedDtcCode !== null && dtcOccurrences.get(finding.relatedDtcCode) !== 1,
    )
  ) {
    return failure("DTC_REFERENCE_INVALID");
  }

  const record: PersistableDiagnosticRecord = {
    report: {
      make: preparation.input.vehicle.make,
      model: preparation.input.vehicle.model,
      year: preparation.input.vehicle.year,
      extractionStatus: "completed",
      analysisStatus: "completed",
    },
    modules: preparation.input.modules.map((module, modulePosition) => ({
      code: module.code,
      name: module.name,
      position: modulePosition,
      dtcs: module.dtcs.map((dtc, dtcPosition) => ({
        code: dtc.code,
        description: dtc.description,
        status: dtc.status,
        position: dtcPosition,
      })),
    })),
    analysis: {
      technicalSummary: analysis.technicalSummary,
      confidence: analysis.confidence,
      requiresTechnicianConfirmation: analysis.requiresTechnicianConfirmation,
      findings: analysis.findings.map((finding, findingPosition) => ({
        relatedDtcCode: finding.relatedDtcCode,
        priority: finding.priority,
        simpleExplanation: finding.simpleExplanation,
        confidence: finding.confidence,
        position: findingPosition,
        possibleCauses: positioned(finding.possibleCauses),
        recommendedChecks: positioned(finding.recommendedChecks),
        safetyWarnings: positioned(finding.safetyWarnings),
      })),
      safetyWarnings: positioned(analysis.safetyWarnings),
    },
  };

  if (containsSensitiveContent(record)) return failure("SENSITIVE_CONTENT_DETECTED");
  return { persistable: true, record };
}
