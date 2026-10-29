import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, type AppOptions } from "./app.js";
import { AiAnalysisError, DiagnosticAnalysisService, OpenAiResponsesClient } from "./ai-analysis-service.js";
import { createPdfContentToken } from "./analysis-fingerprint.js";
import { createExtractionToken, ReportProofRegistry, ReportValidationCapacityError, reviewReport, verifyExtractionToken } from "./report-review.js";
import type { AutelExtraction } from "./report-types.js";

const secret = "synthetic-regression-only-secret-at-least-32-bytes";
const user = "11111111-1111-4111-8111-111111111111";
const other = "33333333-3333-4333-8333-333333333333";
const reason = "Evidencia tecnica sintetica consultada por el usuario.";
function extraction(): AutelExtraction {
  return { format: "autel_vehicle_diagnostic_report", status: "completed", requiresManualReview: false,
    vehicle: { make: "Marca", model: "Modelo", year: 2020, engine: null, odometer: null, vinMasked: null, vinPseudonym: null },
    scanSummary: { declaredSystems: 1, parsedSystems: 1, declaredDtcs: 1, parsedDtcs: 1 }, systems: [{ code: "PCM", name: "Modulo", dtcCount: 1 }],
    dtcs: [{ code: "P0000", moduleCode: "PCM", moduleName: "Modulo", descriptionOriginal: "Descripcion original", status: "current", statusOriginal: "Actual", classification: "actionable" }], warnings: [] };
}
const input = { vehicle: { make: "Marca", model: "Modelo", year: 2020 },
  modules: [{ code: "PCM", name: "Modulo", dtcs: [{ code: "P0000", description: "Descripcion original", status: "current", alsoHistorical: false }] }] };
const output = { technicalSummary: "Resumen sintetico", findings: [{ relatedDtc: { code: "P0000", moduleCode: "PCM", moduleName: "Modulo" },
  priority: "low", simpleExplanation: "Explicacion", possibleCauses: ["Posibilidad"], recommendedChecks: ["Revision"], safetyWarnings: ["Precaucion"], confidence: "low" }],
  observationCorrelation: { status: "not_provided", summary: "Sin observaciones", matches: [] }, safetyWarnings: ["Orientacion"], confidence: "low", requiresTechnicianConfirmation: true };
const ragResult = { metadata: { enabled: true, used: false, status: "no_matches", querySummary: "Consulta sintetica", sources: [] }, evidence: [] };
function fixture(overrides: Partial<AppOptions> = {}) {
  const e = extraction(), reportReference = randomUUID();
  const contentToken = createPdfContentToken(Buffer.from("%PDF-synthetic"), secret, user);
  const context = { reportReference, contentToken, extraction: e, extractionToken: createExtractionToken(e, user, reportReference, contentToken, secret) };
  const analyze = vi.fn(async () => output), retrieve = vi.fn(async () => ragResult), save = vi.fn(async () => ({ id: randomUUID() }));
  const lookup = vi.fn(async () => null);
  const app = createApp({ vinHmacSecret: secret, openAiModel: "synthetic", ragEnabled: true,
    analysisService: { analyze } as never, ragService: { retrieve } as never,
    historyService: { save, findByAnalysisFingerprint: lookup } as never,
    authenticationService: { login: vi.fn(), authenticate: async token => ({ id: token === "other" ? other : user, username: "synthetic.user" }) }, ...overrides });
  return { app, context, analyze, retrieve, save, lookup };
}
function post(app: ReturnType<typeof createApp>, path: string, body: unknown, token = "synthetic") {
  return request(app).post(path).set("Authorization", `Bearer ${token}`).set("Idempotency-Key", randomUUID()).send(body);
}
function edit(context: ReturnType<typeof fixture>["context"], year = 2021) {
  return { ...context, vehicle: { ...input.vehicle, year }, reason,
    rows: [{ sourceIndex: 0, moduleIndex: 0, code: "P0000", description: "Descripcion original", state: "as_reported", reason }] };
}
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve };
}
afterEach(() => vi.restoreAllMocks());

describe("cuatro defectos reproducidos: autoridad y evidencia", () => {
  it("rechaza DTO directo, wrapper y pruebas omitidas antes de IA, RAG o historial", async () => {
    const f = fixture();
    for (const body of [input, { input }, { input, historyContext: { ...f.context, extractionToken: undefined } }]) {
      const r = await post(f.app, "/api/reports/analyze", body);
      expect(r.status).toBe(400); expect(r.body.error.code).toBe("AI_INPUT_INVALID");
    }
    for (const spy of [f.analyze, f.retrieve, f.save, f.lookup]) expect(spy).not.toHaveBeenCalled();
  });
  it("un upload completo ya valida el reporte sin obligar a editarlo", async () => {
    const e = extraction();
    const line = (text: string) => ({ text, y: 0, fragments: [{ text, x: 20, width: 100 }] });
    const f = fixture({ extractPdfPages: async () => [{ pageNumber: 1, lines: [line("Informe de diagnostico de vehiculo"), line("Informacion del vehiculo"),
      line("2020/Marca/Modelo/"), line("Sistema/s escaneado/s (1)"), line("Sistema Estado/DTC"), line("PCM(Modulo) 1"), line("DTC (1)"),
      line("PCM(Modulo) (1 DTC)"), { text: "DTC Descripcion Estado", y: 0, fragments: [{ text: "DTC", x: 20, width: 30 }, { text: "Descripcion", x: 105, width: 100 }, { text: "Estado", x: 430, width: 50 }] },
      { text: "P0000 Descripcion original Actual", y: 0, fragments: [{ text: "P0000", x: 20, width: 70 }, { text: e.dtcs[0]!.descriptionOriginal, x: 105, width: 200 }, { text: "Actual", x: 430, width: 80 }] },
    ] }] });
    const upload = await request(f.app).post("/api/reports/upload").set("Authorization", "Bearer synthetic")
      .attach("report", Buffer.from("%PDF-1.7\nsynthetic\n%%EOF"), { filename: "synthetic.pdf", contentType: "application/pdf" });
    expect(upload.status).toBe(201); expect(upload.body.analysisPreparation.available).toBe(true);
    expect(upload.body.extraction.review).toBeUndefined();
    expect(f.analyze).not.toHaveBeenCalled(); expect(f.retrieve).not.toHaveBeenCalled();
    const r = await post(f.app, "/api/reports/analyze", { input: upload.body.analysisPreparation.input, historyContext: {
      reportReference: upload.body.id, contentToken: upload.body.contentToken, extractionToken: upload.body.extractionToken, extraction: upload.body.extraction } });
    expect(r.status).toBe(200); expect(f.analyze).toHaveBeenCalledOnce(); expect(f.save).toHaveBeenCalledOnce();
  });
  it("A sustituida por B no vuelve a analizar ni puede publicar otra revisión; concurrencia CAS", async () => {
    const f = fixture();
    const A = await post(f.app, "/api/reports/review", edit(f.context, 2021)); expect(A.status).toBe(200);
    const contextA = { ...f.context, extraction: A.body.extraction, extractionToken: A.body.extractionToken };
    const results = await Promise.all([2022, 2023].map(year => post(f.app, "/api/reports/review", edit(contextA, year))));
    expect(results.map(r => r.status).sort()).toEqual([200, 400]);
    const B = results.find(r => r.status === 200)!;
    expect((await post(f.app, "/api/reports/analyze", { input: A.body.analysisPreparation.input, historyContext: contextA })).status).toBe(400);
    expect((await post(f.app, "/api/reports/review", edit(contextA, 2024))).status).toBe(400);
    for (const spy of [f.analyze, f.retrieve, f.save, f.lookup]) expect(spy).not.toHaveBeenCalled();
    expect((await post(f.app, "/api/reports/analyze", { input: B.body.analysisPreparation.input,
      historyContext: { ...f.context, extraction: B.body.extraction, extractionToken: B.body.extractionToken } })).status).toBe(200);
  });
  it("cambiar contenido invalida pruebas previas y volver al contenido original no las revive", async () => {
    const f = fixture();
    const nextContent = createPdfContentToken(Buffer.from("%PDF-different-synthetic"), secret, user);
    createExtractionToken(f.context.extraction, user, f.context.reportReference, nextContent, secret);
    expect((await post(f.app, "/api/reports/analyze", { input, historyContext: f.context })).status).toBe(400);
    const renewed = createExtractionToken(f.context.extraction, user, f.context.reportReference, f.context.contentToken, secret);
    expect(renewed).not.toBe(f.context.extractionToken);
    expect((await post(f.app, "/api/reports/analyze", { input, historyContext: f.context })).status).toBe(400);
    expect((await post(f.app, "/api/reports/analyze", { input, historyContext: { ...f.context, extractionToken: renewed } })).status).toBe(200);
  });
  it("B equivalente y vigente no hereda el fallo de autorización de una A pendiente", async () => {
    const started = deferred<void>(), gate = deferred<null>();
    const lookup = vi.fn().mockImplementationOnce(async () => { started.resolve(); return gate.promise; }).mockResolvedValue(null);
    const save = vi.fn(async () => ({ id: randomUUID() }));
    const f = fixture({ historyService: { findByAnalysisFingerprint: lookup, save } as never });
    const A = await post(f.app, "/api/reports/review", edit(f.context)); expect(A.status).toBe(200);
    const contextA = { ...f.context, extraction: A.body.extraction, extractionToken: A.body.extractionToken };
    const pendingA = post(f.app, "/api/reports/analyze", { input: A.body.analysisPreparation.input, historyContext: contextA }).then(r => r);
    await started.promise;
    const B = await post(f.app, "/api/reports/review", edit(contextA)); expect(B.status).toBe(200);
    expect(B.body.analysisPreparation.input).toEqual(A.body.analysisPreparation.input);
    const current = await post(f.app, "/api/reports/analyze", { input: B.body.analysisPreparation.input,
      historyContext: { ...f.context, extraction: B.body.extraction, extractionToken: B.body.extractionToken } });
    expect(current.status).toBe(200); gate.resolve(null); expect((await pendingA).status).toBe(400);
    expect(f.analyze).toHaveBeenCalledOnce(); expect(save).toHaveBeenCalledOnce();
  });
  it.each(["history", "rag", "analysis"])("sustituir revisión durante %s impide iniciar la etapa externa siguiente", async stage => {
    const started = deferred<void>(), done = deferred<unknown>();
    const lookup = vi.fn(async () => { if (stage === "history") { started.resolve(); return done.promise; } return null; });
    const retrieve = vi.fn(async () => { if (stage === "rag") { started.resolve(); return done.promise; } return ragResult; });
    const analyze = vi.fn(async () => { started.resolve(); return done.promise; }), save = vi.fn();
    const f = fixture({ historyService: { findByAnalysisFingerprint: lookup, save } as never,
      ragService: { retrieve } as never, analysisService: { analyze } as never });
    const pending = post(f.app, "/api/reports/analyze", { input, historyContext: f.context }).then(r => r);
    await started.promise;
    expect((await post(f.app, "/api/reports/review", edit(f.context))).status).toBe(200);
    done.resolve(stage === "history" ? null : stage === "rag" ? ragResult : output);
    expect((await pending).status).toBe(400); expect(save).not.toHaveBeenCalled();
    if (stage === "history") expect(retrieve).not.toHaveBeenCalled();
    if (stage !== "analysis") expect(analyze).not.toHaveBeenCalled(); else expect(analyze).toHaveBeenCalledOnce();
  });
  it("registro acotado, sin expulsar pruebas vigentes; reinicio falla cerrado y caducidad libera espacio", () => {
    const registry = new ReportProofRegistry(1), e = extraction(), report = randomUUID(), now = Date.now(), expires = now + 1000;
    const token = registry.issue(e, user, report, "synthetic-content", secret, expires)!;
    expect(registry.verify(token, e, user, report, "synthetic-content", secret, expires)).toBe(true);
    expect(new ReportProofRegistry(1).verify(token, e, user, report, "synthetic-content", secret, expires)).toBe(false);
    expect(() => registry.issue(e, user, randomUUID(), "synthetic-content", secret, expires)).toThrow(ReportValidationCapacityError);
    expect(registry.verify(token, e, user, report, "synthetic-content", secret, expires)).toBe(true);
    vi.spyOn(Date, "now").mockReturnValue(expires + 1);
    expect(registry.verify(token, e, user, report, "synthetic-content", secret, expires)).toBe(false);
    expect(registry.issue(e, user, randomUUID(), "synthetic-content", secret, expires + 2000)).not.toBeNull();
  });
  it.each(["before_physical", "before_retry"])("comprueba vigencia justo antes de una llamada física: %s", async phase => {
    const f = fixture();
    const guard = () => {
      if (verifyExtractionToken(f.context.extractionToken, f.context.extraction, user, f.context.reportReference, f.context.contentToken, secret) === null) throw new AiAnalysisError("AI_INPUT_INVALID");
    };
    const generate = vi.fn(async () => { throw new AiAnalysisError("OPENAI_UNAVAILABLE", { retryable: true, category: "transport" }); });
    const supersede = () => expect(reviewReport(edit(f.context), user, secret)).not.toBeNull();
    const service = new DiagnosticAnalysisService({ generate }, "synthetic", 1000, { wait: async () => { supersede(); }, log: vi.fn() });
    const pending = service.analyze(input, [], undefined, Date.now() + 10000, undefined, guard);
    if (phase === "before_physical") supersede();
    await expect(pending).rejects.toMatchObject({ code: "AI_INPUT_INVALID" });
    expect(generate).toHaveBeenCalledTimes(phase === "before_physical" ? 0 : 1);
  });
  it("Responses recibe originales, efectivos, motivos por fila y procedencia manual, sin campos privados", async () => {
    const e = extraction(); e.dtcs[0]!.status = "unknown"; e.dtcs[0]!.statusOriginal = "1 vez"; e.dtcs[0]!.classification = "unknown";
    e.status = "partial"; e.requiresManualReview = true; e.warnings = [{ code: "UNKNOWN_DTC_STATUS", message: "Estado sin interpretar" }];
    e.vehicle.vinMasked = "*************1234"; e.vehicle.vinPseudonym = `vin_v1_${"a".repeat(64)}`;
    const report = randomUUID(), contentToken = createPdfContentToken(Buffer.from("%PDF-synthetic"), secret, user);
    const result = reviewReport({ reportReference: report, contentToken, extractionToken: createExtractionToken(e, user, report, contentToken, secret), extraction: e,
      vehicle: input.vehicle, reason, rows: [{ sourceIndex: 0, moduleIndex: 0, code: "P0171", description: "Descripcion efectiva",
        state: "reviewed_uncertain", reason: "ROW_REASON_SENTINEL evidencia tecnica de fila." }] }, user, secret)!;
    if (!result.analysisPreparation.available) throw Error("Synthetic review");
    const create = vi.fn(async (body: unknown) => { void body; return { status: "completed", output: [], output_text: JSON.stringify({ ...output,
      findings: [{ ...output.findings[0], relatedDtc: "D001" }] }) }; });
    const service = new DiagnosticAnalysisService(new OpenAiResponsesClient("synthetic-only-key", { responses: { create } } as never), "synthetic", 1000);
    await service.analyze(result.analysisPreparation.input);
    const body = create.mock.calls[0]![0] as { input: Array<{ content: Array<{ text: string }> }> };
    const reportData = JSON.parse(body.input[0]!.content[0]!.text).report;
    expect(reportData.reviewContext).toMatchObject({ version: "review_context_v2", provenance: "user_review_unverified", reason,
      decisions: expect.arrayContaining([{ path: "rows.0.code", before: "P0000", after: "P0171", reason: "ROW_REASON_SENTINEL evidencia tecnica de fila." }]) });
    expect(reportData.modules[0].dtcs[0].observations[0].statusOriginal).toBe("1 vez");
    const wire = JSON.stringify(body);
    for (const privateValue of [secret, user, report, contentToken, result.extractionToken, "vin_v1_", "*************1234", "synthetic.user"]) expect(wire).not.toContain(privateValue);
    expect(verifyExtractionToken(result.extractionToken, result.extraction, user, report, contentToken, secret)).not.toBeNull();
  });
});
