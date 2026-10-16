import request from "supertest";
import OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AiAnalysisError, DiagnosticAnalysisService, OpenAiResponsesClient } from "./ai-analysis-service.js";
import { RagRetrievalService } from "./rag-service.js";
import { createPdfContentToken } from "./analysis-fingerprint.js";
import { createApp } from "./app.js";
import type { AuthenticationService } from "./auth-service.js";

const USER_A = "6a103df0-8e4d-4c51-89f5-7030c5443d89";
const USER_B = "c5fc96fa-6795-4e24-a76b-43d05cc81384";
const KEY = "11111111-1111-4111-8111-111111111111";
const SECRET = "synthetic-analysis-secret-at-least-32-bytes";
const input = {
  vehicle: { make: "Marca Sintética", model: "Modelo Sintético", year: 2025 },
  modules: [{
    code: "PCM",
    name: "Módulo sintético",
    dtcs: [{ code: "P0300", description: "Fallo sintético", status: "current", alsoHistorical: false }],
  }],
};
const output = {
  technicalSummary: "Resumen sintético sujeto a confirmación.",
  findings: [{
    relatedDtc: { code: "P0300", moduleCode: "PCM", moduleName: "Módulo sintético" },
    priority: "medium",
    simpleExplanation: "Condición sintética que requiere comprobación.",
    possibleCauses: ["Causa sintética posible."],
    recommendedChecks: ["Comprobar de forma segura."],
    safetyWarnings: ["Aplicar precauciones profesionales."],
    confidence: "medium",
  }],
  observationCorrelation: { status: "not_provided", summary: "Sin observaciones.", matches: [] },
  safetyWarnings: ["No sustituye el criterio técnico."],
  confidence: "medium",
  requiresTechnicianConfirmation: true,
};
const historyContext = {
  reportReference: "33333333-3333-4333-8333-333333333333",
  contentToken: createPdfContentToken(Buffer.from("%PDF-synthetic-report"), SECRET, USER_A),
  extraction: {
    status: "completed",
    format: "autel_vehicle_diagnostic_report",
    requiresManualReview: false,
    vehicle: {
      year: 2025,
      make: "Marca Sintética",
      model: "Modelo Sintético",
      engine: null,
      odometer: null,
      vinMasked: null,
      vinPseudonym: null,
    },
    scanSummary: { declaredSystems: 1, parsedSystems: 1, declaredDtcs: 1, parsedDtcs: 1 },
    systems: [{ code: "PCM", name: "Módulo sintético", dtcCount: 1 }],
    dtcs: [{
      code: "P0300",
      moduleCode: "PCM",
      moduleName: "Módulo sintético",
      status: "current",
      statusOriginal: "Current",
      classification: "actionable",
      descriptionOriginal: "Fallo sintético",
    }],
    warnings: [],
  },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

const authentication: AuthenticationService = {
  login: async () => ({ access_token: "synthetic", refresh_token: "synthetic" }),
  authenticate: async (token) => ({
    id: token === "user-b-token" ? USER_B : USER_A,
    username: token === "user-b-token" ? "usuario.b" : "usuario.a",
  }),
};

function send(app: ReturnType<typeof createApp>, key = KEY, body: unknown = input, token = "user-a-token") {
  return request(app)
    .post("/api/reports/analyze")
    .set("Authorization", `Bearer ${token}`)
    .set("Idempotency-Key", key)
    .send(body);
}

function testApp(overrides: Parameters<typeof createApp>[0] = { vinHmacSecret: "" }) {
  return createApp({
    vinHmacSecret: SECRET,
    authenticationService: authentication,
    ragEnabled: false,
    ...overrides,
  });
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

async function flushUntil(predicate: () => boolean) {
  for (let turn = 0; turn < 1_000 && !predicate(); turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  expect(predicate()).toBe(true);
}

describe("idempotencia HTTP del análisis", () => {
  it("conserva el análisis si no queda margen integral para un presupuesto completo de historial", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const save = vi.fn();
    const generate = vi.fn(async () => {
      vi.setSystemTime(Date.now() + 950);
      return JSON.stringify(output);
    });
    const app = testApp({ openAiModel: "synthetic-model", analysisTotalTimeoutMs: 1_000,
      diagnosticHistorySaveTimeoutMs: 100,
      analysisService: new DiagnosticAnalysisService({ generate }, "synthetic-model", 60_000),
      historyService: { findByAnalysisFingerprint: vi.fn(async () => null), save } as never });
    const response = await send(app, KEY, { input, historyContext });
    expect(response.status).toBe(200);
    expect(response.body.analysis).toEqual(output);
    expect(response.body.history).toEqual({ status: "unavailable" });
    expect(generate).toHaveBeenCalledOnce();
    expect(save).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["pending", "success", "failure"])("un solo presupuesto cubre inserción y ganador %s", async (mode) => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const insertion = deferred<{ id: string; reused: boolean }>();
      const winner = deferred<unknown>();
      const id = "22222222-2222-4222-8222-222222222222";
      const winnerAnalysis = { ...output, technicalSummary: "Resultado ganador validado." };
      const rag = { enabled: false, used: false, status: "disabled", querySummary: "RAG desactivado.", sources: [] };
      let winnerSignal: AbortSignal | undefined;
      const lookup = vi.fn().mockResolvedValueOnce(null).mockImplementationOnce(
        (_user: string, _fingerprint: string, signal: AbortSignal) => {
          winnerSignal = signal;
          return winner.promise;
        },
      );
      let saveSignal: AbortSignal | undefined;
      const save = vi.fn((_user: string, _record: unknown, signal: AbortSignal) => {
        saveSignal = signal;
        return insertion.promise;
      });
      const generate = vi.fn(async () => JSON.stringify(output));
      const app = testApp({ openAiModel: "synthetic-model", diagnosticHistorySaveTimeoutMs: 100,
        analysisTotalTimeoutMs: 1_000, analysisIdempotencyTtlMs: 1, analysisIdempotencyMaxEntries: 1,
        analysisService: new DiagnosticAnalysisService({ generate }, "synthetic-model", 60_000),
        historyService: { findByAnalysisFingerprint: lookup, save } as never });
      const responsePromise = send(app, KEY, { input, historyContext }).then((value) => value);
      await flushUntil(() => save.mock.calls.length === 1);
      await vi.advanceTimersByTimeAsync(60);
      insertion.resolve({ id, reused: true });
      await flushUntil(() => lookup.mock.calls.length === 2);
      expect(winnerSignal).toBeInstanceOf(AbortSignal);
      expect(winnerSignal).toBe(saveSignal);
      if (mode === "success") {
        winner.resolve({ id, snapshot: { analysis: { output: winnerAnalysis }, rag } });
      } else if (mode === "failure") {
        winner.reject(new Error("synthetic winner failure"));
      } else {
        // Only 40 ms remain: recovery must not receive a fresh 100 ms budget.
        await vi.advanceTimersByTimeAsync(40);
      }
      const response = await responsePromise;
      expect(response.status).toBe(200);
      expect(response.body.history).toEqual(mode === "success" ? { status: "saved", id } : { status: "unavailable" });
      expect(response.body.analysis).toEqual(mode === "success" ? winnerAnalysis : output);
      expect(response.body.reused).toBe(mode === "success");
      expect(save).toHaveBeenCalledOnce();
      expect(generate).toHaveBeenCalledOnce();
      expect(lookup).toHaveBeenCalledTimes(2);
      if (mode === "pending") {
        expect(winnerSignal?.aborted).toBe(true);
        await vi.advanceTimersByTimeAsync(1_001);
        const blocked = await send(app, "99999999-9999-4999-8999-999999999999", { ...input, observations: "Vibración." });
        expect(blocked.status).toBe(503);
        expect(blocked.body.error.code).toBe("ANALYSIS_CAPACITY_EXCEEDED");
        winner.reject(new Error("synthetic late rejection"));
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(unhandled).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally { process.off("unhandledRejection", unhandled); }
  });

  it("incomplete con JSON válido del SDK devuelve 502 sin persistir ni completar la caché", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({
      object: "response", status: "incomplete", incomplete_details: { reason: "max_output_tokens" },
      output: [{ type: "message", status: "incomplete", role: "assistant",
        content: [{ type: "output_text", text: JSON.stringify(output), annotations: [] }] }],
    }), { headers: { "content-type": "application/json" } }));
    const sdk = new OpenAI({ apiKey: "synthetic-test-key", maxRetries: 0, fetch });
    const validationLog = vi.fn();
    const save = vi.fn();
    const app = testApp({
      analysisService: new DiagnosticAnalysisService(new OpenAiResponsesClient("synthetic-test-key", sdk),
        "synthetic-model", 60_000, { validationLog }),
      openAiModel: "synthetic-model",
      historyService: { findByAnalysisFingerprint: vi.fn(async () => null), save } as never,
    });
    const body = { input, historyContext };
    const first = await send(app, KEY, body);
    expect(first.status).toBe(502);
    expect(first.body.error.code).toBe("OPENAI_RESPONSE_INVALID");
    expect(save).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
    expect(validationLog).toHaveBeenCalledWith("AI_ANALYSIS_VALIDATION_FAILED",
      expect.objectContaining({ reason: "INCOMPLETE", responseStatus: "incomplete" }));
    const manual = await send(app, KEY, body);
    expect(manual.status).toBe(502);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(save).not.toHaveBeenCalled();
  });

  it("ECONNRESET en el cuerpo recupera con embeddings, RPC e historial exactamente una vez", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockImplementationOnce(async () => new Response(new ReadableStream({
        start(controller) {
          controller.error(new TypeError("private detail", {
            cause: Object.assign(new Error("private cause"), { code: "ECONNRESET" }),
          }));
        },
      }), { headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        object: "response", status: "completed",
        output: [{ type: "message", status: "completed", role: "assistant",
          content: [{ type: "output_text", text: JSON.stringify(output), annotations: [] }] }],
      }), { headers: { "content-type": "application/json" } }));
    const sdk = new OpenAI({ apiKey: "synthetic-test-key", maxRetries: 0, fetch });
    const createEmbeddings = vi.fn(async () => [Array<number>(1_536).fill(0.01)]);
    const matchKnowledge = vi.fn(async () => []);
    const ragService = new RagRetrievalService({ createEmbeddings }, { matchKnowledge }, {
      embeddingModel: "text-embedding-3-small", matchCount: 3, matchThreshold: 0.7,
      maxContextCharacters: 2_000, timeoutMs: 2_000,
    });
    const save = vi.fn(async () => ({ id: "22222222-2222-4222-8222-222222222222", reused: false }));
    const app = testApp({
      analysisService: new DiagnosticAnalysisService(new OpenAiResponsesClient("synthetic-test-key", sdk),
        "synthetic-model", 60_000, { wait: async () => undefined, log: vi.fn() }),
      openAiModel: "synthetic-model", ragEnabled: true, ragService,
      historyService: { findByAnalysisFingerprint: vi.fn(async () => null), save } as never,
    });
    const body = { input, historyContext };
    const response = await send(app, KEY, body);
    expect(response.status).toBe(200);
    expect(response.body.analysis).toEqual(output);
    const reused = await send(app, "55555555-5555-4555-8555-555555555555", body);
    expect(reused.body).toEqual(response.body);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(createEmbeddings).toHaveBeenCalledOnce();
    expect(matchKnowledge).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledOnce();
  });

  it("dos solicitudes simultáneas y un reintento completado reutilizan IA, RAG e historial", async () => {
    const provider = deferred<string>();
    const generate = vi.fn(() => provider.promise);
    const retrieve = vi.fn(async () => ({
      metadata: { enabled: true, used: false, status: "no_matches", querySummary: "Sin coincidencias.", sources: [] },
      evidence: [],
    }));
    const save = vi.fn(async () => ({ id: "22222222-2222-4222-8222-222222222222", reused: false }));
    const historyService = {
      findByAnalysisFingerprint: vi.fn(async () => null),
      save,
    };
    const app = testApp({
      vinHmacSecret: "synthetic-analysis-secret-at-least-32-bytes",
      authenticationService: authentication,
      analysisService: new DiagnosticAnalysisService({ generate }, "synthetic-model", 60_000),
      ragEnabled: true,
      ragService: { retrieve },
      historyService: historyService as never,
      openAiModel: "synthetic-model",
    });

    const body = { input, historyContext };
    const first = send(app, KEY, body).then((response) => response);
    const second = send(app, KEY, body).then((response) => response);
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
    provider.resolve(JSON.stringify(output));
    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    const completedRetry = await send(app, KEY, body);

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.body).toEqual(firstResponse.body);
    expect(completedRetry.body).toEqual(firstResponse.body);
    expect(generate).toHaveBeenCalledOnce();
    expect(retrieve).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledOnce();
  });

  it("un HTTP 502 del proveedor reintenta solo la generación final y persiste una vez", async () => {
    const providerFailure = new AiAnalysisError("OPENAI_UNAVAILABLE", {
      retryable: true,
      providerStatus: 502,
      category: "provider_server",
    });
    const generate = vi.fn()
      .mockRejectedValueOnce(providerFailure)
      .mockResolvedValueOnce(JSON.stringify(output));
    const retrieve = vi.fn(async () => ({
      metadata: { enabled: true, used: false, status: "no_matches" as const, querySummary: "Sin coincidencias.", sources: [] },
      evidence: [],
    }));
    const save = vi.fn(async () => ({ id: "22222222-2222-4222-8222-222222222222", reused: false }));
    const app = testApp({
      analysisService: new DiagnosticAnalysisService({ generate }, "synthetic-model", 60_000, {
        wait: async () => undefined,
        log: vi.fn(),
      }),
      ragEnabled: true,
      ragService: { retrieve },
      historyService: { findByAnalysisFingerprint: vi.fn(async () => null), save } as never,
      openAiModel: "synthetic-model",
    });
    const body = { input, historyContext };

    const response = await send(app, KEY, body);
    const immediateReuse = await send(app, KEY, body);

    expect(response.status).toBe(200);
    expect(response.body.analysis).toEqual(output);
    expect(immediateReuse.body).toEqual(response.body);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(retrieve).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledOnce();
  });

  it("dos consumidores concurrentes comparten una sola secuencia de dos intentos", async () => {
    const secondAttempt = deferred<string>();
    const generate = vi.fn()
      .mockRejectedValueOnce(new AiAnalysisError("OPENAI_UNAVAILABLE", {
        retryable: true,
        providerStatus: 503,
        category: "provider_server",
      }))
      .mockImplementationOnce(() => secondAttempt.promise);
    const save = vi.fn(async () => ({ id: "22222222-2222-4222-8222-222222222222", reused: false }));
    const app = testApp({
      analysisService: new DiagnosticAnalysisService({ generate }, "synthetic-model", 60_000, {
        wait: async () => undefined,
        log: vi.fn(),
      }),
      historyService: { findByAnalysisFingerprint: vi.fn(async () => null), save } as never,
      openAiModel: "synthetic-model",
    });
    const body = { input, historyContext };

    const first = send(app, KEY, body).then((response) => response);
    const second = send(app, KEY, body).then((response) => response);
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
    secondAttempt.resolve(JSON.stringify(output));
    const responses = await Promise.all([first, second]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(responses[1]?.body).toEqual(responses[0]?.body);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenCalledOnce();
  });

  it("dos fallos temporales no persisten ni bloquean un reintento manual posterior", async () => {
    const providerFailure = new AiAnalysisError("OPENAI_UNAVAILABLE", {
      retryable: true,
      providerStatus: 503,
      category: "provider_server",
    });
    const generate = vi.fn()
      .mockRejectedValueOnce(providerFailure)
      .mockRejectedValueOnce(providerFailure)
      .mockResolvedValueOnce(JSON.stringify(output));
    const retrieve = vi.fn(async () => ({
      metadata: { enabled: true, used: false, status: "no_matches" as const, querySummary: "Sin coincidencias.", sources: [] },
      evidence: [],
    }));
    const save = vi.fn(async () => ({ id: "22222222-2222-4222-8222-222222222222", reused: false }));
    const app = testApp({
      analysisService: new DiagnosticAnalysisService({ generate }, "synthetic-model", 60_000, {
        wait: async () => undefined,
        log: vi.fn(),
      }),
      ragEnabled: true,
      ragService: { retrieve },
      historyService: { findByAnalysisFingerprint: vi.fn(async () => null), save } as never,
      openAiModel: "synthetic-model",
    });
    const body = { input, historyContext };

    const failed = await send(app, KEY, body);
    expect(failed.status).toBe(503);
    expect(failed.body).toEqual({
      error: { code: "OPENAI_UNAVAILABLE", message: "El servicio de orientación no está disponible temporalmente." },
    });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(save).not.toHaveBeenCalled();

    await new Promise<void>((resolve) => setImmediate(resolve));
    const retried = await send(app, KEY, body);
    expect(retried.status).toBe(200);
    expect(generate).toHaveBeenCalledTimes(3);
    expect(retrieve).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenCalledOnce();
  });

  it("dos cargas independientes con claves y reportReference distintos convergen por contenido", async () => {
    const provider = deferred<string>();
    const generate = vi.fn(() => provider.promise);
    const retrieve = vi.fn(async () => ({
      metadata: { enabled: true, used: false, status: "no_matches", querySummary: "Sin coincidencias.", sources: [] },
      evidence: [],
    }));
    const save = vi.fn(async () => ({ id: "22222222-2222-4222-8222-222222222222", reused: false }));
    const app = testApp({
      analysisService: new DiagnosticAnalysisService({ generate }, "synthetic-model", 60_000),
      ragEnabled: true,
      ragService: { retrieve },
      historyService: { findByAnalysisFingerprint: vi.fn(async () => null), save } as never,
      openAiModel: "synthetic-model",
    });
    const secondContext = {
      ...historyContext,
      reportReference: "44444444-4444-4444-8444-444444444444",
    };

    const first = send(app, KEY, { input, historyContext }).then((response) => response);
    const second = send(app, "55555555-5555-4555-8555-555555555555", {
      input,
      historyContext: secondContext,
    }).then((response) => response);
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
    provider.resolve(JSON.stringify(output));

    const responses = await Promise.all([first, second]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(generate).toHaveBeenCalledOnce();
    expect(retrieve).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledOnce();
  });

  it("normaliza observaciones vacías pero permite una operación nueva cuando cambia su contenido", async () => {
    const outputWithObservations = {
      ...output,
      observationCorrelation: { status: "no_clear_match" as const, summary: "Sin relación clara.", matches: [] },
    };
    const generate = vi.fn(async (request: { observations?: string }) =>
      JSON.stringify(request.observations === undefined ? output : outputWithObservations)
    );
    const app = testApp({
      analysisService: new DiagnosticAnalysisService({ generate }, "synthetic-model", 60_000),
      openAiModel: "synthetic-model",
      historyService: {
        findByAnalysisFingerprint: vi.fn(async () => null),
        save: vi.fn(async () => ({ id: "22222222-2222-4222-8222-222222222222", reused: false })),
      } as never,
    });

    expect((await send(app, KEY, { input, historyContext })).status).toBe(200);
    expect((await send(app, "77777777-7777-4777-8777-777777777777", {
      input: { ...input, observations: " \r\n\t " },
      historyContext,
    })).status).toBe(200);
    expect(generate).toHaveBeenCalledOnce();

    const changed = await send(app, "88888888-8888-4888-8888-888888888888", {
      input: { ...input, observations: " Ruido  leve\r\nal acelerar " },
      historyContext,
    });
    expect(changed.status).toBe(200);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1]![0].observations).toBe("Ruido  leve\nal acelerar");
  });

  it("aísla la misma clave entre usuarios y rechaza un payload diferente para el mismo usuario", async () => {
    const generate = vi.fn(async () => JSON.stringify(output));
    const app = testApp({
      vinHmacSecret: "synthetic-analysis-secret-at-least-32-bytes",
      authenticationService: authentication,
      analysisService: new DiagnosticAnalysisService({ generate }, "synthetic-model", 60_000),
    });

    expect((await send(app)).status).toBe(200);
    expect((await send(app, KEY, input, "user-b-token")).status).toBe(200);
    const conflict = await send(app, KEY, { ...input, observations: "Observación sintética distinta." });

    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("rechaza claves inválidas antes de invocar servicios costosos", async () => {
    const generate = vi.fn(async () => JSON.stringify(output));
    const app = testApp({
      vinHmacSecret: "synthetic-analysis-secret-at-least-32-bytes",
      authenticationService: authentication,
      analysisService: new DiagnosticAnalysisService({ generate }, "synthetic-model", 60_000),
    });
    const response = await send(app, "not-a-uuid");
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("IDEMPOTENCY_KEY_INVALID");
    expect(generate).not.toHaveBeenCalled();
  });

  it("rechaza un token de contenido manipulado antes de invocar servicios costosos", async () => {
    const generate = vi.fn(async () => JSON.stringify(output));
    const app = testApp({
      analysisService: new DiagnosticAnalysisService({ generate }, "synthetic-model", 60_000),
      openAiModel: "synthetic-model",
    });
    const token = historyContext.contentToken;
    const replacement = token.endsWith("0") ? "1" : "0";
    const response = await send(app, KEY, {
      input,
      historyContext: { ...historyContext, contentToken: `${token.slice(0, -1)}${replacement}` },
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("CONTENT_TOKEN_INVALID");
    expect(generate).not.toHaveBeenCalled();
  });

  it("recupera un resultado histórico después de reiniciar sin repetir IA, embeddings ni persistencia", async () => {
    const generate = vi.fn(async () => JSON.stringify(output));
    const retrieve = vi.fn();
    const save = vi.fn();
    const historyService = {
      findByAnalysisFingerprint: vi.fn(async () => ({
        id: "22222222-2222-4222-8222-222222222222",
        snapshot: {
          extraction: historyContext.extraction,
          analysis: { input, output },
          rag: { enabled: false, used: false, status: "disabled", querySummary: "RAG desactivado.", sources: [] },
        },
      })),
      save,
    };
    const app = testApp({
      vinHmacSecret: "synthetic-analysis-secret-at-least-32-bytes",
      authenticationService: authentication,
      analysisService: new DiagnosticAnalysisService({ generate }, "synthetic-model", 60_000),
      ragEnabled: true,
      ragService: { retrieve },
      historyService: historyService as never,
      openAiModel: "synthetic-model",
    });

    const response = await send(app, KEY, { input, historyContext });
    expect(response.status).toBe(200);
    expect(response.body.analysis).toEqual(output);
    expect(response.body.reused).toBe(true);
    expect(response.body.history).toEqual({ status: "saved", id: "22222222-2222-4222-8222-222222222222" });
    expect(generate).not.toHaveBeenCalled();
    expect(retrieve).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("una extracción distinta produce otra operación aunque conserve reportReference", async () => {
    const generate = vi.fn(async () => JSON.stringify(output));
    const historyService = {
      findByAnalysisFingerprint: vi.fn(async () => null),
      save: vi.fn(async () => ({ id: "22222222-2222-4222-8222-222222222222", reused: false })),
    };
    const app = testApp({
      vinHmacSecret: "synthetic-analysis-secret-at-least-32-bytes",
      authenticationService: authentication,
      analysisService: new DiagnosticAnalysisService({ generate }, "synthetic-model", 60_000),
      historyService: historyService as never,
      openAiModel: "synthetic-model",
    });
    const changedContext = {
      ...historyContext,
      extraction: {
        ...historyContext.extraction,
        scanSummary: { ...historyContext.extraction.scanSummary, declaredSystems: 2 },
      },
    };

    const response = await send(app, KEY, { input, historyContext: changedContext });

    expect(response.status).toBe(200);
    expect(generate).toHaveBeenCalledOnce();
    expect(historyService.save).toHaveBeenCalledOnce();
  });

  it("el presupuesto del backend aborta el adaptador y responde de forma controlada", async () => {
    let receivedSignal: AbortSignal | undefined;
    const generate = vi.fn((providerRequest) => new Promise<string>((_resolve, reject) => {
      receivedSignal = providerRequest.signal;
      providerRequest.signal?.addEventListener("abort", () => reject(providerRequest.signal?.reason), { once: true });
    }));
    const app = testApp({
      vinHmacSecret: "synthetic-analysis-secret-at-least-32-bytes",
      authenticationService: authentication,
      analysisService: new DiagnosticAnalysisService({ generate }, "synthetic-model", 60_000),
      analysisTotalTimeoutMs: 20,
    });

    const response = await send(app);
    expect(response.status).toBe(504);
    expect(response.body.error.code).toBe("ANALYSIS_TIMEOUT");
    expect(receivedSignal?.aborted).toBe(true);
    expect(generate).toHaveBeenCalledOnce();
  });

  it("un consumidor desconectado no cancela la operación y el reintento recupera el mismo resultado", async () => {
    const provider = deferred<string>();
    const generate = vi.fn(() => provider.promise);
    const app = testApp({
      vinHmacSecret: "synthetic-analysis-secret-at-least-32-bytes",
      authenticationService: authentication,
      analysisService: new DiagnosticAnalysisService({ generate }, "synthetic-model", 60_000),
    });
    const first = send(app);
    const firstResult = first.then(() => undefined, () => undefined);
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
    first.abort();
    const retry = send(app);
    provider.resolve(JSON.stringify(output));

    expect((await retry).status).toBe(200);
    await firstResult;
    expect(generate).toHaveBeenCalledOnce();
  });
});
