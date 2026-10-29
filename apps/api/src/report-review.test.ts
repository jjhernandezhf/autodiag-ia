import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { prepareAiAnalysis } from "./ai-analysis-adapter.js";
import { diagnosticAnalysisInputSchema, diagnosticAnalysisOutputSchema, DIAGNOSTIC_ANALYSIS_JSON_SCHEMA, historicalAnalysisInputSchema } from "./ai-analysis-types.js";
import { createAnalysisFingerprint, createPdfContentToken } from "./analysis-fingerprint.js";
import { createExtractionToken, reviewReport, validatedReportMatchesInput } from "./report-review.js";
import { historyPublicSnapshotSchema } from "./diagnostic-history.js";
import { parseAutelReport } from "./autel-parser.js";
import { DiagnosticAnalysisService, OpenAiResponsesClient } from "./ai-analysis-service.js";
import { HistoryAnalyticsService } from "./history-analytics.js";
import { aggregateStatistics } from "./history-statistics.js";
import type { AutelExtraction, ExtractedPdfPage } from "./report-types.js";

const secret = "synthetic-report-review-only-key-at-least-32-bytes";
const userId = "22222222-2222-4222-8222-222222222222", otherId = "33333333-3333-4333-8333-333333333333";
const reportReference = "11111111-1111-4111-8111-111111111111";
const why = "Verificado contra evidencia sintetica autorizada.";
const blankVehicle = { make: "Marca sintetica", model: "Modelo sintetico", year: 2020, engine: null, odometer: null, vinMasked: null, vinPseudonym: null };
function extraction(count = 1, modules = 1): AutelExtraction {
  const systems = Array.from({ length: modules }, (_, i) => ({ code: `M${i}`, name: `Modulo ${i}`, dtcCount: 0 }));
  const dtcs = Array.from({ length: count }, (_, i) => {
    const system = systems[i % modules]!; system.dtcCount++;
    return { code: `P${i.toString().padStart(4, "0")}`, moduleCode: system.code, moduleName: system.name,
      descriptionOriginal: `Descripcion sintetica ${i}`, status: "current" as const, statusOriginal: "Actual", classification: "actionable" as const };
  });
  return { format: "autel_vehicle_diagnostic_report", status: "completed", requiresManualReview: false, vehicle: { ...blankVehicle },
    scanSummary: { declaredSystems: modules, parsedSystems: modules, declaredDtcs: count, parsedDtcs: count }, systems, dtcs, warnings: [] };
}
function reviewRequest(e: AutelExtraction) {
  const contentToken = createPdfContentToken(Buffer.from("%PDF-synthetic"), secret, userId);
  return { reportReference, contentToken, extraction: structuredClone(e),
    extractionToken: createExtractionToken(e, userId, reportReference, contentToken, secret),
    vehicle: { make: e.vehicle.make!, model: e.vehicle.model!, year: e.vehicle.year ?? 2014 }, reason: why,
    rows: e.dtcs.map((d, i) => ({ sourceIndex: i, moduleIndex: e.systems.findIndex(s => s.code === d.moduleCode && s.name === d.moduleName),
      code: d.code, description: d.descriptionOriginal, state: "as_reported" as "as_reported" | "reviewed_uncertain", reason: why })),
  };
}
function output(n: number) {
  return { technicalSummary: "Resumen sintetico", findings: Array.from({ length: n }, (_, i) => ({
    relatedDtc: { code: `P${i.toString().padStart(4, "0")}`, moduleCode: "M0", moduleName: "Modulo 0" }, priority: "medium",
    simpleExplanation: "Condicion por verificar", possibleCauses: ["Posibilidad sintetica"], recommendedChecks: ["Comprobar evidencia"], safetyWarnings: ["Revision profesional"], confidence: "low",
  })), observationCorrelation: { status: "not_provided", summary: "Sin observaciones", matches: [] }, safetyWarnings: ["Orientacion no confirmada"], confidence: "low", requiresTechnicianConfirmation: true };
}
describe("capacidad y observaciones", () => {
  it("reproduce Acura y CR-V anonimizados: códigos numéricos, repetidos y continuidad", () => {
    const acura = caseExtraction("Acura", [
      ["PGM-FI", ["P0141", "U0122", "P0430", "P0301", "P0302", "P0304", "P0306", "P0300", "P0430"]],
      ["SRS", ["61-10"]], ["Cuadro", ["B1150", "B1155", "B1159", "B1160"]],
    ], 7);
    acura.dtcs[8]!.statusOriginal = "DTC provisional"; acura.systems[2]!.dtcCount = 0;
    const pages = reportPages(acura); const split = pages[0]!.lines.findIndex(l => l.text.includes("SRS(Modulo SRS) (1 DTC)")) + 1;
    pages.push({ pageNumber: 2, lines: pages[0]!.lines.splice(split) });
    const e = parseAutelReport(pages, secret);
    expect(e.scanSummary).toEqual({ declaredSystems: 7, parsedSystems: 7, declaredDtcs: 14, parsedDtcs: 14 });
    expect(e.dtcs.find(d => d.code === "61-10")).toMatchObject({ moduleCode: "SRS", status: "permanent" });
    expect(e.warnings.map(w => w.code)).toContain("MODULE_DTC_COUNT_MISMATCH");
    expect(new Set(e.dtcs.map(d => [d.moduleCode, d.moduleName, d.code].join("|"))).size).toBe(13);
    const r = reviewReport({ ...reviewRequest(e), countsDecision: { use: "detail", reason: why } }, userId, secret)!;
    expect(r.analysisPreparation).toMatchObject({ available: true, counts: { detected: 14, actionable: 13 } });
    expect(r.extraction.review!.original.systems[2]!.dtcCount).toBe(0);

    const crv = caseExtraction("Honda", [["PGM-FI", ["P1157", "P0506", "P1157"]], ["ABS/VSA", ["65-1", "68-1"]],
      ["SRS", ["F3-11", "85-61", "71-10", "92-20"]]], 5);
    crv.dtcs[2]!.statusOriginal = "DTC provisional";
    const cp = reportPages(crv); const last = cp[0]!.lines.findIndex(l => l.text.startsWith("92-20"));
    cp.push({ pageNumber: 2, lines: cp[0]!.lines.splice(last) });
    const parsed = parseAutelReport(cp, secret), prep = prepareAiAnalysis(parsed);
    expect(parsed.scanSummary).toEqual({ declaredSystems: 5, parsedSystems: 5, declaredDtcs: 9, parsedDtcs: 9 });
    expect(parsed.dtcs.map(d => d.code)).toEqual(crv.dtcs.map(d => d.code));
    expect(parsed.dtcs.at(-1)).toMatchObject({ code: "92-20", moduleCode: "SRS" });
    expect(prep).toMatchObject({ available: true, counts: { detected: 9, actionable: 8 } });
    if (!prep.available) throw Error("Synthetic fixture");
    expect(prep.input.modules[0]!.dtcs[0]).toMatchObject({ code: "P1157", status: "multiple_observed", observations: [
      { statusOriginal: "DTC permanente" }, { statusOriginal: "DTC provisional" },
    ] });
  });
  it("distingue Kia con cero legítimo y Nissan con seis estados sin interpretación", () => {
    const kia = caseExtraction("Kia", [], 8); kia.vehicle.odometerRaw = "0";
    const k = parseAutelReport(reportPages(kia), secret);
    expect(k).toMatchObject({ status: "completed", requiresManualReview: false, vehicle: { odometer: null, odometerRaw: "0" }, scanSummary: { parsedSystems: 8, parsedDtcs: 0 } });
    expect(prepareAiAnalysis(k).reasons.map(r => r.code)).toEqual(["NO_VALID_DTCS"]);
    expect(reviewReport({ ...reviewRequest(k), countsDecision: { use: "detail", reason: why }, rows: [{ sourceIndex: null, moduleIndex: 0,
      code: "P0001", description: "Descripcion inventada sintetica", state: "as_reported", statusLabel: "Actual", reason: why }] }, userId, secret)).toBeNull();
    const nissan = caseExtraction("Nissan", [["Motor", ["P0550", "P1551"]], ["ABS", ["C1163"]], ["SRS", ["B1209", "B1049", "B1081", "B1086", "B1054"]]], 7);
    nissan.dtcs.forEach(d => { d.statusOriginal = ["C1163", "B1086"].includes(d.code) ? "Actual" : "1 vez"; });
    const n = parseAutelReport(reportPages(nissan), secret);
    expect(prepareAiAnalysis(n)).toMatchObject({ available: false, counts: { detected: 8, actionable: 2 } });
    expect(n.dtcs.filter(d => d.status === "unknown" && d.statusOriginal === "1 vez")).toHaveLength(6);
  });
  it("envía y restituye 50 referencias en Responses simulado y conserva el contexto de revisión", async () => {
    const prepared = prepareAiAnalysis(extraction(50));
    if (!prepared.available) throw Error("Synthetic fixture");
    const wire = output(50);
    const create = vi.fn(async () => ({ status: "completed", output: [], output_text: JSON.stringify({ ...wire,
      findings: wire.findings.map((f, i) => ({ ...f, relatedDtc: `D${String(i + 1).padStart(3, "0")}` })),
    }) }));
    const service = new DiagnosticAnalysisService(new OpenAiResponsesClient("synthetic-not-a-real-key", { responses: { create } } as never), "synthetic", 1000);
    const result = await service.analyze(prepared.input);
    expect(result.findings).toHaveLength(50); expect(result.findings[49]!.relatedDtc!.code).toBe("P0049");
    const body = create.mock.calls[0]![0];
    expect(body.text.format.schema.properties.findings.maxItems).toBe(50);
    expect(body.text.format.schema.properties.findings.items.properties.relatedDtc.anyOf[0].enum).toHaveLength(50);
    expect(body.store).toBe(false); expect(body).not.toHaveProperty("tools");
    const e = extraction(); e.vehicle.year = null;
    const reviewed = reviewReport(reviewRequest(e), userId, secret)!;
    if (!reviewed.analysisPreparation.available) throw Error("Synthetic fixture");
    create.mockResolvedValueOnce({ status: "completed", output: [], output_text: JSON.stringify({ ...output(1), findings: [{ ...output(1).findings[0], relatedDtc: "D001" }] }) });
    await service.analyze(reviewed.analysisPreparation.input);
    const report = JSON.parse(create.mock.calls[1]![0].input[0].content[0].text).report;
    expect(report.reviewContext.reason).toBe(why);
    expect(JSON.stringify(report)).not.toMatch(/extractionToken|contentToken|vinMasked|vinPseudonym|reportReference/u);
    const invalid = structuredClone(prepared.input); invalid.modules[0]!.dtcs.push({ ...invalid.modules[0]!.dtcs[0]!, code: "P9999" });
    await expect(service.analyze(invalid)).rejects.toMatchObject({ code: "AI_INPUT_INVALID" });
    expect(create).toHaveBeenCalledTimes(2);
  });
  it.each([20, 21, 50, 51])("aplica el máximo global en uno y varios módulos: %s", count => {
    for (const modules of [1, 3]) {
      const e = extraction(count, modules), p = prepareAiAnalysis(e);
      expect(p.available).toBe(count <= 50);
      expect(e.dtcs).toHaveLength(count);
      if (p.available) expect(p.input.modules.reduce((sum, m) => sum + m.dtcs.length, 0)).toBe(count);
      else expect(p.reasons).toContainEqual(expect.objectContaining({ code: "ANALYSIS_LIMIT_EXCEEDED" }));
    }
    expect(diagnosticAnalysisOutputSchema.safeParse(output(count)).success).toBe(count <= 50);
    expect(DIAGNOSTIC_ANALYSIS_JSON_SCHEMA.properties.findings.maxItems).toBe(50);
  });
  it("mantiene dos estados de una identidad y no deduplica globalmente entre módulos", () => {
    const e = extraction(2, 2);
    const first = e.dtcs[0]!;
    e.dtcs[1] = { ...e.dtcs[1]!, code: first.code };
    e.dtcs.push({ ...first, status: "provisional", statusOriginal: "DTC provisional" });
    e.systems[0]!.dtcCount = 2; e.scanSummary.declaredDtcs = e.scanSummary.parsedDtcs = 3;
    const p = prepareAiAnalysis(e);
    expect(p).toMatchObject({ available: true, counts: { detected: 3, actionable: 2 } });
    if (!p.available) throw Error("Synthetic fixture");
    expect(p.input.modules[0]!.dtcs[0]).toMatchObject({ status: "multiple_observed", observations: [
      { status: "current", statusOriginal: "Actual" }, { status: "provisional", statusOriginal: "DTC provisional" },
    ] });
    expect(p.input.modules[1]!.dtcs[0]!.code).toBe(first.code);
    const forged = structuredClone(p.input); forged.modules[0]!.dtcs[0]!.status = "current";
    expect(diagnosticAnalysisInputSchema.safeParse(forged).success).toBe(false);
  });
  it("acota duplicados independientemente de las 50 identidades", () => {
    const e = extraction(); e.dtcs = Array.from({ length: 201 }, () => ({ ...e.dtcs[0]! }));
    e.systems[0]!.dtcCount = 201; e.scanSummary.declaredDtcs = e.scanSummary.parsedDtcs = 201;
    expect(prepareAiAnalysis(e)).toMatchObject({ available: false, reasons: expect.arrayContaining([expect.objectContaining({ code: "ANALYSIS_LIMIT_EXCEEDED" })]) });
  });
  it("las observaciones agrupadas no crean nuevas filas en estadísticas ni CSV", async () => {
    const e = extraction(); e.dtcs.push({ ...e.dtcs[0]!, status: "provisional", statusOriginal: "DTC provisional" });
    e.systems[0]!.dtcCount = 2; e.scanSummary.declaredDtcs = e.scanSummary.parsedDtcs = 2;
    expect(prepareAiAnalysis(e)).toMatchObject({ available: true, counts: { detected: 2, actionable: 1 } });
    const metadata = { id: reportReference, created_at: "2026-10-01T12:00:00.000Z", make: "Marca", model: "Modelo", year: 2020, dtc_count: 2, rag_status: "disabled" as const };
    const service = new HistoryAnalyticsService({ page: async () => [metadata], dtcs: async () => [{ id: reportReference, dtcs: e.dtcs }] });
    const csv = await service.export(userId), records = await service.records(userId);
    expect(csv.dtcCount).toBe(2); expect(csv.analysesCount).toBe(1);
    expect(csv.dtcsCsv.trim().split("\r\n")).toHaveLength(3); // Header + two original observations, not copies of the aggregate.
    const statistics = aggregateStatistics(records.records, records.cutoff, {});
    expect(statistics).toMatchObject({ totalAnalyses: 1, dtcRecords: 2, distinctCodes: 1, codes: [{ code: "P0000", count: 1 }] });
    expect(statistics.modules[0]!.count).toBe(1);
  });
  it("mantiene lectura legacy de 60 entradas pero no admite nuevas generaciones con ellas", () => {
    const e = extraction(60, 3), p = prepareAiAnalysis(e, { legacyRead: true });
    expect(p.available).toBe(true);
    if (!p.available) throw Error("Synthetic fixture");
    expect(historicalAnalysisInputSchema.safeParse(p.input).success).toBe(true);
    expect(diagnosticAnalysisInputSchema.safeParse(p.input).success).toBe(false);
    expect(prepareAiAnalysis(e).available).toBe(false);
  });
});

describe("revisión firmada", () => {
  it("conserva una fila con código no interpretado y reconstruye su misma posición sin pérdida ni duplicación", () => {
    const e = extraction(2); e.dtcs[0]!.code = "12?45"; e.dtcs[0]!.descriptionOriginal = "";
    e.dtcs[0]!.statusOriginal = "1 vez"; e.vehicle.year = null;
    const parsed = parseAutelReport(reportPages(e), secret);
    expect(parsed.dtcs).toHaveLength(2);
    expect(parsed.dtcs[0]).toMatchObject({ code: "12?45", descriptionOriginal: "", statusOriginal: "1 vez", status: "unknown" });
    expect(parsed.warnings.map(w => w.code)).toContain("DTC_ROW_UNPARSED");
    expect(prepareAiAnalysis(parsed).available).toBe(false);
    const raw = reviewRequest(parsed);
    expect(reviewReport({ ...raw, reviewedWarnings: [{ code: "DTC_ROW_UNPARSED", reason: why }] }, userId, secret)).toBeNull();
    const rows = raw.rows.map((r, i) => i === 0 ? { ...r, code: "P0300", description: "Descripcion literal reconstruida", state: "reviewed_uncertain" as const } : r);
    expect(reviewReport({ ...raw, rows: rows.slice(1) }, userId, secret)).toBeNull();
    const result = reviewReport({ ...raw, rows, reviewedWarnings: [{ code: "DTC_ROW_UNPARSED", reason: why }] }, userId, secret)!;
    expect(result.analysisPreparation).toMatchObject({ available: true, counts: { detected: 2, actionable: 2 } });
    expect(result.extraction.dtcs).toHaveLength(2);
    expect(result.extraction.review!.original.dtcs[0]).toMatchObject({ code: "12?45", descriptionOriginal: "", statusOriginal: "1 vez" });
    expect(result.extraction.review!.decisions).toContainEqual(expect.objectContaining({ path: "rows.0.code", before: "12?45", after: "P0300", reason: why }));
    if (!result.analysisPreparation.available) throw Error("Synthetic review");
    expect(result.analysisPreparation.input.modules[0]!.dtcs[0]).toMatchObject({ code: "P0300", status: "reviewed_uncertain", observations: [{ statusOriginal: "1 vez" }] });
  });
  it("reasocia un módulo no identificado a un sistema existente sin inventar sistemas", () => {
    const e = extraction(); e.dtcs[0]!.moduleCode = null; e.dtcs[0]!.moduleName = "Modulo no identificado";
    e.status = "partial"; e.requiresManualReview = true;
    e.warnings = [{ code: "DTC_ROW_UNPARSED", message: "Modulo sin asociar" }, { code: "MODULE_DTC_COUNT_MISMATCH", message: "Conteos diferentes" }];
    const raw = reviewRequest(e), rows = raw.rows.map(r => ({ ...r, moduleIndex: 0 }));
    expect(reviewReport({ ...raw, rows: rows.map(r => ({ ...r, moduleIndex: 99 })) }, userId, secret)).toBeNull();
    const result = reviewReport({ ...raw, rows, reviewedWarnings: [{ code: "DTC_ROW_UNPARSED", reason: why }] }, userId, secret)!;
    expect(result.analysisPreparation.available).toBe(true);
    expect(result.extraction.dtcs[0]).toMatchObject({ moduleCode: "M0", moduleName: "Modulo 0" });
    expect(result.extraction.review!.original.dtcs[0]!.moduleCode).toBeNull();
    expect(result.extraction.review!.decisions).toContainEqual(expect.objectContaining({ path: "rows.0.module", reason: why }));
  });
  it("una copia añadida no pasa silenciosamente; una observación independiente idéntica requiere evidencia propia", () => {
    const e = extraction(); e.scanSummary.declaredDtcs = 2; e.systems[0]!.dtcCount = 2;
    e.status = "partial"; e.requiresManualReview = true; e.warnings = [{ code: "DTC_ROW_UNPARSED", message: "Falta una fila" }];
    const raw = reviewRequest(e);
    const added = { ...raw.rows[0]!, sourceIndex: null, statusLabel: "Actual" };
    const body = { ...raw, rows: [...raw.rows, added], reviewedWarnings: [{ code: "DTC_ROW_UNPARSED", reason: why }] };
    expect(reviewReport(body, userId, secret)).toBeNull();
    const result = reviewReport({ ...body, rows: [...raw.rows, { ...added, duplicateReason: "El documento sintetico contiene dos observaciones independientes iguales." }] }, userId, secret)!;
    expect(result.analysisPreparation).toMatchObject({ available: true, counts: { detected: 2, actionable: 1 } });
    expect(result.extraction.review!.decisions).toContainEqual(expect.objectContaining({ path: "extraction", after: expect.stringContaining("observación independiente") }));
    expect(result.extraction.dtcs).toHaveLength(2);
  });
  it("reconstruye una fila ausente con estado no indicado manteniendo incertidumbre y conteos originales", () => {
    const e = extraction(); e.scanSummary.declaredDtcs = 2; e.systems[0]!.dtcCount = 2;
    e.status = "partial"; e.requiresManualReview = true; e.warnings = [{ code: "DTC_ROW_UNPARSED", message: "Falta una fila" }];
    const raw = reviewRequest(e);
    const result = reviewReport({ ...raw, rows: [...raw.rows, { sourceIndex: null, moduleIndex: 0, code: "P0300", description: "Descripcion documentada", state: "reviewed_uncertain", reason: why }],
      reviewedWarnings: [{ code: "DTC_ROW_UNPARSED", reason: why }] }, userId, secret)!;
    expect(result.analysisPreparation).toMatchObject({ available: true, counts: { detected: 2, actionable: 2 } });
    expect(result.extraction.review!.original.scanSummary).toMatchObject({ declaredDtcs: 2, parsedDtcs: 1 });
    expect(result.extraction.dtcs[1]).toMatchObject({ status: "reviewed_uncertain", statusOriginal: null });
  });
  it("completa identidad ausente con evidencia sin levantar una sección estructural faltante", () => {
    const e = extraction(); e.vehicle.make = e.vehicle.model = null; e.vehicle.year = null;
    e.status = "partial"; e.requiresManualReview = true;
    e.warnings = [{ code: "VEHICLE_IDENTITY_UNREADABLE", message: "Ruta no interpretada" }];
    const raw = reviewRequest(e); raw.vehicle = { make: "Marca sintetica", model: "Modelo confirmado", year: 2020 };
    const r = reviewReport(raw, userId, secret)!;
    expect(r.analysisPreparation.available).toBe(true);
    expect(r.extraction.review!.original.vehicle).toMatchObject({ make: null, model: null, year: null });
    expect(r.extraction.review!.decisions.map(d => d.path)).toEqual(["vehicle.make", "vehicle.model", "vehicle.year"]);
    e.warnings.push({ code: "VEHICLE_SECTION_MISSING", message: "Seccion ausente" });
    expect(reviewReport({ ...reviewRequest(e), vehicle: raw.vehicle }, userId, secret)!.analysisPreparation.available).toBe(false);
  });
  it("reconcilia una contradicción sin perder el resumen original ni inventar revisión profesional", () => {
    const e = extraction(14, 3); e.systems[2]!.dtcCount = 0;
    e.status = "partial"; e.requiresManualReview = true; e.warnings = [{ code: "MODULE_DTC_COUNT_MISMATCH", message: "Diferencia sintetica" }];
    const raw = reviewRequest(e);
    const notReconciled = reviewReport({ ...raw, vehicle: { ...raw.vehicle, model: "Modelo corregido" } }, userId, secret)!;
    expect(notReconciled.analysisPreparation.available).toBe(false);
    const result = reviewReport({ ...reviewRequest(e), countsDecision: { use: "detail", reason: why } }, userId, secret)!;
    expect(result.analysisPreparation).toMatchObject({ available: true, counts: { detected: 14, actionable: 14 } });
    expect(result.extraction.review!.original.systems[2]!.dtcCount).toBe(0);
    expect(result.extraction.systems[2]!.dtcCount).toBe(4);
    expect(result.extraction.review!.decisions).toContainEqual(expect.objectContaining({ path: "counts", reason: why }));
    expect(JSON.stringify(result.extraction.review)).not.toMatch(/vinMasked|vinPseudonym|user_id/u);
    if (!result.analysisPreparation.available) throw Error("Synthetic fixture");
    expect(validatedReportMatchesInput(result.analysisPreparation.input, { reportReference, contentToken: raw.contentToken,
      extractionToken: result.extractionToken, extraction: result.extraction }, userId, secret)).toBe(true);
    const snapshot = historyPublicSnapshotSchema.safeParse({ extraction: result.extraction,
      analysis: { input: result.analysisPreparation.input, output: output(14), counts: result.analysisPreparation.counts, submittedObservations: "" },
      rag: { enabled: false, used: false, status: "disabled", querySummary: "Desactivado", sources: [] } });
    expect(snapshot.success).toBe(true);
  });
  it("permite incertidumbre revisada de 1 vez, sin permitir imponer activo ni omitir filas", () => {
    const e = extraction(8, 3); e.dtcs.slice(0, 6).forEach(d => { d.status = "unknown"; d.classification = "unknown"; d.statusOriginal = "1 vez"; });
    e.status = "partial"; e.requiresManualReview = true; e.warnings = [{ code: "UNKNOWN_DTC_STATUS", message: "Estado sin interpretar" }];
    const raw = reviewRequest(e);
    raw.rows.slice(0, 6).forEach(row => { row.state = "reviewed_uncertain"; });
    const result = reviewReport(raw, userId, secret)!;
    expect(result.analysisPreparation).toMatchObject({ available: true, counts: { detected: 8, actionable: 8 } });
    expect(result.extraction.dtcs.slice(0, 6).every(d => d.status === "reviewed_uncertain" && d.statusOriginal === "1 vez")).toBe(true);
    if (!result.analysisPreparation.available) throw Error("Synthetic reviewed input");
    expect(result.analysisPreparation.input.modules.flatMap(m => m.dtcs).filter(d => d.status === "reviewed_uncertain")
      .every(d => d.observations?.length === 1 && d.observations[0]!.statusOriginal === "1 vez")).toBe(true);
    expect(reviewReport({ ...raw, rows: raw.rows.slice(1) }, userId, secret)).toBeNull();
    expect(reviewReport({ ...raw, rows: raw.rows.map((r, i) => i === 0 ? { ...r, statusLabel: "Actual" } : r) }, userId, secret)).toBeNull();
    const pending = reviewRequest(e); pending.vehicle.year = 2021;
    expect(reviewReport(pending, userId, secret)!.analysisPreparation.available).toBe(false);
    if (!result.analysisPreparation.available) throw Error("Synthetic fixture");
    expect(validatedReportMatchesInput(result.analysisPreparation.input, undefined, userId, secret)).toBe(false);
  });
  it("rechaza manipulación, caducidad, otro usuario, otro reporte y campos de autorización", () => {
    const e = extraction(); e.vehicle.year = null; const raw = reviewRequest(e);
    expect(reviewReport(raw, userId, secret)?.analysisPreparation.available).toBe(true);
    expect(reviewReport(raw, otherId, secret)).toBeNull();
    expect(reviewReport({ ...raw, reportReference: otherId }, userId, secret)).toBeNull();
    expect(reviewReport({ ...raw, user_id: otherId }, userId, secret)).toBeNull();
    expect(reviewReport({ ...raw, analysisPreparation: { available: true } }, userId, secret)).toBeNull();
    expect(reviewReport({ ...raw, extraction: { ...raw.extraction, requiresManualReview: true } }, userId, secret)).toBeNull();
    const token = createExtractionToken(e, userId, reportReference, raw.contentToken, secret, Date.now() - 1);
    expect(reviewReport({ ...raw, extractionToken: token }, userId, secret)).toBeNull();
    for (const year of [null, "2020", 1800, 10000, 2020.5]) expect(reviewReport({ ...raw, vehicle: { ...raw.vehicle, year } }, userId, secret)).toBeNull();
    expect(reviewReport({ ...raw, reason: "API_KEY=synthetic-secret-value" }, userId, secret)).toBeNull();
  });
  it("no permite borrar daños estructurales ni aceptar correcciones sin evidencia", () => {
    const e = extraction(); e.vehicle.year = null; e.status = "partial"; e.requiresManualReview = true;
    e.warnings = [{ code: "DTC_SECTION_MISSING", message: "Falta seccion" }];
    const raw = reviewRequest(e);
    expect(reviewReport(raw, userId, secret)!.analysisPreparation.available).toBe(false);
    const changed = { ...raw, rows: raw.rows.map(row => ({ ...row, description: "Descripcion corregida", reason: "" })) };
    expect(reviewReport(changed, userId, secret)).toBeNull();
    expect(reviewReport({ ...raw, reviewedWarnings: [{ code: "DTC_SECTION_MISSING", reason: why }] }, userId, secret)).toBeNull();
  });
  it("la huella separa correcciones y reutiliza las realmente equivalentes", () => {
    const e = extraction(); e.vehicle.year = null; const raw = reviewRequest(e);
    const a = reviewReport(raw, userId, secret)!, b = reviewReport({ ...reviewRequest(e), reason: `  ${why}  ` }, userId, secret)!;
    const c = reviewReport({ ...reviewRequest(e), vehicle: { ...raw.vehicle, year: 2015 } }, userId, secret)!;
    function fingerprint(result: NonNullable<typeof a>) {
      if (!result.analysisPreparation.available) throw Error("Synthetic fixture");
      return createAnalysisFingerprint({ contentFingerprint: "pdf_v1_" + "a".repeat(64), input: result.analysisPreparation.input, extraction: result.extraction,
        analysisModel: "synthetic", promptVersion: "synthetic-v4", outputSchemaVersion: "v1", corpusVersion: "unchanged", embeddingModel: "unchanged",
        rag: { enabled: false, matchCount: 4, matchThreshold: 0.7, maxContextCharacters: 6000 } }, secret);
    }
    expect(fingerprint(a)).toBe(fingerprint(b)); expect(fingerprint(a)).not.toBe(fingerprint(c));
  });
  it("el endpoint bloquea saltos directos y cero DTC antes de IA/RAG, y permite la revisión válida", async () => {
    let pages = extraction(0);
    const analyze = vi.fn(async () => output(1)), retrieve = vi.fn(async () => ({ metadata: { enabled: true, used: false, status: "no_matches", querySummary: "Synthetic query", sources: [] }, evidence: [] }));
    const app = createApp({ vinHmacSecret: secret, openAiModel: "synthetic", analysisService: { analyze } as never, ragService: { retrieve } as never, ragEnabled: true,
      authenticationService: { login: vi.fn(), authenticate: async () => ({ id: userId, username: "synthetic" }) },
      extractPdfPages: async () => reportPages(pages),
    });
    async function upload() { return request(app).post("/api/reports/upload").set("Authorization", "Bearer synthetic").attach("report", Buffer.from("%PDF-1.7\nsynthetic\n%%EOF"), { filename: "synthetic.pdf", contentType: "application/pdf" }); }
    const zero = await upload(); expect(zero.status).toBe(201);
    expect(zero.body.analysisPreparation.reasons.map((r: { code: string }) => r.code)).toEqual(["NO_VALID_DTCS"]);
    const valid = prepareAiAnalysis(extraction()); if (!valid.available) throw Error("Synthetic fixture");
    const rejected = await request(app).post("/api/reports/analyze").set("Authorization", "Bearer synthetic").set("Idempotency-Key", otherId).send({ input: valid.input,
      historyContext: { reportReference: zero.body.id, contentToken: zero.body.contentToken, extractionToken: zero.body.extractionToken, extraction: zero.body.extraction } });
    expect(rejected.status).toBe(400); expect(rejected.body.error.code).toBe("AI_INPUT_INVALID"); expect(analyze).not.toHaveBeenCalled(); expect(retrieve).not.toHaveBeenCalled();
    pages = extraction(); pages.vehicle.year = null;
    const uploaded = await upload();
    const body = reviewRequest(uploaded.body.extraction);
    Object.assign(body, { reportReference: uploaded.body.id, contentToken: uploaded.body.contentToken, extractionToken: uploaded.body.extractionToken });
    expect((await request(app).post("/api/reports/review").send(body)).status).toBe(401);
    const malformed = await request(app).post("/api/reports/review").set("Authorization", "Bearer synthetic").set("Content-Type", "application/json").send("{");
    expect(malformed.status).toBe(400); expect(malformed.body.error.code).toBe("REPORT_REVIEW_INVALID");
    const oversized = await request(app).post("/api/reports/review").set("Authorization", "Bearer synthetic").send({ padding: "x".repeat(256 * 1024) });
    expect(oversized.status).toBe(413); expect(oversized.body.error.code).toBe("REPORT_REVIEW_INVALID");
    const reviewed = await request(app).post("/api/reports/review").set("Authorization", "Bearer synthetic").send(body);
    expect(reviewed.status).toBe(200); expect(reviewed.body.analysisPreparation.available).toBe(true);
    expect(analyze).not.toHaveBeenCalled(); expect(retrieve).not.toHaveBeenCalled();
    const context = { reportReference: uploaded.body.id, contentToken: uploaded.body.contentToken, extractionToken: reviewed.body.extractionToken, extraction: reviewed.body.extraction };
    const strippedInput = { ...reviewed.body.analysisPreparation.input }; delete strippedInput.reviewContext;
    const strippedExtraction = { ...context.extraction }; delete strippedExtraction.review;
    const bypass = await request(app).post("/api/reports/analyze").set("Authorization", "Bearer synthetic").set("Idempotency-Key", otherId).send({ input: strippedInput,
      historyContext: { reportReference: context.reportReference, contentToken: context.contentToken, extraction: strippedExtraction } });
    expect(bypass.status).toBe(400); expect(analyze).not.toHaveBeenCalled(); expect(retrieve).not.toHaveBeenCalled();
    const validReview = await request(app).post("/api/reports/analyze").set("Authorization", "Bearer synthetic").set("Idempotency-Key", otherId)
      .send({ input: reviewed.body.analysisPreparation.input, historyContext: context });
    expect(validReview.status).toBe(200); expect(analyze).toHaveBeenCalledOnce(); expect(retrieve).toHaveBeenCalledOnce();
  });
});

function reportPages(e: AutelExtraction): ExtractedPdfPage[] {
  const line = (text: string) => ({ text, y: 0, fragments: [{ text, x: 20, width: 80 }] });
  return [{ pageNumber: 1, lines: [line("Informe de diagnostico de vehiculo"), line("Informacion del vehiculo"),
    line(`${e.vehicle.year ?? "Other"}/${e.vehicle.make}/${e.vehicle.model}/`), ...(e.vehicle.odometerRaw ? [line(`Lectura del odometro: ${e.vehicle.odometerRaw}`)] : []), line(`Sistema/s escaneado/s (${e.systems.length})`),
    line("Sistema Estado/DTC"), ...e.systems.map(s => line(`${s.code ? `${s.code}(${s.name})` : s.name} ${s.dtcCount}`)), line(`DTC (${e.dtcs.length})`),
    ...e.systems.flatMap(s => [line(`${s.code ? `${s.code}(${s.name})` : s.name} (${e.dtcs.filter(d => d.moduleCode === s.code && d.moduleName === s.name).length} DTC)`),
      { text: "DTC Descripcion Estado", y: 0, fragments: [{ text: "DTC", x: 20, width: 30 }, { text: "Descripcion", x: 105, width: 100 }, { text: "Estado", x: 430, width: 50 }] },
      ...e.dtcs.filter(d => d.moduleCode === s.code && d.moduleName === s.name).map(d => ({ text: `${d.code} ${d.descriptionOriginal} ${d.statusOriginal}`, y: 0,
        fragments: [{ text: d.code, x: 20, width: 70 }, { text: d.descriptionOriginal, x: 105, width: 200 }, { text: d.statusOriginal ?? "", x: 430, width: 90 }] })),
    ]),
  ] }];
}

function caseExtraction(make: string, groups: Array<[string, string[]]>, systemCount: number): AutelExtraction {
  const e = extraction(0); e.vehicle.make = make; e.systems = []; e.dtcs = [];
  for (const [code, codes] of groups) {
    const name = `Modulo ${code}`;
    e.systems.push({ code, name, dtcCount: codes.length });
    for (const dtc of codes) e.dtcs.push({ code: dtc, moduleCode: code, moduleName: name,
      descriptionOriginal: `Descripcion sintetica de ${dtc}`, statusOriginal: "DTC permanente", status: "permanent", classification: "actionable" });
  }
  while (e.systems.length < systemCount) { const i = e.systems.length; e.systems.push({ code: `Z${i}`, name: `Modulo vacio ${i}`, dtcCount: 0 }); }
  e.scanSummary = { declaredSystems: systemCount, parsedSystems: systemCount, declaredDtcs: e.dtcs.length, parsedDtcs: e.dtcs.length };
  return e;
}
