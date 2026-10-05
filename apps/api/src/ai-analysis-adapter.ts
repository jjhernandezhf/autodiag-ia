import { diagnosticAnalysisInputSchema, type DiagnosticAnalysisInput } from "./ai-analysis-types.js";
import type {
  AiAnalysisAvailabilityReason,
  AiAnalysisPreparation,
  AutelExtraction,
  ParsedDtc,
  ScannedSystem,
} from "./report-types.js";
import { containsSensitiveDiagnosticReport } from "./sensitive-data.js";
import { classifyDtcStatus, normalizeForMatch } from "./text-normalization.js";

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

export function prepareAiAnalysis(extraction: AutelExtraction): AiAnalysisPreparation {
  const reasons: AiAnalysisAvailabilityReason[] = [];
  const warnings = extraction.warnings.length > 0 ? [GENERIC_EXTRACTION_WARNING] : [];
  const counts = {
    detected: extraction.dtcs.length,
    actionable: 0,
    historical: extraction.dtcs.filter((dtc) => dtc.classification === "historical").length,
  };

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
  if (extraction.systems.some((system) => !hasRequiredText(system.name))) {
    addReason(reasons, "MODULE_DATA_INVALID", "Al menos un módulo no tiene el nombre requerido para el análisis.");
  }
  if (
    extraction.dtcs.some(
      (dtc) =>
        dtc.code.length === 0 ||
        dtc.code !== dtc.code.trim() ||
        dtc.descriptionOriginal.trim().length === 0 ||
        dtc.moduleName.trim().length === 0 ||
        dtc.classification !== classifyDtcStatus(dtc.status),
    )
  ) {
    addReason(reasons, "DTC_DATA_INVALID", "Al menos un DTC contiene datos incompatibles con el análisis.");
  }
  if (extraction.dtcs.some((dtc) => dtc.classification === "unknown")) {
    addReason(reasons, "UNKNOWN_DTC_STATUS", "Al menos un DTC tiene un estado desconocido y requiere revisión manual.");
  }

  const assignmentCounts = extraction.dtcs.map(() => 0);
  const modulePreparations = extraction.systems.map((system) => {
    const moduleRows = extraction.dtcs.flatMap((dtc, index) => {
      if (!matchesSystem(system, dtc)) return [];
      assignmentCounts[index] = (assignmentCounts[index] ?? 0) + 1;
      return [dtc];
    });

    if (moduleRows.length !== system.dtcCount) {
      addReason(reasons, "EXTRACTION_DATA_INCONSISTENT", "Los DTC asociados a un módulo no coinciden con su total interpretado.");
    }

    const grouped = new Map<string, ParsedDtc[]>();
    for (const dtc of moduleRows) {
      const identity = dtc.code.toUpperCase();
      const rows = grouped.get(identity) ?? [];
      rows.push(dtc);
      grouped.set(identity, rows);
    }

    const dtcs = [...grouped.values()].flatMap((rows) => {
      const actionableRows = rows.filter((dtc) => dtc.classification === "actionable");
      if (actionableRows.length === 0) return [];

      if (new Set(rows.map((dtc) => normalizeForMatch(dtc.descriptionOriginal))).size > 1) {
        addReason(
          reasons,
          "DTC_DESCRIPTION_CONFLICT",
          "Un mismo DTC contiene descripciones contradictorias entre sus registros y requiere revisión manual.",
        );
      }
      if (new Set(actionableRows.map((dtc) => dtc.status)).size > 1) {
        addReason(
          reasons,
          "DTC_STATUS_CONFLICT",
          "Un mismo DTC contiene varios estados accionables incompatibles y requiere revisión manual.",
        );
      }

      const selected = actionableRows[0]!;
      return [{
        code: selected.code,
        description: selected.descriptionOriginal,
        status: selected.status,
        alsoHistorical: rows.some((dtc) => dtc.classification === "historical"),
      }];
    });

    counts.actionable += dtcs.length;
    if (dtcs.length > MAX_DTCS_PER_MODULE) {
      addReason(reasons, "ANALYSIS_LIMIT_EXCEEDED", `Un módulo supera el límite de ${MAX_DTCS_PER_MODULE} DTC accionables para análisis.`);
    }

    const firstActionableIndex = extraction.dtcs.findIndex(
      (dtc) => matchesSystem(system, dtc) && dtc.classification === "actionable",
    );
    return dtcs.length === 0
      ? null
      : { module: { code: system.code, name: system.name, dtcs }, firstActionableIndex };
  });
  const modules = modulePreparations
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .sort((left, right) => left.firstActionableIndex - right.firstActionableIndex)
    .map((entry) => entry.module);

  if (assignmentCounts.some((count) => count !== 1)) {
    addReason(reasons, "DTC_MODULE_MISMATCH", "No fue posible asociar cada DTC con un único módulo interpretado.");
  }
  if (counts.actionable === 0) {
    if (counts.historical > 0) {
      addReason(
        reasons,
        "ONLY_HISTORICAL_DTCS",
        "El reporte contiene únicamente antecedentes históricos y no hay DTC accionables para orientar.",
      );
    } else {
      addReason(reasons, "NO_VALID_DTCS", "El reporte no contiene DTC accionables válidos para analizar.");
    }
  }
  if (modules.length > MAX_MODULES) {
    addReason(reasons, "ANALYSIS_LIMIT_EXCEEDED", `El reporte supera el límite de ${MAX_MODULES} módulos con DTC accionables.`);
  }
  if (counts.actionable > MAX_TOTAL_DTCS) {
    addReason(reasons, "ANALYSIS_LIMIT_EXCEEDED", `El reporte supera el límite de ${MAX_TOTAL_DTCS} DTC accionables para análisis.`);
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

  if (validatedInput !== null && containsSensitiveDiagnosticReport(validatedInput)) {
    addReason(
      reasons,
      "SENSITIVE_CONTENT_DETECTED",
      "Se encontró información potencialmente sensible y la orientación por IA no puede solicitarse.",
    );
  }

  if (reasons.length > 0 || validatedInput === null) return { available: false, reasons, warnings, counts };
  return { available: true, input: validatedInput, reasons, warnings, counts };
}
