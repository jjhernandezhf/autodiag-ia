import { describe, expect, it } from "vitest";

import { prepareAiAnalysis } from "./ai-analysis-adapter.js";
import type { AutelExtraction, ParsedDtc, ScannedSystem } from "./report-types.js";
import { classifyDtcStatus } from "./text-normalization.js";

function createExtraction(): AutelExtraction {
  return {
    status: "completed",
    format: "autel_vehicle_diagnostic_report",
    requiresManualReview: false,
    vehicle: {
      year: 2024,
      make: "Marca Sintética",
      model: "Modelo Académico",
      engine: "Motor que no debe enviarse",
      odometer: { value: 12345, unit: "km" },
      vinMasked: "*************6789",
      vinPseudonym: "vin_v1_synthetic-pseudonym",
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
    warnings: [],
  };
}

function createDtc(
  code: string,
  moduleCode: string | null,
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
    statusOriginal: "Estado original",
    classification: classifyDtcStatus(status),
  };
}

function createToyotaDuplicateExtraction(): AutelExtraction {
  const airbagCodes = [
    "B1613", "B1801", "B1811", "B1831", "B1836", "B1861",
    "B1901", "B1906", "B1921", "B1926", "B1941",
  ];
  const systems: ScannedSystem[] = [
    { code: null, name: "Airbag SRS", dtcCount: 22 },
    { code: null, name: "Carrocería principal", dtcCount: 2 },
    { code: null, name: "Aire acondicionado", dtcCount: 2 },
    { code: null, name: "Sistema telemático", dtcCount: 1 },
    ...Array.from({ length: 32 }, (_, index) => ({ code: `M${index}`, name: `Módulo sin DTC ${index}`, dtcCount: 0 })),
  ];
  const airbagRows = ["current", "history"].flatMap((status) =>
    airbagCodes.map((code) => createDtc(code, null, "Airbag SRS", `Descripción ${code}`, status as "current" | "history")),
  );
  const dtcs = [
    ...airbagRows,
    createDtc("U1117", null, "Carrocería principal", "Descripción U1117", "current"),
    createDtc("U1117", null, "Carrocería principal", "Descripción U1117", "history"),
    createDtc("B1442", null, "Aire acondicionado", "Descripción B1442", "current"),
    createDtc("B1442", null, "Aire acondicionado", "Descripción B1442", "history"),
    createDtc("B15C464", null, "Sistema telemático", "Descripción B15C464", "confirmed"),
  ];

  return {
    ...createExtraction(),
    systems,
    dtcs,
    scanSummary: { declaredSystems: 36, parsedSystems: 36, declaredDtcs: 27, parsedDtcs: 27 },
  };
}

describe("prepareAiAnalysis", () => {
  it("convierte la extracción conservando el orden técnico de módulos, DTC y códigos", () => {
    const result = prepareAiAnalysis(createExtraction());

    expect(result.available).toBe(true);
    if (!result.available) throw new Error("La preparación debía estar disponible.");
    expect(result.input).toEqual({
      vehicle: { make: "Marca Sintética", model: "Modelo Académico", year: 2024 },
      modules: [
        {
          code: "PCM",
          name: "Módulo motriz",
          dtcs: [
            { code: "P0300", description: "Fallo de encendido sintético", status: "current", alsoHistorical: false },
            { code: "P0171", description: "Mezcla pobre sintética", status: "pending", alsoHistorical: false },
          ],
        },
        {
          code: "BCM",
          name: "Módulo de carrocería",
          dtcs: [{ code: "B1000", description: "Señal de prueba", status: "stored", alsoHistorical: false }],
        },
      ],
    });
  });

  it("excluye datos sensibles, metadatos del archivo y propiedades desconocidas", () => {
    const extraction = Object.assign(createExtraction(), {
      id: "report-id-that-must-not-be-sent",
      originalName: "cliente-autel.pdf",
      sha256: "a".repeat(64),
      pdf: "%PDF-sensitive",
      customer: { name: "Persona Sintética" },
    });
    const result = prepareAiAnalysis(extraction);

    expect(result.available).toBe(true);
    if (!result.available) throw new Error("La preparación debía estar disponible.");
    expect(Object.keys(result.input)).toEqual(["vehicle", "modules"]);
    expect(Object.keys(result.input.vehicle)).toEqual(["make", "model", "year"]);
    expect(Object.keys(result.input.modules[0] ?? {})).toEqual(["code", "name", "dtcs"]);
    expect(Object.keys(result.input.modules[0]?.dtcs[0] ?? {})).toEqual([
      "code",
      "description",
      "status",
      "alsoHistorical",
    ]);

    const serialized = JSON.stringify(result.input);
    for (const forbidden of ["vin", "odometer", "engine", "originalName", "sha256", "pdf", "customer", "report-id"]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it.each([
    ["marca", (extraction: AutelExtraction, vin: string) => { extraction.vehicle.make = `Marca ${vin}`; }],
    ["modelo", (extraction: AutelExtraction, vin: string) => { extraction.vehicle.model = `${vin} Edición`; }],
    ["código de módulo", (extraction: AutelExtraction, vin: string) => {
      extraction.systems[0]!.code = vin;
      extraction.dtcs[0]!.moduleCode = vin;
      extraction.dtcs[1]!.moduleCode = vin;
    }],
    ["nombre de módulo", (extraction: AutelExtraction, vin: string) => {
      extraction.systems[0]!.name = `Módulo ${vin}`;
      extraction.dtcs[0]!.moduleName = `Módulo ${vin}`;
      extraction.dtcs[1]!.moduleName = `Módulo ${vin}`;
    }],
    ["código DTC", (extraction: AutelExtraction, vin: string) => { extraction.dtcs[0]!.code = vin; }],
    ["descripción DTC", (extraction: AutelExtraction, vin: string) => {
      extraction.dtcs[0]!.descriptionOriginal = `Referencia ${vin} detectada`;
    }],
  ])("bloquea un VIN sintético incrustado en %s sin exponerlo", (_field, mutate) => {
    const syntheticVin = "1HGCM82633A004352";
    const extraction = createExtraction();
    mutate(extraction, syntheticVin);

    const result = prepareAiAnalysis(extraction);

    expect(result.available).toBe(false);
    expect(result).not.toHaveProperty("input");
    expect(result.reasons).toContainEqual(expect.objectContaining({ code: "SENSITIVE_CONTENT_DETECTED" }));
    expect(JSON.stringify(result)).not.toContain(syntheticVin);
  });

  it("mantiene disponibles los textos técnicos normales sin candidatos VIN", () => {
    const result = prepareAiAnalysis(createExtraction());

    expect(result.available).toBe(true);
  });

  it.each([
    "1HGCM82633A0043527",
    "1HGCM82633A00O352",
    "X1HGCM82633A004352Y",
  ])("no confunde con VIN una secuencia que incumple longitud, caracteres o límites: %s", (technicalText) => {
    const extraction = createExtraction();
    extraction.vehicle.make = `Referencia técnica ${technicalText}`;

    expect(prepareAiAnalysis(extraction).available).toBe(true);
  });

  it("deshabilita el análisis cuando la extracción es parcial o requiere revisión", () => {
    const extraction = createExtraction();
    extraction.status = "partial";
    extraction.requiresManualReview = true;
    extraction.scanSummary.declaredDtcs = 4;

    const result = prepareAiAnalysis(extraction);

    expect(result.available).toBe(false);
    expect(result).not.toHaveProperty("input");
    expect(result.reasons.map((reason) => reason.code)).toEqual(
      expect.arrayContaining(["EXTRACTION_INCOMPLETE", "MANUAL_REVIEW_REQUIRED", "DTC_TOTAL_MISMATCH"]),
    );
  });

  it("devuelve razones controladas cuando faltan datos obligatorios o no existen DTC", () => {
    const extraction = createExtraction();
    extraction.vehicle.make = null;
    extraction.dtcs = [];
    extraction.systems = [{ code: "PCM", name: "Módulo motriz", dtcCount: 0 }];
    extraction.scanSummary = { declaredSystems: 1, parsedSystems: 1, declaredDtcs: 0, parsedDtcs: 0 };

    const result = prepareAiAnalysis(extraction);

    expect(result.available).toBe(false);
    expect(result.reasons.map((reason) => reason.code)).toEqual(
      expect.arrayContaining(["VEHICLE_DATA_MISSING", "NO_VALID_DTCS"]),
    );
  });

  it("rechaza límites excedidos sin truncar módulos ni DTC silenciosamente", () => {
    const extraction = createExtraction();
    const systems: ScannedSystem[] = Array.from({ length: 41 }, (_, index) => ({
      code: `M${index}`,
      name: `Módulo ${index}`,
      dtcCount: index === 0 ? 21 : 0,
    }));
    const dtcs = Array.from({ length: 21 }, (_, index) =>
      createDtc(`P${String(index).padStart(4, "0")}`, "M0", "Módulo 0", `Descripción ${index}`, "current"),
    );
    extraction.systems = systems;
    extraction.dtcs = dtcs;
    extraction.scanSummary = { declaredSystems: 41, parsedSystems: 41, declaredDtcs: 21, parsedDtcs: 21 };

    const result = prepareAiAnalysis(extraction);

    expect(result.available).toBe(false);
    expect(result).not.toHaveProperty("input");
    expect(result.reasons).toContainEqual(expect.objectContaining({ code: "ANALYSIS_LIMIT_EXCEEDED" }));
  });

  it("agrupa 27 filas Toyota en 14 DTC accionables y conserva 13 antecedentes históricos", () => {
    const result = prepareAiAnalysis(createToyotaDuplicateExtraction());

    expect(result.available).toBe(true);
    expect(result.counts).toEqual({ detected: 27, actionable: 14, historical: 13 });
    if (!result.available) throw new Error("La preparación Toyota debía estar disponible.");
    expect(result.input.modules[0]?.dtcs).toHaveLength(11);
    expect(result.input.modules[0]?.dtcs.every((dtc) => dtc.alsoHistorical)).toBe(true);
    expect(result.input.modules.flatMap((module) => module.dtcs)).toHaveLength(14);
    expect(result.input.modules.flatMap((module) => module.dtcs).filter((dtc) => dtc.code === "B1613")).toHaveLength(1);
  });

  it("conserva un histórico único como antecedente sin enviarlo al análisis", () => {
    const extraction = createExtraction();
    extraction.systems[0]!.dtcCount = 3;
    extraction.systems[1]!.dtcCount = 1;
    extraction.dtcs.push(createDtc("P0999", "PCM", "Módulo motriz", "Antecedente", "history"));
    extraction.scanSummary.declaredDtcs = 4;
    extraction.scanSummary.parsedDtcs = 4;

    const result = prepareAiAnalysis(extraction);

    expect(result.available).toBe(true);
    expect(result.counts).toEqual({ detected: 4, actionable: 3, historical: 1 });
    if (!result.available) throw new Error("La preparación mixta debía estar disponible.");
    expect(result.input.modules.flatMap((module) => module.dtcs).some((dtc) => dtc.code === "P0999")).toBe(false);
  });

  it("no prepara un reporte compuesto únicamente por antecedentes históricos", () => {
    const extraction = createExtraction();
    extraction.systems = [{ code: "PCM", name: "Módulo motriz", dtcCount: 1 }];
    extraction.dtcs = [createDtc("P0300", "PCM", "Módulo motriz", "Antecedente", "history")];
    extraction.scanSummary = { declaredSystems: 1, parsedSystems: 1, declaredDtcs: 1, parsedDtcs: 1 };

    const result = prepareAiAnalysis(extraction);

    expect(result.available).toBe(false);
    expect(result.counts).toEqual({ detected: 1, actionable: 0, historical: 1 });
    expect(result.reasons).toContainEqual(expect.objectContaining({ code: "ONLY_HISTORICAL_DTCS" }));
  });

  it("requiere revisión si las descripciones actual e histórica se contradicen", () => {
    const extraction = createExtraction();
    extraction.systems = [{ code: "PCM", name: "Módulo motriz", dtcCount: 2 }];
    extraction.dtcs = [
      createDtc("P0300", "PCM", "Módulo motriz", "Descripción actual", "current"),
      createDtc("P0300", "PCM", "Módulo motriz", "Descripción histórica distinta", "history"),
    ];
    extraction.scanSummary = { declaredSystems: 1, parsedSystems: 1, declaredDtcs: 2, parsedDtcs: 2 };

    const result = prepareAiAnalysis(extraction);

    expect(result.available).toBe(false);
    expect(result.reasons).toContainEqual(expect.objectContaining({ code: "DTC_DESCRIPTION_CONFLICT" }));
  });

  it("acepta estados confirmed, permanente e intermitente y rechaza uno desconocido con razón precisa", () => {
    const extraction = createExtraction();
    extraction.systems = [{ code: "PCM", name: "Módulo motriz", dtcCount: 3 }];
    extraction.dtcs = [
      createDtc("P0001", "PCM", "Módulo motriz", "Confirmado", "confirmed"),
      createDtc("P0002", "PCM", "Módulo motriz", "Permanente", "permanent"),
      createDtc("P0003", "PCM", "Módulo motriz", "Intermitente", "intermittent"),
    ];
    extraction.scanSummary = { declaredSystems: 1, parsedSystems: 1, declaredDtcs: 3, parsedDtcs: 3 };

    expect(prepareAiAnalysis(extraction)).toMatchObject({ available: true, counts: { actionable: 3 } });

    extraction.dtcs[2] = createDtc("P0003", "PCM", "Módulo motriz", "Desconocido", "unknown");
    const unknown = prepareAiAnalysis(extraction);
    expect(unknown.available).toBe(false);
    expect(unknown.reasons).toContainEqual(expect.objectContaining({ code: "UNKNOWN_DTC_STATUS" }));
  });
});
