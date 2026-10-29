import { randomUUID } from "node:crypto";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { createPdfContentToken } from "./analysis-fingerprint.js";
import { fingerprintAnalysisRequest } from "./analysis-coordinator.js";
import { createExtractionToken, reviewReport, verifyExtractionToken } from "./report-review.js";
import { DiagnosticAnalysisService, OpenAiResponsesClient } from "./ai-analysis-service.js";
import { buildHistoryInsertRecord } from "./diagnostic-history.js";
import type { AutelExtraction } from "./report-types.js";

const secret = "synthetic-progressive-review-secret-at-least-32-bytes";
const user = "11111111-1111-4111-8111-111111111111";
function extraction(count = 3): AutelExtraction {
  return { format: "autel_vehicle_diagnostic_report", status: "completed", requiresManualReview: false,
    vehicle: { make: "Marca técnica", model: "Modelo genérico", year: 2024, engine: null, odometer: null, vinMasked: null, vinPseudonym: null },
    systems: [{ code: "SYS", name: "Sistema documentado", dtcCount: count }],
    dtcs: Array.from({ length: count }, (_, i) => ({ code: `P${String(i + 1).padStart(4, "0")}`, moduleCode: "SYS", moduleName: "Sistema documentado",
      descriptionOriginal: `Descripción técnica sintética ${i}`, status: "current", statusOriginal: "Corriente", classification: "actionable" })),
    scanSummary: { declaredSystems: 1, parsedSystems: 1, declaredDtcs: count, parsedDtcs: count }, warnings: [] };
}
function body(e = extraction()) {
  const reportReference = randomUUID(), contentToken = createPdfContentToken(Buffer.from("%PDF-synthetic"), secret, user);
  return { mode: "progressive_review_v1", reportReference, contentToken,
    extractionToken: createExtractionToken(e, user, reportReference, contentToken, secret), extraction: e };
}
function reviewed(value: unknown) { const r = reviewReport(value, user, secret); if (!r) throw new Error("Synthetic review failed"); return r; }
describe("revisión progresiva genérica, sin retranscripción ni motivos libres", () => {
  it("omite mínimos ilegibles sin perder originales ni el subconjunto útil", () => {
    const e = extraction(); e.dtcs[0]!.descriptionOriginal = "   "; e.dtcs[1]!.code = "???";
    const r = reviewed(body(e));
    expect(r.extraction.dtcs).toEqual([e.dtcs[2]]);
    expect(r.extraction.review!.original.dtcs).toEqual(e.dtcs);
    expect(r.extraction.review!.limited!.omittedRows?.map(row => row.sourceIndex)).toEqual([0, 1]);
    expect(r.analysisPreparation.available).toBe(true);
  });
  it.each(["año", "varios_datos", "estado", "fila_incompleta", "literal", "conteos", "parcial", "combinación"])("conserva intactos y permite continuar: %s", variant => {
    const e = extraction();
    if (["año", "varios_datos", "combinación"].includes(variant)) e.vehicle.year = null;
    if (variant === "varios_datos") { e.vehicle.make = null; e.vehicle.model = null; }
    if (["estado", "combinación"].includes(variant)) Object.assign(e.dtcs[1]!, { status: "unknown", statusOriginal: "Estado Z sin normalizar", classification: "unknown" });
    if (["fila_incompleta", "combinación"].includes(variant)) { e.dtcs[1]!.code = ""; e.dtcs[1]!.descriptionOriginal = ""; }
    if (variant === "literal") e.dtcs[1]!.code = "7?";
    if (["conteos", "combinación"].includes(variant)) { e.scanSummary.declaredDtcs = 9; e.systems[0]!.dtcCount = 9; }
    if (["parcial", "combinación"].includes(variant)) { e.status = "partial"; e.requiresManualReview = true; e.warnings = [{ code: "UNSEEN_COMBINED_WARNING", message: "Faltan campos y estructura" }]; }
    const r = reviewed(body(e)); expect(r.analysisPreparation.available).toBe(true);
    expect(r.extraction.dtcs[0]).toEqual(e.dtcs[0]); expect(r.extraction.dtcs.at(-1)).toEqual(e.dtcs.at(-1));
    expect(r.extraction.review?.original.dtcs).toEqual(e.dtcs);
    expect(r.extraction.scanSummary.declaredDtcs).toBe(e.scanSummary.declaredDtcs);
    expect(r.extraction.status).toBe("partial");
    expect(r.extraction.review!.reason).not.toContain("consultada por el usuario");
    if (variant === "fila_incompleta" || variant === "combinación") expect(r.extraction.review!.limited!.omittedRows).toEqual([{ sourceIndex: 1, reason: "missing_technical_minimum" }]);
    if (variant === "estado") expect(r.extraction.dtcs[1]).toMatchObject({ status: "reviewed_uncertain", statusOriginal: "Estado Z sin normalizar" });
    if (variant === "literal") {
      expect(r.extraction.dtcs[1]).toMatchObject({ code: "7?", status: "current", statusOriginal: "Corriente" });
      expect(r.extraction.review!.limited!.limitations.some(s => s.includes("código literal no reconocido"))).toBe(true);
    }
  });
  it("reporte completo: no exige otra confirmación, no cambia datos ni rota innecesariamente la prueba", () => {
    const b = body(), r = reviewed(b); expect(r.extraction).toEqual(b.extraction); expect(r.extractionToken).toBe(b.extractionToken);
    expect(r.analysisPreparation.available).toBe(true); expect(r.extraction.review).toBeUndefined();
  });
  it("corrige únicamente una fila; no exige motivos y conserva código/estado/módulo de las demás", () => {
    const e = extraction(); e.dtcs[1]!.descriptionOriginal = "";
    const b = body(e), r = reviewed({ ...b, actions: [{ sourceIndex: 1, description: "Descripción aportada" }] });
    expect(r.extraction.dtcs[1]!.descriptionOriginal).toBe("Descripción aportada");
    expect(r.extraction.dtcs.filter((_row, i) => i !== 1)).toEqual(e.dtcs.filter((_row, i) => i !== 1));
    expect(r.extraction.review!.decisions).toContainEqual(expect.objectContaining({ path: "rows.1.description", before: "", after: "Descripción aportada" }));
  });
  it("continúa con parte útil, registra omisiones explícitas y conserva todas las filas originales", () => {
    const e = extraction(); e.status = "partial"; e.dtcs[1]!.descriptionOriginal = "";
    const r = reviewed({ ...body(e), actions: [{ sourceIndex: 2, action: "omit" }] });
    expect(r.extraction.dtcs.map(d => d.code)).toEqual(["P0001"]);
    expect(r.extraction.review!.original.dtcs).toHaveLength(3);
    expect(r.extraction.review!.limited!.omittedRows).toEqual([{ sourceIndex: 1, reason: "missing_technical_minimum" }, { sourceIndex: 2, reason: "excluded_by_user" }]);
    expect(r.extraction.review!.limited!.positions[0]?.sourceIndex).toBe(0);
  });
  it("no elige arbitrariamente descripciones contradictorias; conserva otra identidad útil", () => {
    const e = extraction(); e.dtcs[1]!.code = e.dtcs[0]!.code;
    const r = reviewed(body(e)); expect(r.extraction.dtcs.map(d => d.code)).toEqual(["P0003"]);
    expect(r.extraction.review!.limited!.omittedRows?.every(row => row.reason === "description_conflict")).toBe(true);
  });
  it("normalizar manualmente la etiqueta de un estado desconocido no lo convierte automáticamente en activo", () => {
    const e = extraction(); Object.assign(e.dtcs[1]!, { status: "unknown", statusOriginal: "Etiqueta Z", classification: "unknown" });
    const r = reviewed({ ...body(e), actions: [{ sourceIndex: 1, statusOriginal: "Corriente" }] });
    expect(r.extraction.dtcs[1]).toMatchObject({ status: "reviewed_uncertain", statusOriginal: "Corriente" });
    expect(r.extraction.review!.original.dtcs[1]!.statusOriginal).toBe("Etiqueta Z");
  });
  it("preserva el módulo literal y su código aunque la asociación del parser no exista", () => {
    const e = extraction(); e.systems = []; e.scanSummary.parsedSystems = 0;
    const r = reviewed(body(e)); expect(r.extraction.dtcs[0]).toEqual(e.dtcs[0]);
  });
  it("no inventa orientación sin DTC, con solo notas de síntomas o con cero DTC legítimo", () => {
    expect(reviewReport({ ...body(extraction(0)), notes: "Vibración al acelerar" }, user, secret)).toBeNull();
    expect(reviewReport({ ...body(extraction(0)), additionalRows: [{ code: "P0300", description: "Dato inventado para cero" }] }, user, secret)).toBeNull();
    const insufficient = extraction(1); insufficient.dtcs[0]!.descriptionOriginal = "";
    expect(reviewReport(body(insufficient), user, secret)).toBeNull();
    const historical = extraction(); historical.dtcs.forEach(d => Object.assign(d, { status: "history", statusOriginal: "Histórico", classification: "historical" }));
    expect(reviewReport(body(historical), user, secret)).toBeNull();
  });
  it("transcribe solo información ausente sin página ni motivos obligatorios y la conserva en otra revisión", () => {
    const e = extraction(0); e.status = "partial"; e.requiresManualReview = true; e.scanSummary.declaredDtcs = null;
    const b = body(e), first = reviewed({ ...b, additionalRows: [{ code: "X?9", description: "Texto técnico transcrito" }] });
    expect(first.extraction.dtcs[0]).toMatchObject({ code: "X?9", descriptionOriginal: "Texto técnico transcrito", status: "reviewed_uncertain" });
    const next = reviewed({ ...b, extraction: first.extraction, extractionToken: first.extractionToken, notes: "Nota opcional" });
    expect(next.extraction.dtcs).toEqual(first.extraction.dtcs);
    expect(next.extraction.review!.limited!.userNotes).toBe("Nota opcional");
    expect(verifyExtractionToken(first.extractionToken, first.extraction, user, b.reportReference, b.contentToken, secret)).toBeNull();
    expect(fingerprintAnalysisRequest(first.extraction)).not.toBe(fingerprintAnalysisRequest(next.extraction));
    const cleared = reviewed({ ...b, extraction: next.extraction, extractionToken: next.extractionToken, notes: "" });
    expect(cleared.extraction.review!.limited!.userNotes).toBe("");
  });
  it.each(["user", "report", "content", "original", "duplicate_action", "arbitrary_flag", "expired"])("rechaza manipulación: %s", scenario => {
    const e = extraction(); e.vehicle.year = null; const b = body(e);
    let requestValue: unknown = b;
    if (scenario === "report") b.reportReference = randomUUID();
    if (scenario === "content") b.contentToken = createPdfContentToken(Buffer.from("other"), secret, user);
    if (scenario === "original") b.extraction.dtcs[0]!.code = "P9999";
    if (scenario === "duplicate_action") requestValue = { ...b, actions: [{ sourceIndex: 0 }, { sourceIndex: 0 }] };
    if (scenario === "arbitrary_flag") requestValue = { ...b, ignoreValidation: true };
    if (scenario === "expired") b.extractionToken = createExtractionToken(e, user, b.reportReference, b.contentToken, secret, Date.now() - 1);
    expect(reviewReport(requestValue, scenario === "user" ? randomUUID() : user, secret)).toBeNull();
  });
  it("mantiene 50 identidades/200 observaciones sin escoger silenciosamente las primeras 50", () => {
    const b = body(extraction(51)); expect(reviewReport(b, user, secret)).toBeNull();
    const r = reviewed({ ...b, actions: [{ sourceIndex: 50, action: "omit" }] });
    expect(r.extraction.dtcs).toHaveLength(50); expect(r.extraction.review!.original.dtcs).toHaveLength(51);
    expect(reviewReport(body(extraction(201)), user, secret)).toBeNull();
  });
  it("Responses e historial reciben acciones/omisiones honestas; validar no genera IA", async () => {
    const e = extraction(); e.vehicle.year = null; e.dtcs[1]!.descriptionOriginal = "";
    const b = body(e); const create = vi.fn(async () => ({ status: "completed", output: [], output_text: JSON.stringify({
      technicalSummary: "Orientación parcial sintética", findings: ["D001", "D002"].map(id => ({ relatedDtc: id, priority: "low", simpleExplanation: "Comprobar con información limitada",
        possibleCauses: ["No hay causa confirmada"], recommendedChecks: ["Obtener documentación antes de procedimientos específicos"], safetyWarnings: ["Verificación técnica necesaria"], confidence: "low" })),
      observationCorrelation: { status: "not_provided", summary: "Sin observaciones", matches: [] }, safetyWarnings: ["Conjunto parcial"], confidence: "low", requiresTechnicianConfirmation: true }) }));
    const save = vi.fn(async (_user, value) => { const record = buildHistoryInsertRecord(value); expect(record.extractionSnapshot.review!.limited!.omittedRows).toHaveLength(1); return { id: randomUUID() }; });
    const app = createApp({ vinHmacSecret: secret, openAiModel: "synthetic", historyService: { save } as never,
      analysisService: new DiagnosticAnalysisService(new OpenAiResponsesClient("synthetic-key", { responses: { create } } as never), "synthetic", 1000),
      authenticationService: { login: vi.fn(), authenticate: async () => ({ id: user, username: "synthetic" }) } });
    expect((await request(app).post("/api/reports/review").send(b)).status).toBe(401);
    const review = await request(app).post("/api/reports/review").set("Authorization", "Bearer synthetic").send(b);
    expect(review.status).toBe(200); expect(create).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
    const result = await request(app).post("/api/reports/analyze").set("Authorization", "Bearer synthetic").set("Idempotency-Key", randomUUID()).send({
      input: review.body.analysisPreparation.input, historyContext: { reportReference: b.reportReference, contentToken: b.contentToken, extractionToken: review.body.extractionToken, extraction: review.body.extraction } });
    expect(result.status).toBe(200); expect(result.body.history.status).toBe("saved"); expect(create).toHaveBeenCalledOnce();
    const wire = JSON.stringify(create.mock.calls[0]); expect(wire).toContain("omittedRows"); expect(wire).toContain("missing_technical_minimum");
    expect(wire).not.toContain("P0002"); expect(wire).not.toContain(b.extractionToken); expect(wire).not.toContain(user);
  });
});
