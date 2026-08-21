import { diagnosticAnalysisInputSchema, type DiagnosticAnalysisInput } from "./ai-analysis-types.js";
import type {
  AiAnalysisAvailabilityReason,
  AiAnalysisPreparation,
  AutelExtraction,
  ParsedDtc,
  ScannedSystem,
} from "./report-types.js";
import { containsVinCandidate } from "./text-normalization.js";

const MAX_MODULES = 40;
const MAX_DTCS_PER_MODULE = 20;
const MAX_TOTAL_DTCS = 100;

const GENERIC_EXTRACTION_WARNING = "La extracción incluye advertencias que deben revisarse antes de solicitar orientación.";

function matchesSystem(system: ScannedSystem, dtc: ParsedDtc) {
  if (system.code !== null) return dtc.moduleCode === system.code;
  return dtc.moduleCode === null && dtc.moduleName === system.name;
}

function hasRequiredText(value: string | null) {
  return value !== null && value.trim().length > 0;
}

function addReason(
  reasons: AiAnalysisAvailabilityReason[],
  code: AiAnalysisAvailabilityReason["code"],
  message: string,
) {
  if (!reasons.some((reason) => reason.code === code)) reasons.push({ code, message });
}

function containsSensitiveContent(value: unknown): boolean {
  if (typeof value === "string") return containsVinCandidate(value);
  if (Array.isArray(value)) return value.some(containsSensitiveContent);
  if (value !== null && typeof value === "object") {
    return Object.values(value).some(containsSensitiveContent);
  }
  return false;
}

export function prepareAiAnalysis(extraction: AutelExtraction): AiAnalysisPreparation {
  const reasons: AiAnalysisAvailabilityReason[] = [];
  const warnings = extraction.warnings.length > 0 ? [GENERIC_EXTRACTION_WARNING] : [];

  if (extraction.status !== "completed") {
    addReason(reasons, "EXTRACTION_INCOMPLETE", "La extracción debe estar completa antes de solicitar orientación por IA.");
  }
  if (extraction.requiresManualReview) {
    addReason(reasons, "MANUAL_REVIEW_REQUIRED", "El reporte requiere revisión manual antes de solicitar orientación por IA.");
  }
  if (
    extraction.scanSummary.declaredSystems === null ||
    extraction.scanSummary.declaredSystems !== extraction.scanSummary.parsedSystems
  ) {
    addReason(reasons, "SYSTEM_TOTAL_MISMATCH", "La cantidad de módulos interpretados no coincide con el total declarado.");
  }
  if (
    extraction.scanSummary.declaredDtcs === null ||
    extraction.scanSummary.declaredDtcs !== extraction.scanSummary.parsedDtcs
  ) {
    addReason(reasons, "DTC_TOTAL_MISMATCH", "La cantidad de DTC interpretados no coincide con el total declarado.");
  }
  if (
    extraction.scanSummary.parsedSystems !== extraction.systems.length ||
    extraction.scanSummary.parsedDtcs !== extraction.dtcs.length
  ) {
    addReason(reasons, "EXTRACTION_DATA_INCONSISTENT", "Los datos interpretados no coinciden con el resumen de extracción.");
  }

  const { make, model, year } = extraction.vehicle;
  if (!hasRequiredText(make) || !hasRequiredText(model) || year === null) {
    addReason(reasons, "VEHICLE_DATA_MISSING", "Faltan marca, modelo o año requeridos para solicitar orientación por IA.");
  }
  if (extraction.dtcs.length === 0) {
    addReason(reasons, "NO_VALID_DTCS", "El reporte no contiene DTC válidos para analizar.");
  }
  if (extraction.systems.length > MAX_MODULES) {
    addReason(reasons, "ANALYSIS_LIMIT_EXCEEDED", `El reporte supera el límite de ${MAX_MODULES} módulos para análisis.`);
  }
  if (extraction.dtcs.length > MAX_TOTAL_DTCS) {
    addReason(reasons, "ANALYSIS_LIMIT_EXCEEDED", `El reporte supera el límite de ${MAX_TOTAL_DTCS} DTC para análisis.`);
  }
  if (extraction.systems.some((system) => !hasRequiredText(system.name))) {
    addReason(reasons, "MODULE_DATA_INVALID", "Al menos un módulo no tiene el nombre requerido para el análisis.");
  }
  if (
    extraction.dtcs.some(
      (dtc) =>
        dtc.code.length === 0 ||
        dtc.code !== dtc.code.trim() ||
        dtc.descriptionOriginal.trim().length === 0 ||
        dtc.moduleName.trim().length === 0,
    )
  ) {
    addReason(reasons, "DTC_DATA_INVALID", "Al menos un DTC contiene datos incompatibles con el análisis.");
  }

  const assignmentCounts = extraction.dtcs.map(() => 0);
  const modules = extraction.systems.map((system) => {
    const dtcs = extraction.dtcs.flatMap((dtc, index) => {
      if (!matchesSystem(system, dtc)) return [];
      assignmentCounts[index] = (assignmentCounts[index] ?? 0) + 1;
      return [{ code: dtc.code, description: dtc.descriptionOriginal, status: dtc.status }];
    });

    if (dtcs.length > MAX_DTCS_PER_MODULE) {
      addReason(reasons, "ANALYSIS_LIMIT_EXCEEDED", `Un módulo supera el límite de ${MAX_DTCS_PER_MODULE} DTC para análisis.`);
    }
    if (dtcs.length !== system.dtcCount) {
      addReason(reasons, "EXTRACTION_DATA_INCONSISTENT", "Los DTC asociados a un módulo no coinciden con su total interpretado.");
    }

    return { code: system.code, name: system.name, dtcs };
  });

  if (assignmentCounts.some((count) => count !== 1)) {
    addReason(reasons, "DTC_MODULE_MISMATCH", "No fue posible asociar cada DTC con un único módulo interpretado.");
  }

  let validatedInput: DiagnosticAnalysisInput | null = null;
  if (make !== null && model !== null && year !== null) {
    const validation = diagnosticAnalysisInputSchema.safeParse({ vehicle: { make, model, year }, modules });
    if (validation.success) {
      const codesWerePreserved = validation.data.modules.every((module, moduleIndex) =>
        module.dtcs.every((dtc, dtcIndex) => dtc.code === modules[moduleIndex]?.dtcs[dtcIndex]?.code),
      );
      if (codesWerePreserved) validatedInput = validation.data;
      else addReason(reasons, "DTC_DATA_INVALID", "Al menos un código DTC requeriría modificación para poder analizarse.");
    } else {
      addReason(reasons, "DTC_DATA_INVALID", "Los datos extraídos no cumplen el contrato requerido para el análisis.");
    }
  }

  if (validatedInput !== null && containsSensitiveContent(validatedInput)) {
    addReason(
      reasons,
      "SENSITIVE_CONTENT_DETECTED",
      "Se encontró información potencialmente sensible y la orientación por IA no puede solicitarse.",
    );
  }

  if (reasons.length > 0 || validatedInput === null) return { available: false, reasons, warnings };
  return { available: true, input: validatedInput, reasons, warnings };
}
