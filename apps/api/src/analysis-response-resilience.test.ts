import OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AiAnalysisError, DiagnosticAnalysisService, OpenAiResponsesClient } from "./ai-analysis-service.js";
import { AnalysisIdempotencyCoordinator, runWithAnalysisBudget } from "./analysis-coordinator.js";

const input = {
  vehicle: { make: "Marca", model: "Modelo", year: 2025 },
  modules: [{
    code: "PCM", name: "Motor",
    dtcs: [{ code: "P0300", description: "Fallo sintético", status: "current", alsoHistorical: false }],
  }],
};
const output = {
  technicalSummary: "Resumen sintético.",
  findings: [{
    relatedDtc: { code: "P0300", moduleCode: "PCM", moduleName: "Motor" },
    priority: "medium", simpleExplanation: "Requiere revisión.",
    possibleCauses: ["Causa posible."], recommendedChecks: ["Comprobar."],
    safetyWarnings: ["Aplicar precauciones."], confidence: "medium",
  }],
  observationCorrelation: { status: "not_provided", summary: "Sin observaciones.", matches: [] },
  safetyWarnings: ["Confirmar con técnico."], confidence: "medium",
  requiresTechnicianConfirmation: true,
};

function responseBody(status = "completed", text = JSON.stringify(output)) {
  return {
    object: "response", status,
    incomplete_details: status === "incomplete" ? { reason: "max_output_tokens" } : null,
    output: [{
      type: "message", role: "assistant", status: status === "incomplete" ? "incomplete" : "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    }],
  };
}

function jsonResponse(body = responseBody()) {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

function setup(fetch: typeof globalThis.fetch, timeoutMs = 60_000) {
  const sdk = new OpenAI({ apiKey: "synthetic-test-key", maxRetries: 0, fetch });
  const validationLog = vi.fn();
  const retryLog = vi.fn();
  const service = new DiagnosticAnalysisService(
    new OpenAiResponsesClient("synthetic-test-key", sdk),
    "synthetic-model", timeoutMs,
    { validationLog, log: retryLog, wait: async () => undefined },
  );
  return { service, validationLog, retryLog };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function controlledScheduler() {
  let clock = 0;
  const timers: Array<{ callback: () => void; delay: number; cleared: boolean }> = [];
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay: number) => {
    const timer = { callback, delay, cleared: false };
    timers.push(timer);
    return timer;
  }) as unknown as typeof setTimeout);
  vi.spyOn(globalThis, "clearTimeout").mockImplementation(((timer: typeof timers[number]) => {
    timer.cleared = true;
  }) as unknown as typeof clearTimeout);
  return { timers, setClock: (value: number) => { clock = value; } };
}

async function flushMicrotasks() {
  for (let turn = 0; turn < 50; turn += 1) await Promise.resolve();
}

describe("arbitraje absoluto compartido de timeouts", () => {
  for (const [totalMs, expected] of [[60_001, "OPENAI_TIMEOUT"], [59_999, "ANALYSIS_TIMEOUT"], [60_000, "ANALYSIS_TIMEOUT"]] as const) {
    it.each(["coordinator-first", "attempt-first"])(`propio 60000, integral ${totalMs}, callbacks retrasados: %s → ${expected}`, async (order) => {
      const scheduler = controlledScheduler();
      const physical = deferred<string>();
      const generate = vi.fn(() => physical.promise);
      const persist = vi.fn();
      const unhandled = vi.fn();
      process.on("unhandledRejection", unhandled);
      try {
        const service = new DiagnosticAnalysisService({ generate }, "synthetic-model", 60_000);
        const work = runWithAnalysisBudget(async (signal, deadline, observe) => {
          const analysis = await service.analyze(input, [], signal, deadline, observe);
          persist(analysis);
          return analysis;
        }, totalMs);
        const result = work.result.catch((error: unknown) => error);
        await flushMicrotasks();
        expect(generate).toHaveBeenCalledOnce();
        expect(scheduler.timers.map((timer) => timer.delay)).toEqual([totalMs, Math.min(totalMs, 60_000)]);
        scheduler.setClock(Math.max(totalMs, 60_000) + 1);
        const callbacks = order === "coordinator-first" ? scheduler.timers : [...scheduler.timers].reverse();
        for (const timer of callbacks) {
          timer.callback();
          await flushMicrotasks();
        }
        expect(await result).toMatchObject({ code: expected });
        expect(generate).toHaveBeenCalledOnce();
        expect(persist).not.toHaveBeenCalled();
        expect(scheduler.timers.every((timer) => timer.cleared)).toBe(true);
        physical.reject(new Error("synthetic late physical rejection"));
        await work.drained;
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(unhandled).not.toHaveBeenCalled();
      } finally { process.off("unhandledRejection", unhandled); }
    });
  }

  it("retira el deadline de un intento completado antes de continuar la operación", async () => {
    const scheduler = controlledScheduler();
    const afterAnalysis = deferred<void>();
    const generate = vi.fn(async () => JSON.stringify(output));
    const service = new DiagnosticAnalysisService({ generate }, "synthetic-model", 60_000);
    const work = runWithAnalysisBudget(async (signal, deadline, observe) => {
      await service.analyze(input, [], signal, deadline, observe);
      await afterAnalysis.promise;
    }, 80_000);
    const result = work.result.catch((error: unknown) => error);
    await flushMicrotasks();
    expect(scheduler.timers[1]!.cleared).toBe(true);
    scheduler.setClock(80_001);
    // Even an already-queued stale callback cannot restore the old attribution.
    scheduler.timers[1]!.callback();
    scheduler.timers[0]!.callback();
    expect(await result).toMatchObject({ code: "ANALYSIS_TIMEOUT" });
    afterAnalysis.resolve();
    await work.drained;
    expect(generate).toHaveBeenCalledOnce();
  });

  it("retira la atribución anterior al reintentar y no permite que un callback viejo contamine al sucesor", async () => {
    const scheduler = controlledScheduler();
    const second = deferred<string>();
    let active = 0;
    let maximumActive = 0;
    let attempts = 0;
    const generate = vi.fn(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      try {
        if (++attempts === 1) {
          scheduler.setClock(60_000);
          throw new AiAnalysisError("OPENAI_TIMEOUT", { retryable: true, category: "timeout" });
        }
        return await second.promise;
      } finally { active -= 1; }
    });
    const service = new DiagnosticAnalysisService({ generate }, "synthetic-model", 60_000, {
      wait: async () => { scheduler.setClock(60_750); }, log: vi.fn(),
    });
    const work = runWithAnalysisBudget((signal, deadline, observe) =>
      service.analyze(input, [], signal, deadline, observe), 80_000);
    const result = work.result.catch((error: unknown) => error);
    await flushMicrotasks();
    expect(generate).toHaveBeenCalledTimes(2);
    expect(maximumActive).toBe(1);
    expect(scheduler.timers.map((timer) => timer.delay)).toEqual([80_000, 60_000, 19_250]);
    scheduler.setClock(80_001);
    scheduler.timers[1]!.callback();
    scheduler.timers[0]!.callback();
    scheduler.timers[2]!.callback();
    expect(await result).toMatchObject({ code: "ANALYSIS_TIMEOUT" });
    second.reject(new Error("synthetic late rejection"));
    await work.drained;
    expect(generate).toHaveBeenCalledTimes(2);
    expect(active).toBe(0);
    expect(scheduler.timers.every((timer) => timer.cleared)).toBe(true);
  });

  it("mantiene cancelación explícita aunque un callback de timeout ya esté encolado", async () => {
    const scheduler = controlledScheduler();
    const physical = deferred<string>();
    const observed: Promise<unknown>[] = [];
    const generate = vi.fn(() => physical.promise);
    const controller = new AbortController();
    const service = new DiagnosticAnalysisService({ generate }, "synthetic-model", 60_000);
    const pending = service.analyze(input, [], controller.signal, 80_000, (work) => { observed.push(work); });
    const result = pending.catch((error: unknown) => error);
    await flushMicrotasks();
    scheduler.setClock(60_001);
    const cancellation = new DOMException("Synthetic cancellation", "AbortError");
    controller.abort(cancellation);
    scheduler.timers[0]!.callback();
    expect(await result).toBe(cancellation);
    expect(generate).toHaveBeenCalledOnce();
    physical.reject(new Error("synthetic late rejection"));
    await Promise.allSettled(observed);
    expect(scheduler.timers.every((timer) => timer.cleared)).toBe(true);
  });
});

describe("Responses SDK: finalización, cuerpo y exclusión física", () => {
  it.each(["integral-first", "attempt-first"])("clasifica el deadline con desfase de 1 ms y orden %s", async (order) => {
    vi.useFakeTimers();
    const physical = deferred<string>();
    const generate = vi.fn((request: unknown) => { void request; return physical.promise; });
    const service = new DiagnosticAnalysisService({ generate }, "synthetic-model", 60_000);
    let integralCallback!: () => void;
    let firstClockRead = true;
    const work = runWithAnalysisBudget((signal, deadline, observe) =>
      service.analyze(input, [], signal, deadline, observe), 20_000, {
      now: () => {
        const current = Date.now();
        if (firstClockRead) {
          firstClockRead = false;
          vi.advanceTimersByTime(1);
        }
        return current;
      },
      setTimeout: ((callback: () => void) => {
        integralCallback = callback;
        // Hold the outer callback to exercise either ordering deliberately.
        return setTimeout(() => undefined, 100_000);
      }) as typeof setTimeout,
    });
    const failure = expect(work.result).rejects.toMatchObject({ code: "ANALYSIS_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(0);
    expect(generate).toHaveBeenCalledOnce();
    expect(generate.mock.calls[0]![0]).toMatchObject({ timeoutMs: 19_999 });
    if (order === "integral-first") {
      vi.setSystemTime(Date.now() + 19_999);
      integralCallback();
    } else {
      await vi.advanceTimersByTimeAsync(19_999);
      integralCallback();
    }
    await failure;
    physical.reject(new Error("synthetic late rejection"));
    await work.drained;
    expect(generate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["incomplete", JSON.stringify(output), "INCOMPLETE"],
    ["completed", "", "EMPTY_OUTPUT"],
    ["completed", "   ", "EMPTY_OUTPUT"],
    ["queued", JSON.stringify(output), "UNEXPECTED_RESPONSE_STATUS"],
    ["unexpected-private-value", JSON.stringify(output), "UNEXPECTED_RESPONSE_STATUS"],
    ["completed", "{", "JSON_INVALID"],
    ["completed", "{}", "SCHEMA_INVALID"],
  ])("rechaza %s con motivo %s sin repetir fetch", async (status, text, reason) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(responseBody(status, text)));
    const { service, validationLog, retryLog } = setup(fetch);
    await expect(service.analyze(input)).rejects.toMatchObject({
      code: "OPENAI_RESPONSE_INVALID", validationReason: reason, retryable: false,
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(retryLog).not.toHaveBeenCalled();
    expect(validationLog).toHaveBeenCalledOnce();
    const [event, details] = validationLog.mock.calls[0]!;
    expect(event).toBe("AI_ANALYSIS_VALIDATION_FAILED");
    expect(details).toEqual({
      reason, attempt: 1, durationMs: expect.any(Number), remainingMs: expect.any(Number),
      ...(["INCOMPLETE", "EMPTY_OUTPUT", "UNEXPECTED_RESPONSE_STATUS"].includes(reason!)
        ? { responseStatus: status === "unexpected-private-value" ? "unknown" : status }
        : {}),
    });
    expect(JSON.stringify(details)).not.toContain("P0300");
    expect(JSON.stringify(details)).not.toContain("unexpected-private-value");
  });

  it("rechaza refusal aunque también exista texto válido", async () => {
    const body = responseBody();
    const content = body.output[0]!.content;
    const refusalBody = {
      ...body,
      output: [{ ...body.output[0], content: [...content, { type: "refusal", refusal: "private synthetic refusal" }] }],
    };
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify(refusalBody), {
      headers: { "content-type": "application/json" },
    }));
    const { service, validationLog } = setup(fetch);
    await expect(service.analyze(input)).rejects.toMatchObject({ validationReason: "REFUSAL" });
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.stringify(validationLog.mock.calls)).not.toContain("private synthetic refusal");
  });

  it("acepta completed y comparte dos fetch máximos entre claves equivalentes", async () => {
    const second = deferred<Response>();
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response('{"error":{"code":"synthetic"}}', {
        status: 502, headers: { "content-type": "application/json", "x-should-retry": "true" },
      }))
      .mockImplementationOnce(() => second.promise);
    const { service } = setup(fetch);
    const coordinator = new AnalysisIdempotencyCoordinator({ ttlMs: 60_000, maxEntries: 10 });
    const start = () => runWithAnalysisBudget((signal, deadline, observe) =>
      service.analyze(input, [], signal, deadline, observe), 80_000);
    const first = coordinator.execute("user", "key-a", "fingerprint", start);
    const other = coordinator.execute("user", "key-b", "fingerprint", start);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    second.resolve(jsonResponse());
    await expect(first).resolves.toEqual(output);
    await expect(other).resolves.toEqual(output);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("el timeout cubre cuerpo retrasado, acota al consumidor y conserva la barrera física", async () => {
    vi.useFakeTimers();
    let bodyController!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { bodyController = controller; } });
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      new Response(stream, { headers: { "content-type": "application/json" } }));
    const { service } = setup(fetch);
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const coordinator = new AnalysisIdempotencyCoordinator({ ttlMs: 60_000, maxEntries: 10 });
      const start = vi.fn(() => runWithAnalysisBudget((signal, deadline, observe) =>
        service.analyze(input, [], signal, deadline, observe), 80_000));
      const first = coordinator.execute("user", "key-a", "fingerprint", start);
      const firstExpectation = expect(first).rejects.toMatchObject({ code: "OPENAI_TIMEOUT" });
      await vi.advanceTimersByTimeAsync(60_000);
      await firstExpectation;
      await vi.advanceTimersByTimeAsync(20_001);
      await expect(coordinator.execute("user", "key-b", "fingerprint", start))
        .rejects.toMatchObject({ code: "OPENAI_TIMEOUT" });
      expect(fetch).toHaveBeenCalledOnce();
      expect(start).toHaveBeenCalledOnce();
      expect(coordinator.size).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
      bodyController.error(new TypeError("private late error", {
        cause: Object.assign(new Error("private cause"), { code: "ECONNRESET" }),
      }));
      await vi.advanceTimersByTimeAsync(0);
      expect(coordinator.size).toBe(0);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("un transporte pendiente que ignora abort permite terminar lógicamente sin otro intento", async () => {
    vi.useFakeTimers();
    const provider = deferred<Response>();
    const fetch = vi.fn<typeof globalThis.fetch>(() => provider.promise);
    const { service } = setup(fetch, 1_000);
    const pending = service.analyze(input, [], undefined, Date.now() + 80_000);
    const failure = expect(pending).rejects.toMatchObject({ code: "OPENAI_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(1_000);
    await failure;
    expect(fetch).toHaveBeenCalledOnce();
    provider.resolve(jsonResponse());
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("un stream 200 con causa ECONNRESET reintenta y recupera", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockImplementationOnce(async () => new Response(new ReadableStream({
        start(controller) {
          controller.error(new TypeError("private network detail", {
            cause: Object.assign(new Error("private cause"), { code: "ECONNRESET" }),
          }));
        },
      }), { headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(jsonResponse());
    const { service } = setup(fetch);
    await expect(service.analyze(input)).resolves.toEqual(output);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(["syntax", "type", "cycle", "deep"])("no reintenta errores %s sin transporte demostrado", async (kind) => {
    const error = kind === "syntax" ? new SyntaxError("private") : new TypeError("private");
    if (kind === "cycle") error.cause = error;
    if (kind === "deep") {
      let cause: Error = Object.assign(new Error("private"), { code: "ECONNRESET" });
      for (let depth = 0; depth < 6; depth += 1) cause = new Error("private", { cause });
      error.cause = cause;
    }
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(new ReadableStream({
      start(controller) { controller.error(error); },
    }), { headers: { "content-type": "application/json" } }));
    const { service } = setup(fetch);
    await expect(service.analyze(input)).rejects.toMatchObject({
      code: kind === "syntax" ? "OPENAI_RESPONSE_INVALID" : "OPENAI_UNAVAILABLE",
      retryable: false,
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("cancelar durante la lectura termina al consumidor sin repetir y observa el cuerpo tardío", async () => {
    vi.useFakeTimers();
    let bodyController!: ReadableStreamDefaultController<Uint8Array>;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(new ReadableStream({
      start(controller) { bodyController = controller; },
    }), { headers: { "content-type": "application/json" } }));
    const { service } = setup(fetch);
    const controller = new AbortController();
    const pending = service.analyze(input, [], controller.signal, Date.now() + 80_000);
    const failure = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await failure;
    bodyController.enqueue(new TextEncoder().encode(JSON.stringify(responseBody())));
    bodyController.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("el deadline integral corta la lectura y no inicia otro intento", async () => {
    vi.useFakeTimers();
    const physical = deferred<Response>();
    const fetch = vi.fn<typeof globalThis.fetch>(() => physical.promise);
    const { service } = setup(fetch);
    const work = runWithAnalysisBudget((signal, deadline, observe) =>
      service.analyze(input, [], signal, deadline, observe), 20_000);
    const failure = expect(work.result).rejects.toMatchObject({ code: "ANALYSIS_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(20_000);
    await failure;
    expect(fetch).toHaveBeenCalledOnce();
    physical.reject(new Error("private late error"));
    await expect(work.drained).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancelar la espera real de reintento limpia el timer e impide otro fetch", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(
      '{"error":{"code":"synthetic"}}',
      { status: 503, headers: { "content-type": "application/json" } },
    ));
    const sdk = new OpenAI({ apiKey: "synthetic-test-key", maxRetries: 0, fetch });
    const log = vi.fn();
    const service = new DiagnosticAnalysisService(
      new OpenAiResponsesClient("synthetic-test-key", sdk), "synthetic-model", 60_000, { log },
    );
    const controller = new AbortController();
    const work = service.analyze(input, [], controller.signal, Date.now() + 80_000);
    const failure = expect(work).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0);
    expect(log).toHaveBeenCalledWith("AI_ANALYSIS_RETRY_SCHEDULED", expect.any(Object));
    expect(vi.getTimerCount()).toBe(1);
    controller.abort();
    await failure;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetch).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["UNKNOWN_REFERENCE", "DUPLICATE_REFERENCE", "OBSERVATION_STATUS_MISMATCH"] as const)(
    "registra únicamente el motivo semántico %s y métricas seguras", async (reason) => {
      const value = structuredClone(output);
      if (reason === "UNKNOWN_REFERENCE") value.findings[0]!.relatedDtc.code = "P9999";
      if (reason === "DUPLICATE_REFERENCE") value.findings.push(structuredClone(value.findings[0]!));
      if (reason === "OBSERVATION_STATUS_MISMATCH") value.observationCorrelation.status = "no_clear_match";
      const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(responseBody("completed", JSON.stringify(value))));
      const { service, validationLog } = setup(fetch);
      await expect(service.analyze(input)).rejects.toMatchObject({ validationReason: reason });
      expect(fetch).toHaveBeenCalledOnce();
      expect(validationLog.mock.calls).toEqual([["AI_ANALYSIS_VALIDATION_FAILED", {
        reason, attempt: 1, durationMs: expect.any(Number), remainingMs: expect.any(Number),
      }]]);
    },
  );
});
