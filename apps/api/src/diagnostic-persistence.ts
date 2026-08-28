import { z } from "zod";

import { prepareAiAnalysis } from "./ai-analysis-adapter.js";
import {
  diagnosticAnalysisOutputSchema,
  type DiagnosticAnalysisOutput,
} from "./ai-analysis-types.js";
import type { AutelExtraction, DtcClassification, DtcStatus, ParsedDtc, ScannedSystem } from "./report-types.js";
import { containsVinCandidate } from "./text-normalization.js";

const nullableTextSchema = z.string().nullable();
const dtcStatusSchema = z.enum([
  "current",
  "confirmed",
  "stored",
  "pending",
  "permanent",
  "intermittent",
  "history",
  "unknown",
]);

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
          status: dtcStatusSchema,
          statusOriginal: nullableTextSchema,
          classification: z.enum(["actionable", "historical", "unknown"]),
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
  statusOriginal: string | null;
  classification: DtcClassification;
  position: number;
}

export interface PersistableDiagnosticModule {
  code: string | null;
  name: string;
  position: number;
  dtcs: PersistableDiagnosticDtc[];
}

export interface PersistableDtcReference {
  code: string;
  modulePosition: number;
  dtcPosition: number;
}

export interface PersistableDiagnosticFinding {
  relatedDtc: PersistableDtcReference | null;
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

function matchesSystem(system: ScannedSystem, dtc: ParsedDtc) {
  if (system.code !== null) return dtc.moduleCode === system.code;
  return dtc.moduleCode === null && dtc.moduleName === system.name;
}

function dtcIdentity(value: { code: string; moduleCode: string | null; moduleName: string }) {
  return JSON.stringify([value.moduleCode, value.moduleName, value.code]);
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

  const assignmentCounts = extraction.dtcs.map(() => 0);
  const modules: PersistableDiagnosticModule[] = extraction.systems.map((system, modulePosition) => {
    const dtcs = extraction.dtcs.flatMap((dtc, extractionIndex) => {
      if (!matchesSystem(system, dtc)) return [];
      assignmentCounts[extractionIndex] = (assignmentCounts[extractionIndex] ?? 0) + 1;
      return [{
        code: dtc.code,
        description: dtc.descriptionOriginal,
        status: dtc.status,
        statusOriginal: dtc.statusOriginal,
        classification: dtc.classification,
        position: extractionIndex,
      }];
    });
    return { code: system.code, name: system.name, position: modulePosition, dtcs };
  });
  if (
    assignmentCounts.some((count) => count !== 1) ||
    modules.some((module, index) => module.dtcs.length !== extraction.systems[index]?.dtcCount)
  ) {
    return failure("EXTRACTION_INVALID");
  }

  const actionableReferences = new Map<string, PersistableDtcReference>();
  for (const inputModule of preparation.input.modules) {
    const modulePosition = modules.findIndex(
      (module) => module.code === inputModule.code && module.name === inputModule.name,
    );
    if (modulePosition < 0) return failure("DTC_REFERENCE_INVALID");
    const persistedModule = modules[modulePosition]!;
    for (const inputDtc of inputModule.dtcs) {
      const dtcIndex = persistedModule.dtcs.findIndex(
        (dtc) => dtc.code === inputDtc.code && dtc.classification === "actionable",
      );
      if (dtcIndex < 0) return failure("DTC_REFERENCE_INVALID");
      actionableReferences.set(
        dtcIdentity({ code: inputDtc.code, moduleCode: inputModule.code, moduleName: inputModule.name }),
        { code: inputDtc.code, modulePosition, dtcPosition: persistedModule.dtcs[dtcIndex]!.position },
      );
    }
  }

  const relatedIdentities = analysis.findings.flatMap((finding) =>
    finding.relatedDtc === null ? [] : [dtcIdentity(finding.relatedDtc)],
  );
  if (
    relatedIdentities.some((identity) => !actionableReferences.has(identity)) ||
    new Set(relatedIdentities).size !== relatedIdentities.length
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
    modules,
    analysis: {
      technicalSummary: analysis.technicalSummary,
      confidence: analysis.confidence,
      requiresTechnicianConfirmation: analysis.requiresTechnicianConfirmation,
      findings: analysis.findings.map((finding, position) => ({
        relatedDtc: finding.relatedDtc === null
          ? null
          : actionableReferences.get(dtcIdentity(finding.relatedDtc)) ?? null,
        priority: finding.priority,
        simpleExplanation: finding.simpleExplanation,
        confidence: finding.confidence,
        position,
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
