import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AnalysisCoordinationError,
  AnalysisIdempotencyCoordinator,
  runWithAnalysisBudget,
} from "./analysis-coordinator.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("presupuesto físico del análisis", () => {
  it("entrega a la operación el mismo deadline absoluto del temporizador integral", async () => {
    const operation = vi.fn(async (_signal: AbortSignal, deadlineAtMs: number) => deadlineAtMs);
    const coordinated = runWithAnalysisBudget(operation, 80_000, { now: () => 12_345 });

    await expect(coordinated.result).resolves.toBe(92_345);
    expect(operation).toHaveBeenCalledOnce();
  });

  it("permite un análisis superior a 30 segundos pero inferior al límite coordinado", async () => {
    vi.useFakeTimers();
    const provider = deferred<string>();
    const operation = runWithAnalysisBudget(() => provider.promise, 80_000);

    await vi.advanceTimersByTimeAsync(30_001);
    provider.resolve("completed");

    await expect(operation.result).resolves.toBe("completed");
    await expect(operation.drained).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborta al vencer, conserva observada la promesa física tardía y limpia timers", async () => {
    vi.useFakeTimers();
    const provider = deferred<string>();
    let receivedSignal: AbortSignal | undefined;
    const operation = runWithAnalysisBudget((signal) => {
      receivedSignal = signal;
      return provider.promise;
    }, 80_000);
    const result = expect(operation.result).rejects.toMatchObject({ code: "ANALYSIS_TIMEOUT" });

    await vi.advanceTimersByTimeAsync(80_000);
    await result;
    expect(receivedSignal?.aborted).toBe(true);
    provider.reject(new Error("synthetic late rejection"));
    await expect(operation.drained).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("coordinador idempotente", () => {
  it("TTL 60 s no expulsa trabajo activo de 80 s ni sus claves, y empieza al terminar", async () => {
    vi.useFakeTimers();
    const provider = deferred<string>();
    const coordinator = new AnalysisIdempotencyCoordinator<string>({ ttlMs: 60_000, maxEntries: 3 });
    const start = vi.fn(() => runWithAnalysisBudget(() => provider.promise, 80_000));
    const first = coordinator.execute("user", "key-a", "fingerprint", start);
    await vi.advanceTimersByTimeAsync(60_001);
    const second = coordinator.execute("user", "key-b", "fingerprint", start);
    expect(start).toHaveBeenCalledOnce();
    expect(() => coordinator.execute("user", "key-a", "other", start))
      .toThrowError(AnalysisCoordinationError);
    provider.resolve("ok");
    await expect(Promise.all([first, second])).resolves.toEqual(["ok", "ok"]);
    await vi.advanceTimersByTimeAsync(59_999);
    coordinator.sweep();
    expect(coordinator.size).toBe(1);
    await vi.advanceTimersByTimeAsync(2);
    coordinator.sweep();
    expect(coordinator.size).toBe(0);
    await expect(coordinator.execute("user", "key-a", "fingerprint", start)).resolves.toBe("ok");
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("un timeout lógico no libera capacidad ni duplica; al drenar admite reintento", async () => {
    vi.useFakeTimers();
    const provider = deferred<string>();
    const coordinator = new AnalysisIdempotencyCoordinator<string>({ ttlMs: 60_000, maxEntries: 2 });
    const start = vi.fn(() => runWithAnalysisBudget(() => provider.promise, 80_000));
    const first = coordinator.execute("user", "key-a", "fingerprint", start);
    const failure = expect(first).rejects.toMatchObject({ code: "ANALYSIS_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(80_001);
    await failure;
    await expect(coordinator.execute("user", "key-b", "fingerprint", start))
      .rejects.toMatchObject({ code: "ANALYSIS_TIMEOUT" });
    expect(() => coordinator.execute("other", "key-c", "other-fingerprint", start))
      .toThrowError(AnalysisCoordinationError);
    await vi.advanceTimersByTimeAsync(600_000);
    coordinator.sweep();
    expect(coordinator.size).toBe(1);
    expect(start).toHaveBeenCalledOnce();
    provider.reject(new Error("late synthetic failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(coordinator.size).toBe(0);
    const success = vi.fn(() => runWithAnalysisBudget(async () => "new result", 80_000));
    await expect(coordinator.execute("user", "key-a", "fingerprint", success)).resolves.toBe("new result");
    expect(success).toHaveBeenCalledOnce();
  });

  it("capacidad ocupada por operaciones activas rechaza sin expulsión", async () => {
    const pending = deferred<string>();
    const coordinator = new AnalysisIdempotencyCoordinator<string>({ ttlMs: 1, maxEntries: 1, now: () => 0 });
    const start = vi.fn(() => ({ result: pending.promise, drained: pending.promise.then(() => undefined) }));
    const first = coordinator.execute("user", "key-a", "fingerprint", start);
    expect(() => coordinator.execute("other", "key-b", "other", start))
      .toThrowError(AnalysisCoordinationError);
    expect(start).toHaveBeenCalledOnce();
    expect(coordinator.size).toBe(1);
    pending.resolve("ok");
    await first;
  });

  it("comparte una operación concurrente y conserva exactamente el resultado completado", async () => {
    const provider = deferred<{ value: string }>();
    const start = vi.fn(() => ({ result: provider.promise, drained: provider.promise.then(() => undefined, () => undefined) }));
    const coordinator = new AnalysisIdempotencyCoordinator<{ value: string }>({ ttlMs: 1_000, maxEntries: 5 });

    const first = coordinator.execute("user-a", "key-a", "fingerprint-a", start);
    const second = coordinator.execute("user-a", "key-a", "fingerprint-a", start);
    const expected = { value: "same-reference" };
    provider.resolve(expected);

    await expect(first).resolves.toBe(expected);
    await expect(second).resolves.toBe(expected);
    await expect(coordinator.execute("user-a", "key-a", "fingerprint-a", start)).resolves.toBe(expected);
    expect(start).toHaveBeenCalledOnce();
  });

  it("converge claves de transporte distintas del mismo usuario cuando la huella coincide", async () => {
    const provider = deferred<string>();
    const start = vi.fn(() => ({ result: provider.promise, drained: provider.promise.then(() => undefined, () => undefined) }));
    const coordinator = new AnalysisIdempotencyCoordinator<string>({ ttlMs: 1_000, maxEntries: 5 });

    const first = coordinator.execute("user-a", "key-a", "fingerprint-a", start);
    const second = coordinator.execute("user-a", "key-b", "fingerprint-a", start);
    provider.resolve("shared");

    await expect(Promise.all([first, second])).resolves.toEqual(["shared", "shared"]);
    expect(start).toHaveBeenCalledOnce();
  });

  it("aísla usuarios y rechaza reutilizar la misma clave con otro payload", async () => {
    const coordinator = new AnalysisIdempotencyCoordinator<string>({ ttlMs: 1_000, maxEntries: 5 });
    const start = vi.fn(() => {
      const result = Promise.resolve("ok");
      return { result, drained: result.then(() => undefined) };
    });

    await coordinator.execute("user-a", "shared-key", "fingerprint-a", start);
    expect(() => coordinator.execute("user-a", "shared-key", "fingerprint-b", start))
      .toThrowError(AnalysisCoordinationError);
    await coordinator.execute("user-b", "shared-key", "fingerprint-b", start);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("mantiene acotada la caché y elimina resultados al vencer su TTL", async () => {
    let now = 0;
    const coordinator = new AnalysisIdempotencyCoordinator<string>({ ttlMs: 100, maxEntries: 1, now: () => now });
    const start = () => {
      const result = Promise.resolve("ok");
      return { result, drained: result.then(() => undefined) };
    };
    await coordinator.execute("user-a", "key-a", "fingerprint-a", start);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(coordinator.size).toBe(1);
    expect(() => coordinator.execute("user-a", "key-b", "fingerprint-b", start))
      .toThrowError(AnalysisCoordinationError);
    now = 101;
    coordinator.sweep();
    expect(coordinator.size).toBe(0);
    await expect(coordinator.execute("user-a", "key-b", "fingerprint-b", start)).resolves.toBe("ok");
  });
});
