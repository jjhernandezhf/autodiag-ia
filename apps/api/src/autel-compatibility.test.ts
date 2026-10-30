import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import request from "supertest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { parseAutelReport } from "./autel-parser.js";
import { prepareAiAnalysis } from "./ai-analysis-adapter.js";
import { createApp } from "./app.js";
import { confirmVehicleData } from "./vehicle-confirmation.js";
import { buildHistoryInsertRecord, historyExtractionInputSchema, historyPublicSnapshotSchema, type HistorySaveInput } from "./diagnostic-history.js";
import { DiagnosticAnalysisService, DIAGNOSTIC_PROMPT_VERSION, OpenAiResponsesClient } from "./ai-analysis-service.js";
import { createAnalysisFingerprint } from "./analysis-fingerprint.js";
import { normalizeDtcStatus } from "./text-normalization.js";
import type { AutelExtraction, ExtractedPdfPage, ExtractedTextLine } from "./report-types.js";
import type { DiagnosticAnalysisInput } from "./ai-analysis-types.js";

// Structural regression fixtures only. No original PDF, identifier or private field.
const secret = "synthetic-compatibility-only-secret-32-bytes";
function line(text: string, y: number, x = 20): ExtractedTextLine {
  return { text, y, fragments: [{ text, x, width: 100 }] };
}
function columns(code: string, description: string, status: string, y: number): ExtractedTextLine {
  return { text: [code, description, status].filter(Boolean).join(" "), y, fragments: [
    { text: code, x: 20, width: 75 }, { text: description, x: 105, width: 300 }, { text: status, x: 430, width: 130 },
  ].filter(f => f.text !== "") };
}
const header = (y = 780) => columns("DTC", "Descripción", "Estado", y);
const activeHistoryFixture: AutelExtraction = JSON.parse(readFileSync(new URL("../../../shared/fixtures/autel-active-history.synthetic.json", import.meta.url), "utf8"));
function activeHistoryPages(): ExtractedPdfPage[] {
  const e = activeHistoryFixture;
  return [{ pageNumber: 1, lines: [
    line("Informe de diagnostico de vehiculo", 820), line("Informacion del vehiculo", 800),
    line(`${e.vehicle.year} / ${e.vehicle.make} / ${e.vehicle.model} / ${e.vehicle.engine}`, 780),
    line("Lectura del odometro: 0", 760), line("Sistema/s escaneado/s (15)", 740), line("Sistema Estado/DTC", 720),
    ...e.systems.map((s, i) => line(`${s.code}(${s.name}) ${s.dtcCount}`, 700 - i * 20)),
    line("DTC (6)", 380), line("ENG(Motor sintetico) (2 DTC)", 360), header(340),
    columns("P0014", e.dtcs[0]!.descriptionOriginal, "Activo", 320),
  ] }, { pageNumber: 2, lines: [
    header(800), columns("P0078", e.dtcs[1]!.descriptionOriginal, "Activo", 780),
    line("AB(Seguridad sintetica) (3 DTC)", 750), header(730),
    ...e.dtcs.slice(2, 5).map((d, i) => columns(d.code, d.descriptionOriginal, d.statusOriginal!, 710 - i * 20)),
    line("ODS(Deteccion sintetica) (1 DTC)", 630), header(610),
    columns("B1319", e.dtcs[5]!.descriptionOriginal, "Historial", 590),
  ] }];
}
function mazdaPages(route = "Other/Mazda/AXELA / MAZDA3/"): ExtractedPdfPage[] {
  const codes = ["B10A6:FF", "B1231:FF", "B1877:FF", "B1932:FF", "B2227:FF", "B2232:FF"];
  return [{ pageNumber: 1, lines: [
    line("Informe de diagnostico de vehiculo", 800), line("Informacion del vehiculo", 780), line(route, 760),
    line("Sistema/s escaneado/s (13)", 730), line("Sistema Estado/DTC", 710),
    line("PCM(Control motriz) 1", 690), line("RCM(Seguridad pasiva) 6", 670),
    ...Array.from({ length: 11 }, (_, i) => line(`Z${i}(Modulo sintetico ${i}) 0`, 650 - i * 20)),
    line("DTC (7)", 350), line("PCM(Control motriz) (1 DTC)", 330), header(320),
    line("Primera descripcion sintetica", 309, 105), columns("P013B:00", "", "ODDTCs", 300),
    line("continuacion del PCM", 291, 105), line("RCM(Seguridad pasiva) (6 DTC)", 60), header(40),
  ] }, { pageNumber: 2, lines: codes.flatMap((code, i) => {
    const y = 740 - i * 50;
    return i % 2 === 0 ? [line(`Descripcion sintetica ${i}`, y + 9, 105), columns(code, "", "CMDTCs", y),
      line(`continuacion ${i}`, y - 9, 105)] : [columns(code, `Descripcion sintetica ${i}`, "CMDTCs", y)];
  }) }];
}
function hondaPages(): ExtractedPdfPage[] {
  const groups = [
    { name: "ABS/VSA", codes: ["C0031-14"] },
    { name: "SRS", codes: Array.from({ length: 22 }, (_, i) => `B${String(i + 1).padStart(4, "0")}-13`) },
    { name: "Sensor de aparcamiento", codes: ["C0051-96", "U0416-68", "U0416-F8", "U0418-92"] },
    { name: "EPS", codes: ["U0416-68", "U1483-68"] },
    { name: "Asistencia al conductor", codes: ["C0051-54", "U0420-68", "U0415-68", "U0416-68", "C0031-62"] },
    { name: "AWD", codes: ["C1872-00"] },
  ];
  return [{ pageNumber: 1, lines: [line("Informe de diagnostico de vehiculo", 800), line("Informacion del vehiculo", 780),
    line("2023/Honda/HR-V/", 760), line("Sistema/s escaneado/s (16)", 740), line("Sistema Estado/DTC", 720),
    ...groups.map(g => line(`${g.name} ${g.codes.length}`, 700)),
    ...Array.from({ length: 10 }, (_, i) => line(`Z${i}(Modulo sintetico ${i}) 0`, 650 - i * 20)), line("DTC (35)", 400),
  ] }, ...groups.map((g, groupIndex) => ({ pageNumber: groupIndex + 2, lines: [
    line(`${g.name} (${g.codes.length} DTC)`, 800), header(), ...g.codes.flatMap((code, i) => [
      line(`Inicio sintetico ${i}`, 749 - i * 30, 105), columns(code, "", "DTC permanente", 740 - i * 30),
      line(`fin sintetico ${i}`, 731 - i * 30, 105),
    ]),
  ] }))];
}
function output(input: DiagnosticAnalysisInput) {
  return { technicalSummary: "Resumen sintetico no diagnostico", findings: input.modules.flatMap(m => m.dtcs.map(d => ({
    relatedDtc: { code: d.code, moduleCode: m.code, moduleName: m.name }, priority: "medium" as const,
    simpleExplanation: "Comprobar condicion documentada.", possibleCauses: ["Condicion por verificar"],
    recommendedChecks: ["Consultar documentacion tecnica"], safetyWarnings: ["Revision profesional necesaria"], confidence: "low" as const,
  }))), observationCorrelation: { status: "not_provided" as const, summary: "Sin observaciones", matches: [] },
  safetyWarnings: ["No confirma averias"], confidence: "low" as const, requiresTechnicianConfirmation: true as const };
}
async function syntheticPdf(pages: ExtractedPdfPage[]) {
  const pdf = await PDFDocument.create(); const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const p of pages) {
    const page = pdf.addPage([600, 850]);
    for (const l of p.lines) for (const f of l.fragments) page.drawText(f.text, { x: f.x, y: l.y, size: 9, font });
  }
  return Buffer.from(await pdf.save());
}

describe("compatibilidad Autel anonimizada", () => {
  it.each(["Activo", "ACTIVO", "aCtIvO", "  Activo  ", "\r\nActivo\t\n"])("normaliza la etiqueta completa sin inferir causas: %j", label => {
    expect(normalizeDtcStatus(label)).toBe("current");
  });
  it.each([
    ["Historial", "history"], ["Permanente", "permanent"], ["DTC provisional", "provisional"],
    ["CMDTCs", "continuous_memory"], ["ODDTCs", "on_demand"], ["1 vez", "unknown"],
    ["Desconocido", "unknown"], ["Activo / static", "current"], ["Corriente / Historial", "unknown"],
  ])("conserva la semántica documental anterior: %s", (label, expected) => {
    expect(normalizeDtcStatus(label)).toBe(expected);
  });
  it.each(["Inactivo", "No activo", "No\nactivo", "Activo desconocido", "Activo / Historial", "Actividad", "1 vez"])("no convierte en activo una etiqueta ambigua: %j", label => {
    expect(normalizeDtcStatus(label)).toBe("unknown");
    const pages = activeHistoryPages(); pages[0]!.lines[pages[0]!.lines.length - 1] = columns("P0014", "Descripcion sintetica alfa", label, 320);
    const e = parseAutelReport(pages, secret);
    expect(e.dtcs[0]).toMatchObject({ status: "unknown", classification: "unknown" });
    expect(e.requiresManualReview).toBe(true); expect(prepareAiAnalysis(e).available).toBe(false);
  });
  it("conserva quince sistemas y seis observaciones entre páginas con odómetro opcional", () => {
    const e = parseAutelReport(activeHistoryPages(), secret), prep = prepareAiAnalysis(e);
    expect(e).toMatchObject({ status: "completed", requiresManualReview: false, vehicle: activeHistoryFixture.vehicle,
      scanSummary: activeHistoryFixture.scanSummary, systems: activeHistoryFixture.systems, dtcs: activeHistoryFixture.dtcs });
    expect(e.warnings.map(w => w.code)).toEqual(["VIN_NOT_PROVIDED", "ODOMETER_UNIT_NOT_PROVIDED"]);
    expect(prep).toMatchObject({ available: true, reasons: [], counts: { detected: 6, actionable: 3, historical: 3 } });
    expect(e.review).toBeUndefined();
    if (!prep.available) throw new Error("Synthetic fixture unavailable");
    expect(prep.input.modules).toHaveLength(2);
    expect(prep.input.modules.flatMap(m => m.dtcs.map(d => [d.code, d.status]))).toEqual([["P0014", "current"], ["P0078", "current"], ["B1670:00", "current"]]);
  });
  it("recorre extractor hijo → upload sin revisión → Responses simulado → guardado con tres antecedentes", async () => {
    const prep = prepareAiAnalysis(parseAutelReport(activeHistoryPages(), secret));
    if (!prep.available) throw new Error("Synthetic fixture unavailable");
    const modelOutput = output(prep.input);
    const create = vi.fn(async () => ({ status: "completed", output: [], output_text: JSON.stringify({ ...modelOutput,
      findings: modelOutput.findings.map((f, i) => ({ ...f, relatedDtc: `D${String(i + 1).padStart(3, "0")}` })) }) }));
    const save = vi.fn(async (_user: string, value: HistorySaveInput) => {
      const record = buildHistoryInsertRecord(value);
      expect(record.extractionSnapshot.systems).toHaveLength(15);
      expect(record.extractionSnapshot.dtcs).toEqual(activeHistoryFixture.dtcs);
      expect(record.extractionSnapshot.vehicle).toMatchObject({ odometer: null, odometerRaw: "0" });
      expect(record.analysisSnapshot.counts).toEqual({ detected: 6, actionable: 3, historical: 3 });
      expect(record.analysisSnapshot.output.findings).toHaveLength(3);
      return { id: "11111111-1111-4111-8111-111111111111" };
    });
    const app = createApp({ vinHmacSecret: secret, openAiModel: "synthetic-model",
      analysisService: new DiagnosticAnalysisService(new OpenAiResponsesClient("synthetic", { responses: { create } } as never), "synthetic-model", 1000),
      authenticationService: { login: vi.fn(), authenticate: async () => ({ id: "22222222-2222-4222-8222-222222222222", username: "synthetic" }) },
      historyService: { save, findReusable: async () => null } as never });
    const upload = await request(app).post("/api/reports/upload").set("Authorization", "Bearer synthetic")
      .attach("report", await syntheticPdf(activeHistoryPages()), { filename: "synthetic.pdf", contentType: "application/pdf" });
    expect(upload.status).toBe(201); expect(upload.body.extraction.requiresManualReview).toBe(false);
    expect(upload.body.analysisPreparation).toMatchObject({ available: true, counts: { detected: 6, actionable: 3, historical: 3 } });
    expect(create).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
    const result = await request(app).post("/api/reports/analyze").set("Authorization", "Bearer synthetic")
      .set("Idempotency-Key", "33333333-3333-4333-8333-333333333333").send({ input: upload.body.analysisPreparation.input,
        historyContext: { reportReference: upload.body.id, contentToken: upload.body.contentToken, extractionToken: upload.body.extractionToken, extraction: upload.body.extraction } });
    expect(result.status).toBe(200); expect(result.body.history.status).toBe("saved");
    expect(save).toHaveBeenCalledOnce(); expect(create).toHaveBeenCalledOnce();
    const transport = JSON.stringify(create.mock.calls[0]);
    for (const code of ["P0014", "P0078", "B1670:00"]) expect(transport).toContain(code);
    for (const code of ["B1102:00", "B1748:00", "B1319"]) expect(transport).not.toContain(code);
    expect(transport).toContain('\\"status\\":\\"current\\"');
    expect(transport).not.toContain("reviewed_uncertain"); expect(transport).not.toContain("odometer");
    expect(transport).not.toContain(upload.body.extractionToken);
  });
  it.each(["Other/Mazda/AXELA / MAZDA3/", " Other / Mazda / AXELA / MAZDA3 / "])("preserva ruta sin año y siete referencias: %s", route => {
    const extraction = parseAutelReport(mazdaPages(route), secret);
    expect(extraction).toMatchObject({ status: "completed", requiresManualReview: false,
      vehicle: { year: null, make: "Mazda", model: "AXELA / MAZDA3", engine: null },
      scanSummary: { declaredSystems: 13, parsedSystems: 13, declaredDtcs: 7, parsedDtcs: 7 } });
    expect(extraction.dtcs.map(d => [d.code, d.moduleCode])).toEqual([
      ["P013B:00", "PCM"], ...["B10A6:FF", "B1231:FF", "B1877:FF", "B1932:FF", "B2227:FF", "B2232:FF"].map(c => [c, "RCM"]),
    ]);
    expect(extraction.dtcs[0]).toMatchObject({ status: "on_demand", statusOriginal: "ODDTCs", descriptionOriginal: "Primera descripcion sintetica continuacion del PCM" });
    expect(extraction.dtcs.slice(1).every(d => d.status === "continuous_memory" && d.statusOriginal === "CMDTCs")).toBe(true);
    expect(extraction.dtcs[3]!.descriptionOriginal).toBe("Descripcion sintetica 2 continuacion 2");
    expect(extraction.dtcs[2]!.descriptionOriginal).toBe("Descripcion sintetica 1");
    expect(prepareAiAnalysis(extraction)).toMatchObject({ available: false, reasons: [{ code: "VEHICLE_DATA_MISSING" }] });
  });

  it("confirma solo año ausente, conserva evidencia manual y no elimina revisión/estados desconocidos", () => {
    const extraction = parseAutelReport(mazdaPages(), secret);
    const vehicle = { make: "Mazda", model: "AXELA / MAZDA3", year: 2014 };
    const result = confirmVehicleData({ extraction, vehicle })!;
    expect(result.analysisPreparation.available).toBe(true);
    expect(extraction.vehicle.year).toBeNull();
    expect(result.extraction.warnings).toContainEqual({ code: "YEAR_NOT_PROVIDED", message: "El PDF no proporciona un año; se utiliza el año confirmado por el usuario." });
    expect(result.extraction.warnings).toContainEqual(expect.objectContaining({ code: "VEHICLE_DATA_CONFIRMED_BY_USER" }));
    expect(historyExtractionInputSchema.safeParse(result.extraction).success).toBe(true);
    for (const year of [null, "2014", 1700, 10000, 2014.5]) expect(confirmVehicleData({ extraction, vehicle: { ...vehicle, year } })).toBeNull();
    expect(confirmVehicleData({ extraction, vehicle: { ...vehicle, make: "Honda" } })).toBeNull();
    expect(confirmVehicleData({ extraction, vehicle, ignoreReview: true })).toBeNull();
    extraction.status = "partial"; extraction.requiresManualReview = true;
    extraction.dtcs[0]!.status = "unknown"; extraction.dtcs[0]!.classification = "unknown";
    const blocked = confirmVehicleData({ extraction, vehicle })!;
    expect(blocked.analysisPreparation.available).toBe(false);
    expect(blocked.analysisPreparation.reasons.map(r => r.code)).toEqual(expect.arrayContaining(["EXTRACTION_INCOMPLETE", "MANUAL_REVIEW_REQUIRED", "UNKNOWN_DTC_STATUS"]));
  });

  it("admite Honda con 35 filas y SRS de 22 bajo el máximo autorizado de 50", () => {
    const extraction = parseAutelReport(hondaPages(), secret);
    expect(extraction).toMatchObject({ status: "completed", scanSummary: { parsedSystems: 16, parsedDtcs: 35 } });
    expect(extraction.dtcs.every(d => d.status === "permanent" && d.statusOriginal === "DTC permanente")).toBe(true);
    expect(extraction.dtcs.filter(d => d.code === "U0416-68")).toHaveLength(3);
    expect(extraction.dtcs[2]!.descriptionOriginal).toBe("Inicio sintetico 1 fin sintetico 1");
    expect(prepareAiAnalysis(extraction)).toMatchObject({ available: true, counts: { detected: 35, actionable: 35 } });
  });

  it("acepta el código numérico VAG solo en tabla contextual, sin perder ceros ni sufijos", () => {
    const pages = mazdaPages("2012 (C)/Audi/Audi A4/S4/RS4 2008>/");
    pages.splice(1); pages[0]!.lines = [...pages[0]!.lines.slice(0, 3), line("Sistema/s escaneado/s (1)", 730),
      line("Sistema Estado/DTC", 710), line("17 - Cuadro de Instrumentos 1", 690), line("DTC (1)", 650),
      line("17 - Cuadro de Instrumentos (1 DTC)", 630), header(620), line("Descripcion sintetica", 609, 105),
      columns("00003:005", "", "Activo / static", 600), line("continuacion del instrumento", 591, 105)];
    const result = parseAutelReport(pages, secret);
    expect(result.vehicle).toMatchObject({ make: "Audi", model: "Audi A4 / S4 / RS4 2008>", year: 2012, engine: null });
    expect(result.dtcs).toEqual([expect.objectContaining({ code: "00003:005", moduleName: "17 - Cuadro de Instrumentos", status: "current",
      descriptionOriginal: "Descripcion sintetica continuacion del instrumento" })]);
    expect(prepareAiAnalysis(result).available).toBe(true);
    pages[0]!.lines = pages[0]!.lines.filter(l => !l.text.startsWith("DTC Descripción Estado"));
    expect(parseAutelReport(pages, secret).requiresManualReview).toBe(true);
  });

  it.each(["ODDTCs", "CMDTCs", "DTC permanente", "Activo / static"])("no interpreta variantes desconocidas por coincidencia parcial: %s", status => {
    expect(normalizeDtcStatus(status)).not.toBe("unknown");
    expect(normalizeDtcStatus(status + " desconocido")).toBe("unknown");
  });

  it("bloquea identidades contradictorias y descripciones geométricamente ambiguas", () => {
    const pages = mazdaPages();
    pages[0]!.lines.splice(3, 0, line("Other/Honda/Modelo sintetico/", 750));
    const conflicting = parseAutelReport(pages, secret);
    expect(conflicting.requiresManualReview).toBe(true);
    expect(conflicting.warnings).toContainEqual(expect.objectContaining({ code: "VEHICLE_IDENTITY_AMBIGUOUS" }));
    const ambiguous = mazdaPages();
    // Midpoint between the first two codes on page 2 cannot be attributed safely.
    ambiguous[1]!.lines.splice(3, 0, line("Descripcion equidistante", 715, 105));
    expect(parseAutelReport(ambiguous, secret).requiresManualReview).toBe(true);
  });

  it("recorre upload real, confirmación autenticada y análisis simulado sin red externa", async () => {
    const analyze = vi.fn(async (input: DiagnosticAnalysisInput) => output(input));
    const save = vi.fn(async () => ({ id: "11111111-1111-4111-8111-111111111111" }));
    const app = createApp({ vinHmacSecret: secret, openAiModel: "synthetic-model", analysisService: { analyze },
      authenticationService: { login: vi.fn(), authenticate: async () => ({ id: "22222222-2222-4222-8222-222222222222", username: "synthetic" }) },
      historyService: { save, findReusable: async () => null } as never,
    });
    expect((await request(app).post("/api/reports/confirm-vehicle").send({})).status).toBe(401);
    const pdf = await syntheticPdf(mazdaPages());
    const upload = await request(app).post("/api/reports/upload").set("Authorization", "Bearer synthetic")
      .attach("report", pdf, { filename: "synthetic.pdf", contentType: "application/pdf" });
    expect(upload.status).toBe(201);
    expect(upload.body.extraction.scanSummary).toMatchObject({ parsedSystems: 13, parsedDtcs: 7 });
    expect(upload.body.analysisPreparation.available).toBe(false);
    const body = { extraction: upload.body.extraction, vehicle: { make: "Mazda", model: "AXELA / MAZDA3", year: 2014 } };
    const invalid = await request(app).post("/api/reports/confirm-vehicle").set("Authorization", "Bearer synthetic").send({ ...body, vehicle: { ...body.vehicle, year: 0 } });
    expect(invalid.status).toBe(400); expect(analyze).not.toHaveBeenCalled();
    const reviewBody = { ...body, reportReference: upload.body.id, contentToken: upload.body.contentToken, extractionToken: upload.body.extractionToken,
      reason: "Año confirmado contra documentacion sintetica.", rows: upload.body.extraction.dtcs.map((d: { code: string; descriptionOriginal: string; moduleCode: string | null; moduleName: string }, i: number) => ({
        sourceIndex: i, code: d.code, description: d.descriptionOriginal, state: "as_reported",
        moduleIndex: upload.body.extraction.systems.findIndex((s: { code: string | null; name: string }) => s.code === d.moduleCode && s.name === d.moduleName),
      })) };
    const confirmed = await request(app).post("/api/reports/review").set("Authorization", "Bearer synthetic").send(reviewBody);
    expect(confirmed.status).toBe(200); expect(confirmed.body.analysisPreparation.available).toBe(true);
    const result = await request(app).post("/api/reports/analyze").set("Authorization", "Bearer synthetic")
      .set("Idempotency-Key", "33333333-3333-4333-8333-333333333333").send({ input: confirmed.body.analysisPreparation.input,
        historyContext: { reportReference: upload.body.id, contentToken: upload.body.contentToken, extractionToken: confirmed.body.extractionToken, extraction: confirmed.body.extraction } });
    expect(result.status).toBe(200); expect(analyze).toHaveBeenCalledOnce(); expect(save).toHaveBeenCalledOnce();
    const input = analyze.mock.calls[0]![0];
    expect(input.modules.flatMap(m => m.dtcs)).toHaveLength(7);
    expect(input.modules[1]!.dtcs.every(d => d.status === "continuous_memory")).toBe(true);
    expect(save.mock.calls[0]![1].context.extraction.review.original.vehicle.year).toBeNull();
  });

  it("mantiene estados diferenciados en contexto, snapshot y fingerprint sin generación real", async () => {
    const confirmed = confirmVehicleData({ extraction: parseAutelReport(mazdaPages(), secret), vehicle: { make: "Mazda", model: "AXELA / MAZDA3", year: 2014 } })!;
    if (!confirmed.analysisPreparation.available) throw new Error("Synthetic fixture unavailable");
    const input = confirmed.analysisPreparation.input;
    const generate = vi.fn(async () => JSON.stringify(output(input)));
    const service = new DiagnosticAnalysisService({ generate }, "synthetic", 1000);
    const analysis = await service.analyze(input);
    expect(generate.mock.calls[0]![0].instructions).toContain("no confirman una falla actualmente activa");
    expect(generate.mock.calls[0]![0].report.modules[1]!.dtcs[0]!.status).toBe("continuous_memory");
    expect(generate.mock.calls[0]![0].report.modules[1]!.dtcs[0]!.observations).toEqual([
      expect.objectContaining({ statusOriginal: "CMDTCs", status: "continuous_memory" }),
    ]);
    const snapshot = historyPublicSnapshotSchema.parse({ extraction: { ...confirmed.extraction,
      vehicle: { ...confirmed.extraction.vehicle, vinPseudonym: null } }, analysis: { input, counts: confirmed.analysisPreparation.counts,
        output: analysis, submittedObservations: "" }, rag: { enabled: false, used: false, status: "disabled", querySummary: "Desactivado", sources: [] } });
    expect(snapshot.extraction.dtcs[1]!.statusOriginal).toBe("CMDTCs");
    const identity = { contentFingerprint: "pdf_v1_" + "a".repeat(64), input, extraction: snapshot.extraction, analysisModel: "synthetic",
      embeddingModel: "text-embedding-3-small", outputSchemaVersion: "diagnostic_output_schema_v1", corpusVersion: "unchanged",
      rag: { enabled: false, matchCount: 4, matchThreshold: 0.7, maxContextCharacters: 6000 } };
    expect(createAnalysisFingerprint({ ...identity, promptVersion: DIAGNOSTIC_PROMPT_VERSION }, secret))
      .not.toBe(createAnalysisFingerprint({ ...identity, promptVersion: "diagnostic_prompt_v2_reference_ids" }, secret));
  });
});
