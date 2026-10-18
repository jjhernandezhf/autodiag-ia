import { readFileSync } from "node:fs";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { DiagnosticAnalysisService } from "./ai-analysis-service.js";
import { createPdfContentToken } from "./analysis-fingerprint.js";
import type { AuthenticationService } from "./auth-service.js";
import { createApp, type AppOptions } from "./app.js";
import {
  DiagnosticHistoryService,
  type DiagnosticHistoryRepository,
  type HistoryCaptureContext,
} from "./diagnostic-history.js";
import { RagRetrievalService } from "./rag-service.js";
import { ragProvenanceSchema } from "./rag-provenance.js";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const REPORT_ID = "33333333-3333-4333-8333-333333333333";
const HISTORY_ID = "44444444-4444-4444-8444-444444444444";
const SECRET = "synthetic-history-secret-with-32-bytes";

const input = {
  vehicle: { make: "Marca", model: "Modelo", year: 2025 },
  modules: [{
    code: "PCM",
    name: "Módulo motriz",
    dtcs: [{ code: "P0300", description: "Fallo de encendido sintético", status: "current", alsoHistorical: false }],
  }],
  observations: "Vibración al acelerar.",
} as const;

const output = {
  technicalSummary: "Se requiere comprobar el sistema de encendido.",
  findings: [{
    relatedDtc: { code: "P0300", moduleCode: "PCM", moduleName: "Módulo motriz" },
    priority: "high",
    simpleExplanation: "El DTC requiere comprobaciones profesionales.",
    possibleCauses: ["Conexión eléctrica deficiente"],
    recommendedChecks: ["Comprobar alimentación y señal"],
    safetyWarnings: ["Trabajar con el vehículo inmovilizado"],
    confidence: "medium",
  }],
  observationCorrelation: {
    status: "matches_found",
    summary: "La observación podría relacionarse con el DTC.",
    matches: [{
      relatedDtc: { code: "P0300", moduleCode: "PCM", moduleName: "Módulo motriz" },
      observation: "Vibración al acelerar.",
      possibleRelation: "Puede guardar relación sin confirmar causalidad.",
      confidence: "low",
    }],
  },
  safetyWarnings: ["Confirmar el diagnóstico antes de sustituir componentes"],
  confidence: "medium",
  requiresTechnicianConfirmation: true,
} as const;

const historyContext: HistoryCaptureContext = {
  reportReference: REPORT_ID,
  contentToken: createPdfContentToken(Buffer.from("%PDF-synthetic-history"), SECRET, USER_A),
  extraction: {
    status: "completed",
    format: "autel_vehicle_diagnostic_report",
    requiresManualReview: false,
    vehicle: {
      year: 2025,
      make: "Marca",
      model: "Modelo",
      engine: "Motor sintético",
      odometer: { value: 123_456, unit: "km" },
      vinMasked: "*************6789",
      vinPseudonym: `vin_v1_${"a".repeat(64)}`,
    },
    scanSummary: { declaredSystems: 1, parsedSystems: 1, declaredDtcs: 1, parsedDtcs: 1 },
    systems: [{ code: "PCM", name: "Módulo motriz", dtcCount: 1 }],
    dtcs: [{
      code: "P0300",
      moduleCode: "PCM",
      moduleName: "Módulo motriz",
      status: "current",
      statusOriginal: "Actual",
      classification: "actionable",
      descriptionOriginal: "Fallo de encendido sintético",
    }],
    warnings: [],
  },
};

const authentication: AuthenticationService = {
  login: vi.fn(),
  authenticate: async (token) => ({
    id: token === "user-b-token" ? USER_B : USER_A,
    username: token === "user-b-token" ? "usuario.b" : "usuario.a",
  }),
};

function createMemoryRepository(options: { failInsert?: boolean; legacyUploadUniqueness?: boolean } = {}) {
  const rows: Array<Record<string, unknown> & { user_id: string }> = [];
  const insert = vi.fn<DiagnosticHistoryRepository["insert"]>(async (userId, record) => {
    if (options.failInsert) throw new Error("synthetic persistence failure");
    const existing = rows.find((row) =>
      row.user_id === userId &&
      record.analysisFingerprint !== null &&
      row.analysis_fingerprint === record.analysisFingerprint
    );
    if (existing) return { id: String(existing.id), reused: true };
    if (rows.some((row) => row.user_id === userId && row.report_reference === record.reportReference &&
      (options.legacyUploadUniqueness || (record.analysisFingerprint === null && row.analysis_fingerprint === null)))) {
      throw Object.assign(new Error("synthetic unique conflict"), { code: "23505" });
    }
    const id = rows.length === 0 ? HISTORY_ID : `44444444-4444-4444-8444-${String(rows.length).padStart(12, "0")}`;
    rows.push({
      id,
      user_id: userId,
      created_at: "2026-10-04T12:00:00.000Z",
      report_reference: record.reportReference,
      content_fingerprint: record.contentFingerprint,
      analysis_fingerprint: record.analysisFingerprint,
      make: record.make,
      model: record.model,
      year: record.year,
      odometer_value: record.odometer?.value ?? null,
      odometer_unit: record.odometer?.unit ?? null,
      dtc_count: record.dtcCodes.length,
      rag_status: record.ragStatus,
      extraction_snapshot: record.extractionSnapshot,
      analysis_snapshot: record.analysisSnapshot,
      rag_snapshot: record.ragSnapshot,
      analysis_model: record.analysisModel,
      embedding_model: record.embeddingModel,
      schema_version: 1,
    });
    return { id };
  });
  const repository: DiagnosticHistoryRepository = {
    insert,
    async list(userId, limit) {
      const own = rows.filter((row) => row.user_id === userId).slice(0, limit);
      return {
        rows: own.map((row) => ({
          id: row.id,
          created_at: row.created_at,
          report_reference: row.report_reference,
          make: row.make,
          model: row.model,
          year: row.year,
          odometer_value: row.odometer_value,
          odometer_unit: row.odometer_unit,
          dtc_count: row.dtc_count,
          rag_status: row.rag_status,
        })),
        hasMore: false,
      };
    },
    async findById(userId, id) {
      const found = rows.find((row) => row.user_id === userId && row.id === id);
      if (!found) return null;
      const row: Record<string, unknown> = { ...found };
      delete row.user_id;
      delete row.content_fingerprint;
      delete row.analysis_fingerprint;
      return row;
    },
    async findIdByAnalysisFingerprint(userId, fingerprint) {
      const found = rows.find((row) => row.user_id === userId && row.analysis_fingerprint === fingerprint);
      return found ? { id: found.id } : null;
    },
  };
  return { rows, insert, service: new DiagnosticHistoryService(repository) };
}

function createTestApp(
  historyService: DiagnosticHistoryService,
  generate = vi.fn(async () => JSON.stringify(output)),
  overrides: Partial<AppOptions> = {},
) {
  return {
    generate,
    app: createApp({
      vinHmacSecret: SECRET,
      authenticationService: authentication,
      analysisService: new DiagnosticAnalysisService({ generate }, "synthetic-analysis-model", 1_000),
      openAiModel: "synthetic-analysis-model",
      openAiEmbeddingModel: "text-embedding-3-small",
      historyService,
      ragEnabled: false,
      ...overrides,
    }),
  };
}

function analyze(app: ReturnType<typeof createApp>, body: unknown = { input, historyContext }) {
  return request(app)
    .post("/api/reports/analyze")
    .set("Authorization", "Bearer user-a-token")
    .set("Idempotency-Key", "11111111-1111-4111-8111-111111111111")
    .send(body);
}

describe("integración HTTP del historial", () => {
  it("conserva alcance en prompt, respuesta y snapshot sin llamadas nuevas al abrir historial", async () => {
    const provenance = ragProvenanceSchema.parse(JSON.parse(readFileSync(new URL("../../../fixtures/rag-provenance.synthetic.json", import.meta.url), "utf8")));
    const memory = createMemoryRepository();
    const createEmbeddings = vi.fn(async () => [Array.from({ length: 1536 }, () => 0)]);
    const matchKnowledge = vi.fn(async () => [{
      id: USER_B, title: "Fuente sintética", source_label: "Resumen sintético",
      source_url: "https://example.test/manual", content: "Evidencia ficticia para probar el transporte.",
      metadata: { reviewStatus: "approved", provenance: JSON.stringify(provenance) }, similarity: 0.9,
    }]);
    const ragService = new RagRetrievalService({ createEmbeddings }, { matchKnowledge },
      { embeddingModel: "fixture", timeoutMs: 1000, matchCount: 3, matchThreshold: 0.7, maxContextCharacters: 6000 });
    const generate = vi.fn<(...args: unknown[]) => Promise<string>>(async () => JSON.stringify(output));
    const { app } = createTestApp(memory.service, generate, { ragEnabled: true, ragService });
    const response = await analyze(app);
    expect(response.status).toBe(200);
    expect(response.body.rag.sources[0].provenance).toEqual(provenance);
    expect(generate.mock.calls[0]?.[0]).toMatchObject({ knowledgeContext: expect.stringContaining(JSON.stringify(provenance)) });
    const detail = await request(app).get(`/api/history/${HISTORY_ID}`).set("Authorization", "Bearer user-a-token");
    expect(detail.status).toBe(200);
    expect(detail.body.history.snapshot.rag.sources[0].provenance).toEqual(provenance);
    expect(createEmbeddings).toHaveBeenCalledOnce(); expect(matchKnowledge).toHaveBeenCalledOnce();
    expect(generate).toHaveBeenCalledOnce(); expect(memory.insert).toHaveBeenCalledOnce();
    expect(JSON.stringify(response.body.rag)).not.toContain("reviewStatus");
  });

  it("separa default y low del mismo modelo y recupera cada variante tras reiniciar", async () => {
    const memory = createMemoryRepository();
    const make = (reasoningEffort: "low" | undefined) => {
      const generate = vi.fn(async (request: unknown) => {
        void request;
        return JSON.stringify({ ...output,
          technicalSummary: reasoningEffort === "low" ? "Resultado de evaluación low." : "Resultado de referencia default." });
      });
      const { app } = createTestApp(memory.service, generate, {
        openAiModel: "gpt-6.1-sol", openAiReasoningEffort: reasoningEffort,
        analysisService: new DiagnosticAnalysisService({ generate }, "gpt-6.1-sol", 1_000, { reasoningEffort }),
      });
      return { app, generate };
    };
    const reference = make(undefined);
    const first = await analyze(reference.app);
    const evaluation = make("low");
    const second = await analyze(evaluation.app);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.history.status).toBe("saved");
    expect(second.body.history.status).toBe("saved");
    expect(second.body.history.id).not.toBe(first.body.history.id);
    expect(second.body.analysis).not.toEqual(first.body.analysis);
    expect(reference.generate).toHaveBeenCalledOnce();
    expect(evaluation.generate).toHaveBeenCalledOnce();
    expect(reference.generate.mock.calls[0]![0]).not.toHaveProperty("reasoningEffort");
    expect(evaluation.generate.mock.calls[0]![0]).toHaveProperty("reasoningEffort", "low");
    for (const [effort, expected] of [["low", second], [undefined, first]] as const) {
      const restarted = make(effort);
      const recovered = await analyze(restarted.app);
      expect(recovered.status).toBe(200);
      expect(recovered.body.reused).toBe(true);
      expect(recovered.body.history).toEqual(expected.body.history);
      expect(recovered.body.analysis).toEqual(expected.body.analysis);
      expect(restarted.generate).not.toHaveBeenCalled();
    }
    expect(memory.rows).toHaveLength(2);
    expect(memory.insert).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])("modela restricciones nuevas y antiguas (legacy=%s) para variantes y reinicio", async (legacyUploadUniqueness) => {
    const memory = createMemoryRepository({ legacyUploadUniqueness });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const variants = ["Vibración al acelerar.", "Vibración en reposo."];
      const generate = vi.fn(async (request) => JSON.stringify({ ...output, technicalSummary: request.observations }));
      const { app } = createTestApp(memory.service, generate);
      const post = (target: typeof app, index: number) => request(target).post("/api/reports/analyze")
        .set("Authorization", "Bearer user-a-token")
        .set("Idempotency-Key", `77777777-7777-4777-8777-${String(index + 1).padStart(12, "0")}`)
        .send({ input: { ...input, observations: variants[index] }, historyContext });
      const first = await post(app, 0);
      const second = await post(app, 1);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(generate).toHaveBeenCalledTimes(2);
      expect(memory.rows).toHaveLength(legacyUploadUniqueness ? 1 : 2);
      expect(first.body.history.status).toBe("saved");
      expect(second.body.history.status).toBe(legacyUploadUniqueness ? "unavailable" : "saved");
      if (!legacyUploadUniqueness) {
        expect(first.body.history.id).not.toBe(second.body.history.id);
        const restarted = createTestApp(memory.service);
        for (const index of [0, 1]) {
          const repeated = await post(restarted.app, index);
          expect(repeated.status).toBe(200);
          expect(repeated.body.reused).toBe(true);
          expect(repeated.body.analysis.technicalSummary).toBe(variants[index]);
          expect(repeated.body.history.id).toBe(index === 0 ? first.body.history.id : second.body.history.id);
        }
        expect(restarted.generate).not.toHaveBeenCalled();
        expect(memory.insert).toHaveBeenCalledTimes(2);
      }
    } finally { warning.mockRestore(); }
  });

  it("conserva unicidad legacy por propietario y no confunde variantes con la referencia", async () => {
    const memory = createMemoryRepository();
    const value = { context: historyContext, input: structuredClone(input), analysis: structuredClone(output),
      rag: { enabled: false, used: false, status: "disabled", querySummary: "RAG desactivado.", sources: [] },
      analysisModel: "synthetic-analysis-model", embeddingModel: null };
    await memory.service.save(USER_A, value as never);
    await expect(memory.service.save(USER_A, value as never)).rejects.toMatchObject({ code: "HISTORY_UNAVAILABLE" });
    await memory.service.save(USER_B, value as never);
    expect(memory.rows).toHaveLength(2);
    expect(memory.service).not.toHaveProperty("findByReportReference");
    expect(await memory.service.findByAnalysisFingerprint(USER_A, `analysis_v1_${"f".repeat(64)}`)).toBeNull();
  });

  it("guarda el análisis exitoso con el usuario autenticado y lista solo sus filas", async () => {
    const memory = createMemoryRepository();
    const { app } = createTestApp(memory.service);
    const response = await analyze(app);
    expect(response.status).toBe(200);
    expect(response.body.history).toEqual({ status: "saved", id: HISTORY_ID });
    expect(memory.insert).toHaveBeenCalledOnce();
    expect(memory.insert.mock.calls[0]![0]).toBe(USER_A);
    expect(JSON.stringify(memory.rows[0])).not.toMatch(/originalName|filename|sha256|rawText|access_token|refresh_token/iu);

    const own = await request(app).get("/api/history").set("Authorization", "Bearer user-a-token");
    const other = await request(app).get("/api/history").set("Authorization", "Bearer user-b-token");
    expect(own.status).toBe(200);
    expect(own.body.items).toHaveLength(1);
    expect(JSON.stringify(own.body)).not.toMatch(/content_fingerprint|analysis_fingerprint|pdf_v1_|analysis_v1_/iu);
    expect(other.status).toBe(200);
    expect(other.body.items).toEqual([]);
  });

  it("recrea el coordinador y recupera por huella persistente sin repetir IA, embeddings, RAG ni historial", async () => {
    const memory = createMemoryRepository();
    const first = createTestApp(memory.service);
    expect((await analyze(first.app)).status).toBe(200);

    const generate = vi.fn(async () => JSON.stringify(output));
    const retrieve = vi.fn();
    const restarted = createTestApp(memory.service, generate, {
      ragEnabled: false,
      ragService: { retrieve },
    });
    const secondContext = {
      ...historyContext,
      reportReference: "55555555-5555-4555-8555-555555555555",
    };
    const response = await request(restarted.app)
      .post("/api/reports/analyze")
      .set("Authorization", "Bearer user-a-token")
      .set("Idempotency-Key", "66666666-6666-4666-8666-666666666666")
      .send({ input, historyContext: secondContext });

    expect(response.status).toBe(200);
    expect(response.body.reused).toBe(true);
    expect(response.body.analysis).toEqual(output);
    expect(memory.rows).toHaveLength(1);
    expect(memory.insert).toHaveBeenCalledOnce();
    expect(generate).not.toHaveBeenCalled();
    expect(retrieve).not.toHaveBeenCalled();
  });

  it("oculta como no encontrado el historial de otro usuario", async () => {
    const memory = createMemoryRepository();
    const { app } = createTestApp(memory.service);
    await analyze(app);
    const response = await request(app)
      .get(`/api/history/${HISTORY_ID}`)
      .set("Authorization", "Bearer user-b-token");
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("HISTORY_NOT_FOUND");
  });

  it("rechaza UUID inválido y parámetros user_id suministrados por el cliente", async () => {
    const memory = createMemoryRepository();
    const { app, generate } = createTestApp(memory.service);
    const invalidId = await request(app).get("/api/history/no-es-uuid").set("Authorization", "Bearer user-a-token");
    const injectedQuery = await request(app).get(`/api/history?user_id=${USER_B}`).set("Authorization", "Bearer user-a-token");
    const injectedBody = await analyze(app, { ...input, user_id: USER_B });
    expect(invalidId.status).toBe(400);
    expect(invalidId.body.error.code).toBe("HISTORY_ID_INVALID");
    expect(injectedQuery.status).toBe(400);
    expect(injectedBody.status).toBe(400);
    expect(generate).not.toHaveBeenCalled();
  });

  it("mantiene HTTP 200 cuando falla la persistencia", async () => {
    const memory = createMemoryRepository({ failInsert: true });
    const { app } = createTestApp(memory.service);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = await analyze(app);
    expect(response.status).toBe(200);
    expect(response.body.analysis).toEqual(output);
    expect(response.body.history).toEqual({ status: "unavailable" });
    expect(warning).toHaveBeenCalledExactlyOnceWith("DIAGNOSTIC_HISTORY_SAVE_FAILED");
    warning.mockRestore();
  });

  it("limita y cancela un guardado pendiente sin bloquear el análisis exitoso", async () => {
    let receivedSignal: AbortSignal | undefined;
    const insert = vi.fn<DiagnosticHistoryRepository["insert"]>((_userId, _record, signal) => {
      receivedSignal = signal;
      return new Promise(() => undefined);
    });
    const historyService = new DiagnosticHistoryService({
      insert,
      list: vi.fn(async () => ({ rows: [], hasMore: false })),
      findById: vi.fn(async () => null),
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const { app } = createTestApp(historyService, undefined, { diagnosticHistorySaveTimeoutMs: 100 });

    const response = await analyze(app);

    expect(response.status).toBe(200);
    expect(response.body.analysis).toEqual(output);
    expect(response.body.history).toEqual({ status: "unavailable" });
    expect(insert).toHaveBeenCalledOnce();
    expect(receivedSignal?.aborted).toBe(true);
    const historyTimerIndex = setTimeoutSpy.mock.calls.findIndex((call) => call[1] === 100);
    const historyTimer = setTimeoutSpy.mock.results[historyTimerIndex]?.value;
    expect(historyTimerIndex).toBeGreaterThanOrEqual(0);
    expect(clearTimeoutSpy).toHaveBeenCalledWith(historyTimer);
    expect(warning).toHaveBeenCalledExactlyOnceWith("DIAGNOSTIC_HISTORY_SAVE_FAILED");
    setTimeoutSpy.mockRestore();
    clearTimeoutSpy.mockRestore();
    warning.mockRestore();
  });

  it("conserva el contrato anterior sin contexto de historial", async () => {
    const memory = createMemoryRepository();
    const { app } = createTestApp(memory.service);
    const response = await analyze(app, input);
    expect(response.status).toBe(200);
    expect(response.body.history).toEqual({ status: "unavailable" });
    expect(memory.insert).not.toHaveBeenCalled();
  });

  it("requiere autenticación y abrir historial no invoca análisis, embeddings ni RPC RAG", async () => {
    const memory = createMemoryRepository();
    const seed = createTestApp(memory.service);
    await analyze(seed.app);
    const createEmbeddings = vi.fn(async () => [Array.from({ length: 1_536 }, () => 0)]);
    const matchKnowledge = vi.fn(async () => []);
    const ragService = new RagRetrievalService(
      { createEmbeddings },
      { matchKnowledge },
      { matchCount: 4, matchThreshold: 0.7, maxContextCharacters: 6_000 },
    );
    const generate = vi.fn(async () => JSON.stringify(output));
    const { app } = createTestApp(memory.service, generate, { ragEnabled: true, ragService });
    generate.mockClear();
    const unauthenticated = await request(app).get("/api/history");
    const list = await request(app).get("/api/history").set("Authorization", "Bearer user-a-token");
    const detail = await request(app).get(`/api/history/${HISTORY_ID}`).set("Authorization", "Bearer user-a-token");
    expect(unauthenticated.status).toBe(401);
    expect(list.status).toBe(200);
    expect(detail.status).toBe(200);
    expect(detail.body.history.snapshot.analysis.output).toEqual(output);
    expect(generate).not.toHaveBeenCalled();
    expect(createEmbeddings).not.toHaveBeenCalled();
    expect(matchKnowledge).not.toHaveBeenCalled();
  });
});
