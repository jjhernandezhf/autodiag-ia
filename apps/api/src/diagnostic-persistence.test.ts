import { describe, expect, it, vi } from "vitest";

import { buildDiagnosticPersistenceRecord } from "./diagnostic-persistence.js";
import type { DiagnosticAnalysisOutput } from "./ai-analysis-types.js";
import type { AutelExtraction, ParsedDtc } from "./report-types.js";
import { classifyDtcStatus } from "./text-normalization.js";

interface CompletedAnalysis {
  status: "completed";
  analysis: DiagnosticAnalysisOutput;
}

function createDtc(
  code: string,
  moduleCode: string,
  moduleName: string,
  descriptionOriginal: string,
  status: ParsedDtc["status"],
): ParsedDtc {
  return {
    code,
    moduleCode,
    moduleName,
    descriptionOriginal,
    status,
    statusOriginal: "estado documental",
    classification: classifyDtcStatus(status),
  };
}

function createExtraction(): AutelExtraction {
  return {
    status: "completed",
    format: "autel_vehicle_diagnostic_report",
    requiresManualReview: false,
    vehicle: {
      year: 2024,
      make: "Marca sintética",
      model: "Modelo académico",
      engine: "dato de motor excluido",
      odometer: { value: 12_345, unit: "km" },
      vinMasked: "*************4352",
      vinPseudonym: "vin_v1_valor_excluido",
    },
    scanSummary: { declaredSystems: 2, parsedSystems: 2, declaredDtcs: 3, parsedDtcs: 3 },
    systems: [
      { code: "PCM", name: "Módulo motriz", dtcCount: 2 },
      { code: "BCM", name: "Módulo de carrocería", dtcCount: 1 },
    ],
    dtcs: [
      createDtc("P0300", "PCM", "Módulo motriz", "Fallo de encendido sintético", "current"),
      createDtc("P0171", "PCM", "Módulo motriz", "Mezcla pobre sintética", "pending"),
      createDtc("B1000", "BCM", "Módulo de carrocería", "Señal de prueba", "stored"),
    ],
    warnings: [{ code: "ENGINE_MISSING", message: "advertencia documental excluida" }],
  };
}

function createCompletedAnalysis(): CompletedAnalysis {
  return {
    status: "completed",
    analysis: {
      technicalSummary: "Resumen técnico sintético",
      findings: [
        {
          relatedDtc: { code: "P0300", moduleCode: "PCM", moduleName: "Módulo motriz" },
          priority: "high",
          simpleExplanation: "Explicación del primer hallazgo",
          possibleCauses: ["Primera causa", "Segunda causa"],
          recommendedChecks: ["Primera comprobación", "Segunda comprobación"],
          safetyWarnings: ["Primera advertencia"],
          confidence: "high",
        },
        {
          relatedDtc: { code: "B1000", moduleCode: "BCM", moduleName: "Módulo de carrocería" },
          priority: "low",
          simpleExplanation: "Explicación del segundo hallazgo",
          possibleCauses: ["Tercera causa"],
          recommendedChecks: ["Tercera comprobación"],
          safetyWarnings: ["Segunda advertencia", "Tercera advertencia"],
          confidence: "medium",
        },
      ],
      safetyWarnings: ["Advertencia general uno", "Advertencia general dos"],
      confidence: "medium",
      requiresTechnicianConfirmation: true,
    },
  };
}

function getRecord(extraction = createExtraction(), analysis = createCompletedAnalysis()) {
  const result = buildDiagnosticPersistenceRecord(extraction, analysis);
  expect(result.persistable).toBe(true);
  if (!result.persistable) throw new Error(`Registro inesperadamente no persistible: ${result.code}`);
  return result.record;
}

function repeatToLength(prefix: string, length: number) {
  return `${prefix}${"o".repeat(length)}`.slice(0, length);
}

function createMaximumExtraction(): AutelExtraction {
  const systems = Array.from({ length: 40 }, (_, moduleIndex) => ({
    code: repeatToLength(`M-${moduleIndex}-`, 32),
    name: repeatToLength(`Módulo ${moduleIndex} `, 160),
    dtcCount: moduleIndex < 5 ? 20 : 0,
  }));
  const dtcs = systems.flatMap((system, moduleIndex) =>
    Array.from({ length: system.dtcCount }, (_, dtcIndex) =>
      createDtc(
        repeatToLength(`D-${moduleIndex}-${dtcIndex}-`, 32),
        system.code,
        system.name,
        repeatToLength(`Descripción ${moduleIndex}-${dtcIndex} `, 1_000),
        "current",
      ),
    ),
  );

  return {
    ...createExtraction(),
    vehicle: {
      ...createExtraction().vehicle,
      make: "o".repeat(80),
      model: "o".repeat(120),
    },
    scanSummary: { declaredSystems: 40, parsedSystems: 40, declaredDtcs: 100, parsedDtcs: 100 },
    systems,
    dtcs,
  };
}

function createMaximumAnalysis(): CompletedAnalysis {
  const text500 = "o".repeat(500);
  return {
    status: "completed",
    analysis: {
      technicalSummary: "o".repeat(1_500),
      findings: Array.from({ length: 20 }, () => ({
        relatedDtc: null,
        priority: "critical" as const,
        simpleExplanation: "o".repeat(1_000),
        possibleCauses: Array.from({ length: 8 }, () => text500),
        recommendedChecks: Array.from({ length: 10 }, () => text500),
        safetyWarnings: Array.from({ length: 8 }, () => text500),
        confidence: "low" as const,
      })),
      safetyWarnings: Array.from({ length: 10 }, () => text500),
      confidence: "low",
      requiresTechnicianConfirmation: true,
    },
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

describe("buildDiagnosticPersistenceRecord", () => {
  it("construye exclusivamente el registro normalizado y conserva asociaciones y orden", () => {
    const record = getRecord();

    expect(record.report).toEqual({
      make: "Marca sintética",
      model: "Modelo académico",
      year: 2024,
      extractionStatus: "completed",
      analysisStatus: "completed",
    });
    expect(record.modules.map(({ code, position }) => ({ code, position }))).toEqual([
      { code: "PCM", position: 0 },
      { code: "BCM", position: 1 },
    ]);
    expect(record.modules[0]?.dtcs.map(({ code, position }) => ({ code, position }))).toEqual([
      { code: "P0300", position: 0 },
      { code: "P0171", position: 1 },
    ]);
    expect(record.modules[1]?.dtcs.map(({ code, position }) => ({ code, position }))).toEqual([
      { code: "B1000", position: 2 },
    ]);
    expect(record.analysis.findings.map(({ relatedDtc, position }) => ({ relatedDtc, position }))).toEqual([
      { relatedDtc: { code: "P0300", modulePosition: 0, dtcPosition: 0 }, position: 0 },
      { relatedDtc: { code: "B1000", modulePosition: 1, dtcPosition: 2 }, position: 1 },
    ]);
    expect(record.analysis.findings[0]?.possibleCauses).toEqual([
      { value: "Primera causa", position: 0 },
      { value: "Segunda causa", position: 1 },
    ]);
    expect(record.analysis.findings[0]?.recommendedChecks).toEqual([
      { value: "Primera comprobación", position: 0 },
      { value: "Segunda comprobación", position: 1 },
    ]);
    expect(record.analysis.findings[1]?.safetyWarnings).toEqual([
      { value: "Segunda advertencia", position: 0 },
      { value: "Tercera advertencia", position: 1 },
    ]);
    expect(record.analysis.safetyWarnings).toEqual([
      { value: "Advertencia general uno", position: 0 },
      { value: "Advertencia general dos", position: 1 },
    ]);
  });

  it("excluye todos los datos sensibles, metadatos y propiedades ajenas a la migración", () => {
    const serialized = JSON.stringify(getRecord());

    for (const forbidden of [
      "vin",
      "vin_v1",
      "4352",
      "odometer",
      "12345",
      "engine",
      "motor excluido",
      "pdf",
      "originalName",
      "sha256",
      "customer",
      "apiKey",
      "prompt",
      "provider",
      "advertencia documental excluida",
    ]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    expect(getRecord().modules[0]?.dtcs[0]).toMatchObject({
      status: "current",
      statusOriginal: "estado documental",
      classification: "actionable",
    });
  });

  it("conserva todas las filas actuales e históricas en orden sin duplicar hallazgos", () => {
    const extraction = createExtraction();
    extraction.systems[0]!.dtcCount = 3;
    extraction.dtcs.splice(
      2,
      0,
      createDtc("P0300", "PCM", "Módulo motriz", "Fallo de encendido sintético", "history"),
    );
    extraction.scanSummary.declaredDtcs = 4;
    extraction.scanSummary.parsedDtcs = 4;

    const record = getRecord(extraction, createCompletedAnalysis());

    expect(record.modules[0]?.dtcs.map(({ code, status, classification, position }) => ({
      code,
      status,
      classification,
      position,
    }))).toEqual([
      { code: "P0300", status: "current", classification: "actionable", position: 0 },
      { code: "P0171", status: "pending", classification: "actionable", position: 1 },
      { code: "P0300", status: "history", classification: "historical", position: 2 },
    ]);
    expect(record.analysis.findings.filter((finding) => finding.relatedDtc?.code === "P0300")).toHaveLength(1);
    expect(record.analysis.findings[0]?.relatedDtc).toEqual({ code: "P0300", modulePosition: 0, dtcPosition: 0 });
    expect(record.modules.flatMap((module) => module.dtcs).map((dtc) => dtc.position).sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  });

  it("rechaza extracciones parciales o que requieren revisión manual", () => {
    const partial = createExtraction();
    partial.status = "partial";
    expect(buildDiagnosticPersistenceRecord(partial, createCompletedAnalysis())).toMatchObject({
      persistable: false,
      code: "EXTRACTION_INCOMPLETE",
    });

    const manual = createExtraction();
    manual.requiresManualReview = true;
    expect(buildDiagnosticPersistenceRecord(manual, createCompletedAnalysis())).toMatchObject({
      persistable: false,
      code: "EXTRACTION_INCOMPLETE",
    });
  });

  it("rechaza orientaciones no completadas, inválidas y con propiedades inesperadas", () => {
    expect(buildDiagnosticPersistenceRecord(createExtraction(), { status: "error" })).toMatchObject({
      persistable: false,
      code: "ANALYSIS_NOT_COMPLETED",
    });

    const invalidConfirmation = createCompletedAnalysis() as unknown as Record<string, unknown>;
    (invalidConfirmation.analysis as Record<string, unknown>).requiresTechnicianConfirmation = false;
    expect(buildDiagnosticPersistenceRecord(createExtraction(), invalidConfirmation)).toMatchObject({
      persistable: false,
      code: "ANALYSIS_INVALID",
    });

    const unexpected = createCompletedAnalysis() as unknown as Record<string, unknown>;
    (unexpected.analysis as Record<string, unknown>).rawProviderResponse = "dato no permitido";
    expect(buildDiagnosticPersistenceRecord(createExtraction(), unexpected)).toMatchObject({
      persistable: false,
      code: "ANALYSIS_INVALID",
    });
  });

  it("rechaza propiedades inesperadas en cualquier extracción", () => {
    const extraction = createExtraction() as AutelExtraction & { originalName?: string };
    extraction.originalName = "archivo-privado.pdf";

    expect(buildDiagnosticPersistenceRecord(extraction, createCompletedAnalysis())).toMatchObject({
      persistable: false,
      code: "EXTRACTION_INVALID",
    });
  });

  it("rechaza referencias inexistentes o hallazgos duplicados para el mismo DTC", () => {
    const missing = createCompletedAnalysis();
    missing.analysis.findings[0]!.relatedDtc = {
      code: "U9999",
      moduleCode: "PCM",
      moduleName: "Módulo motriz",
    };
    expect(buildDiagnosticPersistenceRecord(createExtraction(), missing)).toMatchObject({
      persistable: false,
      code: "DTC_REFERENCE_INVALID",
    });

    const duplicated = createCompletedAnalysis();
    duplicated.analysis.findings.push(structuredClone(duplicated.analysis.findings[0]!));
    expect(buildDiagnosticPersistenceRecord(createExtraction(), duplicated)).toMatchObject({
      persistable: false,
      code: "DTC_REFERENCE_INVALID",
    });
  });

  it.each([
    ["marca", (extraction: AutelExtraction, analysis: CompletedAnalysis, vin: string) => { extraction.vehicle.make = `Marca ${vin}`; }],
    ["modelo", (extraction: AutelExtraction, analysis: CompletedAnalysis, vin: string) => { extraction.vehicle.model = `Modelo ${vin}`; }],
    ["código de módulo", (extraction: AutelExtraction, analysis: CompletedAnalysis, vin: string) => {
      extraction.systems[0]!.code = vin;
      extraction.dtcs[0]!.moduleCode = vin;
      extraction.dtcs[1]!.moduleCode = vin;
    }],
    ["nombre de módulo", (extraction: AutelExtraction, analysis: CompletedAnalysis, vin: string) => {
      extraction.systems[0]!.name = `Módulo ${vin}`;
      extraction.dtcs[0]!.moduleName = `Módulo ${vin}`;
      extraction.dtcs[1]!.moduleName = `Módulo ${vin}`;
    }],
    ["código DTC", (extraction: AutelExtraction, analysis: CompletedAnalysis, vin: string) => {
      extraction.dtcs[0]!.code = vin;
      analysis.analysis.findings[0]!.relatedDtc!.code = vin;
    }],
    ["descripción DTC", (extraction: AutelExtraction, analysis: CompletedAnalysis, vin: string) => {
      extraction.dtcs[0]!.descriptionOriginal = `Descripción ${vin}`;
    }],
    ["resumen", (extraction: AutelExtraction, analysis: CompletedAnalysis, vin: string) => { analysis.analysis.technicalSummary = `Resumen ${vin}`; }],
    ["explicación", (extraction: AutelExtraction, analysis: CompletedAnalysis, vin: string) => { analysis.analysis.findings[0]!.simpleExplanation = `Explicación ${vin}`; }],
    ["causa", (extraction: AutelExtraction, analysis: CompletedAnalysis, vin: string) => { analysis.analysis.findings[0]!.possibleCauses[0] = `Causa ${vin}`; }],
    ["comprobación", (extraction: AutelExtraction, analysis: CompletedAnalysis, vin: string) => { analysis.analysis.findings[0]!.recommendedChecks[0] = `Comprobar ${vin}`; }],
    ["advertencia de hallazgo", (extraction: AutelExtraction, analysis: CompletedAnalysis, vin: string) => { analysis.analysis.findings[0]!.safetyWarnings[0] = `Advertencia ${vin}`; }],
    ["advertencia general", (extraction: AutelExtraction, analysis: CompletedAnalysis, vin: string) => { analysis.analysis.safetyWarnings[0] = `Advertencia ${vin}`; }],
  ])("bloquea un VIN sintético incrustado en %s sin devolverlo", (_field, mutate) => {
    const syntheticVin = "1HGCM82633A004352";
    const extraction = createExtraction();
    const analysis = createCompletedAnalysis();
    mutate(extraction, analysis, syntheticVin);

    const result = buildDiagnosticPersistenceRecord(extraction, analysis);

    expect(result).toMatchObject({ persistable: false, code: "SENSITIVE_CONTENT_DETECTED" });
    expect(JSON.stringify(result)).not.toContain(syntheticVin);
  });

  it.each(["vin_v1_aabbccddeeff0011", "*************4352"])(
    "bloquea un identificador de VIN protegido incrustado en texto permitido: %s",
    (protectedVin) => {
      const analysis = createCompletedAnalysis();
      analysis.analysis.technicalSummary = `Referencia ${protectedVin}`;

      const result = buildDiagnosticPersistenceRecord(createExtraction(), analysis);

      expect(result).toMatchObject({ persistable: false, code: "SENSITIVE_CONTENT_DETECTED" });
      expect(JSON.stringify(result)).not.toContain(protectedVin);
    },
  );

  it("acepta exactamente los límites máximos vigentes sin truncamiento", () => {
    const record = getRecord(createMaximumExtraction(), createMaximumAnalysis());

    expect(record.modules).toHaveLength(40);
    expect(record.modules.flatMap((module) => module.dtcs)).toHaveLength(100);
    expect(record.modules[0]?.dtcs).toHaveLength(20);
    expect(record.report.make).toHaveLength(80);
    expect(record.report.model).toHaveLength(120);
    expect(record.modules[0]?.code).toHaveLength(32);
    expect(record.modules[0]?.name).toHaveLength(160);
    expect(record.modules[0]?.dtcs[0]?.description).toHaveLength(1_000);
    expect(record.analysis.technicalSummary).toHaveLength(1_500);
    expect(record.analysis.findings).toHaveLength(20);
    expect(record.analysis.findings[0]?.possibleCauses).toHaveLength(8);
    expect(record.analysis.findings[0]?.recommendedChecks).toHaveLength(10);
    expect(record.analysis.findings[0]?.safetyWarnings).toHaveLength(8);
    expect(record.analysis.safetyWarnings).toHaveLength(10);
  });

  it("no muta las entradas y no realiza conexiones de red", () => {
    const extraction = deepFreeze(createExtraction());
    const analysis = deepFreeze(createCompletedAnalysis());
    const extractionBefore = structuredClone(extraction);
    const analysisBefore = structuredClone(analysis);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    try {
      expect(buildDiagnosticPersistenceRecord(extraction, analysis).persistable).toBe(true);
      expect(extraction).toEqual(extractionBefore);
      expect(analysis).toEqual(analysisBefore);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
