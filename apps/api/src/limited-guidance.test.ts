import { randomUUID } from "node:crypto";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { extractAutelReport } from "./autel-extraction.js";
import { prepareAiAnalysis } from "./ai-analysis-adapter.js";
import { DiagnosticAnalysisService, OpenAiResponsesClient } from "./ai-analysis-service.js";
import { createAnalysisFingerprint, createPdfContentToken } from "./analysis-fingerprint.js";
import { createExtractionToken, reviewReport, verifyExtractionToken } from "./report-review.js";
import { buildHistoryInsertRecord, DiagnosticHistoryService, type DiagnosticHistoryRepository } from "./diagnostic-history.js";
import type { AutelExtraction } from "./report-types.js";
import type { DiagnosticAnalysisInput } from "./ai-analysis-types.js";
import { buildReportExportModel, validateReportExportModel } from "../../web/src/report-pdf.js";
import { incompatibleWithVehicle } from "./rag-provenance.js";

const secret = "synthetic-limited-guidance-secret-at-least-32-bytes";
const user = "11111111-1111-4111-8111-111111111111", other = "22222222-2222-4222-8222-222222222222";
const why = "Revisado contra el documento sintetico; conserva limitaciones.";
function extraction(): AutelExtraction {
  return { format: "autel_vehicle_diagnostic_report", status: "partial", requiresManualReview: true,
    vehicle: { make: null, model: null, year: null, engine: null, odometer: null, vinMasked: null, vinPseudonym: null },
    systems: [], dtcs: [], scanSummary: { declaredSystems: null, declaredDtcs: null, parsedSystems: 0, parsedDtcs: 0 },
    warnings: [{ code: "VARIANT_NOT_PREVIOUSLY_SEEN", message: "Estructura nueva sin columnas reconocidas" }] };
}
function body(e = extraction()) {
  const report = randomUUID(), contentToken = createPdfContentToken(Buffer.from("%PDF-synthetic"), secret, user);
  return { mode: "limited_guidance_v1", reportReference: report, contentToken, extractionToken: createExtractionToken(e, user, report, contentToken, secret), extraction: e,
    vehicle: { make: null, model: null, year: null }, reason: why, acknowledgements: e.warnings.map(w => ({ code: w.code, reason: why })),
    rows: [{ sourceIndex: null as number | null, moduleIndex: null as number | null, moduleName: null as string | null, code: "X?77", description: "Descripcion literal sintetica",
      state: "reviewed_uncertain", reason: why, page: 1, line: 4 }] };
}
function output() {
  return { technicalSummary: "Orientacion limitada solo sobre filas revisadas.", findings: [{ relatedDtc: "D001", priority: "low", simpleExplanation: "Dato incierto por comprobar.",
    possibleCauses: ["No se confirma una causa"], recommendedChecks: ["Obtener identificacion y documentacion antes de procedimientos especificos"], safetyWarnings: ["Revision profesional necesaria"], confidence: "low" }],
    observationCorrelation: { status: "not_provided", summary: "Sin observaciones", matches: [] }, safetyWarnings: ["Reporte posiblemente incompleto"], confidence: "low", requiresTechnicianConfirmation: true };
}
describe("contingencia Autel limitada", () => {
  it("conserva un código literal corto no normalizado sin exigir caracteres inventados", () => {
    const b = body(); b.rows[0]!.code = "7";
    const reviewed = reviewReport(b, user, secret)!;
    expect(reviewed).not.toBeNull(); expect(reviewed.extraction.dtcs[0]!.code).toBe("7");
    expect(reviewed.extraction.review!.limited!.limitations.some(s => s.includes("código literal no reconocido"))).toBe(true);
  });
  it("un vehículo desconocido no autoriza evidencia específica ni duplicados con módulo desconocido", () => {
    expect(incompatibleWithVehicle({ applicability: "unknown", make: "Mazda", model: null, year: null } as never, { make: null, model: null, year: null })).toBe(true);
    const b = body(); b.rows.push({ ...b.rows[0]! });
    expect(reviewReport(b, user, secret)).toBeNull();
  });
  it.each(["caducada", "51_identidades", "201_observaciones", "secreto", "alteracion_original", "estado_sin_revision"])("rechaza mínimos o límites: %s", scenario => {
    const b = body();
    if (scenario === "caducada") b.extractionToken = createExtractionToken(b.extraction, user, b.reportReference, b.contentToken, secret, Date.now() - 1);
    if (scenario === "51_identidades") b.rows = Array.from({ length: 51 }, (_, i) => ({ ...b.rows[0]!, code: `X${i}` }));
    if (scenario === "201_observaciones") b.rows = Array.from({ length: 201 }, (_, i) => ({ ...b.rows[0]!, code: `X${i}` }));
    if (scenario === "secreto") b.reason = "Bearer synthetic-token-not-a-real-credential";
    if (scenario === "alteracion_original") b.extraction.scanSummary.declaredDtcs = 999;
    if (scenario === "estado_sin_revision") b.rows[0]!.state = "as_reported";
    expect(reviewReport(b, user, secret)).toBeNull();
  });
  it.each(["fila", "estado", "vehiculo", "conteos", "combinacion", "sin_estructura"])("conserva originales, ausencia y alcance: %s", scenario => {
    const e = extraction();
    if (scenario !== "sin_estructura") {
      e.systems = [{ code: "Z", name: "Sistema nuevo", dtcCount: 4 }];
      e.dtcs = [{ code: "X?77", moduleCode: "Z", moduleName: "Sistema nuevo", descriptionOriginal: "Descripcion literal sintetica", statusOriginal: "Memoria Z", status: "unknown", classification: "unknown" }];
      e.scanSummary = { declaredSystems: 3, parsedSystems: 1, declaredDtcs: 4, parsedDtcs: 1 };
    }
    const b = body(e);
    if (e.dtcs.length) { b.rows[0]!.sourceIndex = 0; b.rows[0]!.moduleIndex = 0; }
    const reviewed = reviewReport(b, user, secret)!;
    expect(reviewed).not.toBeNull(); expect(reviewed.extraction.status).toBe("partial"); expect(reviewed.extraction.requiresManualReview).toBe(true);
    expect(reviewed.extraction.vehicle.year).toBeNull(); expect(reviewed.extraction.scanSummary.declaredDtcs).toBe(e.scanSummary.declaredDtcs);
    expect(reviewed.extraction.review!.original.dtcs).toEqual(e.dtcs);
    expect(reviewed.analysisPreparation.available).toBe(true);
    expect(reviewed.extraction.review!.limited!.positions[0]).toMatchObject({ page: 1, line: 4, provenance: e.dtcs.length ? "parser_row_reviewed" : "manual_transcription" });
    expect(reviewed.extraction.dtcs[0]).toMatchObject({ code: "X?77", status: "reviewed_uncertain", statusOriginal: e.dtcs[0]?.statusOriginal ?? null });
  });
  it.each(["sin_motivo", "sin_pagina", "sin_filas", "sin_reconocimiento", "usuario_ajeno", "contenido_alterado", "duplicado"])("rechaza %s", scenario => {
    const b = body();
    if (scenario === "sin_motivo") b.rows[0]!.reason = "";
    if (scenario === "sin_pagina") b.rows[0]!.page = null as never;
    if (scenario === "sin_filas") b.rows = [];
    if (scenario === "sin_reconocimiento") b.acknowledgements = [];
    if (scenario === "contenido_alterado") b.contentToken = createPdfContentToken(Buffer.from("%PDF-other"), secret, user);
    if (scenario === "duplicado") { b.rows[0]!.moduleName = "Modulo transcrito"; b.rows.push({ ...b.rows[0]! }); }
    expect(reviewReport(b, scenario === "usuario_ajeno" ? other : user, secret)).toBeNull();
  });
  it("sustituye pruebas y separa fingerprints de límites/motivos; no admite DTO directo", async () => {
    const b = body(), a = reviewReport(b, user, secret)!;
    const next = { ...b, extraction: a.extraction, extractionToken: a.extractionToken, reason: why + " Otra revision." };
    const c = reviewReport(next, user, secret)!; expect(c).not.toBeNull();
    expect(verifyExtractionToken(a.extractionToken, a.extraction, user, b.reportReference, b.contentToken, secret)).toBeNull();
    const generate = vi.fn(); const app = createApp({ vinHmacSecret: secret, analysisService: { analyze: generate } as never,
      authenticationService: { login: vi.fn(), authenticate: async () => ({ id: user, username: "synthetic" }) } });
    if (!a.analysisPreparation.available || !c.analysisPreparation.available) throw new Error("Synthetic limited preparation failed");
    const input = c.analysisPreparation.input;
    expect((await request(app).post("/api/reports/analyze").set("Authorization", "Bearer synthetic").set("Idempotency-Key", randomUUID()).send(input)).status).toBe(400);
    expect(generate).not.toHaveBeenCalled();
    const fp = (value: DiagnosticAnalysisInput) => createAnalysisFingerprint({ contentFingerprint: "pdf_v1_" + "a".repeat(64), input: value,
      extraction: {}, analysisModel: "synthetic", promptVersion: "v6", outputSchemaVersion: "schema_v1", embeddingModel: "synthetic-embedding",
      corpusVersion: "demonstration_corpus_v1", rag: { enabled: false, matchCount: 4, matchThreshold: 0.7, maxContextCharacters: 6000 } }, secret);
    expect(prepareAiAnalysis(c.extraction).available).toBe(true);
    expect(fp(input)).not.toBe(fp(a.analysisPreparation.input));
    expect(fp(input)).toBe(fp(structuredClone(input)));
  });
  it("admite texto Autel legible sin estructura pero no un PDF ajeno o error de extracción", async () => {
    const pages = [{ pageNumber: 1, lines: [{ text: "AUTEL MaxiSys Diagnostic DTC X?77", y: 30, fragments: [] }] }];
    const e = await extractAutelReport(Buffer.from("synthetic"), secret, async () => pages);
    expect(e.status).toBe("partial"); expect(e.warnings.some(w => w.code === "MANUAL_TRANSCRIPTION_REQUIRED")).toBe(true);
    await expect(extractAutelReport(Buffer.from("synthetic"), secret, async () => [{ pageNumber: 1, lines: [{ text: "Documento ajeno", y: 30, fragments: [] }] }])).rejects.toMatchObject({ code: "AUTEL_FORMAT_NOT_RECOGNIZED" });
    await expect(extractAutelReport(Buffer.from("synthetic"), secret, async () => { throw new Error("synthetic extraction failure"); })).rejects.toThrow("synthetic extraction failure");
  });
  it("la vía manual explícita mantiene tipo no confirmado, autenticación, prueba y rechazo sin texto", async () => {
    const pages = [{ pageNumber: 1, lines: [{ text: "Texto legible cuya estructura no fue reconocida", y: 30, fragments: [] }] }];
    const e = await extractAutelReport(Buffer.from("synthetic"), secret, async () => pages, true);
    expect(e.status).toBe("partial"); expect(e.warnings.some(w => w.code === "DOCUMENT_TYPE_UNCONFIRMED")).toBe(true);
    await expect(extractAutelReport(Buffer.from("synthetic"), secret, async () => [], true)).rejects.toMatchObject({ code: "AUTEL_FORMAT_NOT_RECOGNIZED" });
    const app = createApp({ vinHmacSecret: secret, extractPdfPages: async () => pages,
      authenticationService: { login: vi.fn(), authenticate: async () => ({ id: user, username: "synthetic" }) } });
    const post = () => request(app).post("/api/reports/upload-manual");
    expect((await post().attach("report", Buffer.from("%PDF-synthetic"), { filename: "synthetic.pdf", contentType: "application/pdf" })).status).toBe(401);
    const response = await post().set("Authorization", "Bearer synthetic").attach("report", Buffer.from("%PDF-synthetic"), { filename: "synthetic.pdf", contentType: "application/pdf" });
    expect(response.status).toBe(201); expect(response.body.extraction.status).toBe("partial"); expect(response.body.analysisPreparation.available).toBe(false);
    expect(verifyExtractionToken(response.body.extractionToken, response.body.extraction, user, response.body.id, response.body.contentToken, secret)).not.toBeNull();
  });
  it("la vía manual no convierte un cero DTC completo en una oportunidad de inventar códigos", async () => {
    const texts = ["Informe de diagnostico de vehiculo", "Informacion del vehiculo", "2024/Marca/Modelo/", "Sistema/s escaneado/s (0)", "Sistema Estado/DTC", "DTC (0)", "DTC Descripcion Estado"];
    const pages = [{ pageNumber: 1, lines: texts.map((text, i) => ({ text, y: 700 - i * 30, fragments: [{ text, x: 20, width: 100 }] })) }];
    const zero = await extractAutelReport(Buffer.from("synthetic"), secret, async () => pages, true);
    expect(zero).toMatchObject({ status: "completed", requiresManualReview: false, dtcs: [], scanSummary: { declaredDtcs: 0, parsedDtcs: 0 } });
    expect(prepareAiAnalysis(zero).available).toBe(false);
    expect(reviewReport(body(zero), user, secret)).toBeNull();
  });
  it.each([true, false])("recorrido HTTP → Responses simulado → historial/PDF, migración simulada disponible: %s", async migrated => {
    const b = body();
    const create = vi.fn(async () => ({ status: "completed", output: [], output_text: JSON.stringify(output()) }));
    const service = new DiagnosticAnalysisService(new OpenAiResponsesClient("synthetic-key", { responses: { create } } as never), "synthetic", 1000);
    let stored: ReturnType<typeof buildHistoryInsertRecord> | undefined;
    const historyId = randomUUID();
    const repository: DiagnosticHistoryRepository = { insert: vi.fn(async (_user, record) => {
      stored = record;
      if (!migrated) throw Object.assign(new Error("synthetic-private-sql-detail"), { code: "23502" });
      return { id: historyId };
    }), list: vi.fn(),
      findById: vi.fn(async () => ({ id: historyId, created_at: new Date().toISOString(), report_reference: b.reportReference,
        make: stored!.make, model: stored!.model, year: stored!.year, odometer_value: null, odometer_unit: null, dtc_count: 1,
        rag_status: stored!.ragStatus, extraction_snapshot: stored!.extractionSnapshot, analysis_snapshot: stored!.analysisSnapshot, rag_snapshot: stored!.ragSnapshot,
        analysis_model: stored!.analysisModel, embedding_model: null, schema_version: 1 })) };
    const history = new DiagnosticHistoryService(repository);
    const app = createApp({ vinHmacSecret: secret, openAiModel: "synthetic", analysisService: service, historyService: history,
      authenticationService: { login: vi.fn(), authenticate: async () => ({ id: user, username: "synthetic" }) } });
    const reviewed = await request(app).post("/api/reports/review").set("Authorization", "Bearer synthetic").send(b);
    expect(reviewed.status).toBe(200); expect(create).not.toHaveBeenCalled();
    const context = { reportReference: b.reportReference, contentToken: b.contentToken, extractionToken: reviewed.body.extractionToken, extraction: reviewed.body.extraction };
    const result = await request(app).post("/api/reports/analyze").set("Authorization", "Bearer synthetic").set("Idempotency-Key", randomUUID()).send({ input: reviewed.body.analysisPreparation.input, historyContext: context });
    expect(result.status).toBe(200); expect(result.body.history.status).toBe(migrated ? "saved" : "unavailable"); expect(repository.insert).toHaveBeenCalledOnce();
    if (!migrated) {
      expect(result.body.analysis.technicalSummary).toContain("limitada");
      expect(JSON.stringify(result.body)).not.toMatch(/23502|synthetic-private-sql-detail/u);
      expect(repository.findById).not.toHaveBeenCalled(); expect(create).toHaveBeenCalledOnce();
      return;
    }
    const wire = JSON.stringify(create.mock.calls[0]); expect(wire).toContain("limited_guidance_v1"); expect(wire).toContain("manual_transcription"); expect(wire).not.toContain(b.extractionToken); expect(wire).not.toContain(user);
    expect(stored!.year).toBeNull(); expect(stored!.extractionSnapshot.status).toBe("partial");
    const detail = await history.get(user, historyId); expect(detail.snapshot.extraction.review!.limited).toEqual(stored!.extractionSnapshot.review!.limited);
    const input = detail.snapshot.analysis.input;
    const model = buildReportExportModel({ review: detail.snapshot.extraction.review, vehicle: detail.vehicle,
      counts: { systems: 1, detected: 1, actionable: 1, historical: 0 }, actionableModules: input.modules,
      documentaryDtcs: detail.snapshot.extraction.dtcs.map(d => ({ code: d.code, moduleCode: d.moduleCode, moduleName: d.moduleName,
        description: d.descriptionOriginal, originalStatus: d.statusOriginal, normalizedClassification: d.classification })),
      analysis: detail.snapshot.analysis.output, rag: detail.snapshot.rag, submittedObservations: "" });
    expect(() => validateReportExportModel(model)).not.toThrow(); expect(model.review!.limited!.coverage).toBe("reviewed_rows_only");
    expect(create).toHaveBeenCalledOnce();
  });
});
