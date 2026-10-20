// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiRequestError, createBrowserApiClient } from "./api-client";
import type { BrowserAuthenticationService } from "./auth-service";

function response(status: number, body: unknown, jsonError = false) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn(async () => {
      if (jsonError) throw new SyntaxError("synthetic invalid json");
      return body;
    }),
  } as unknown as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function authenticationService(
  authenticatedFetch: BrowserAuthenticationService["authenticatedFetch"],
): BrowserAuthenticationService {
  return {
    initialize: vi.fn(async () => null),
    login: vi.fn(),
    validateCurrentSession: vi.fn(async () => null),
    authenticatedFetch,
    subscribe: vi.fn(() => () => undefined),
    signOutLocal: vi.fn(async () => undefined),
  };
}

const parseOk = (value: unknown) => (
  value !== null && typeof value === "object" && (value as { ok?: unknown }).ok === true
    ? { ok: true as const }
    : null
);

afterEach(() => {
  vi.useRealTimers();
});

describe("cliente API tipado", () => {
  it("502 OPENAI_RESPONSE_INVALID es validación local, sin retry, logout ni mensaje remoto", async () => {
    const fetch = vi.fn(async () => response(502, { error: { code: "OPENAI_RESPONSE_INVALID", message: "REMOTE_PRIVATE_MESSAGE" } }));
    const service = authenticationService(fetch);
    const client = createBrowserApiClient(service);
    await expect(client.requestJson("/api/reports/analyze", { parse: parseOk, retry: "once" }))
      .rejects.toMatchObject({ type: "validation", retryable: false, status: 502,
        message: "El servicio devolvió una orientación que no pudo validarse." });
    expect(fetch).toHaveBeenCalledOnce();
    expect(service.signOutLocal).not.toHaveBeenCalled();
  });
  it("clasifica un fallo de transporte sin cerrar la sesión", async () => {
    const service = authenticationService(vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    const client = createBrowserApiClient(service);

    await expect(client.requestJson("/api/reports/upload", {
      init: { method: "POST" },
      parse: parseOk,
    })).rejects.toMatchObject({ type: "network", retryable: true });
    expect(service.signOutLocal).not.toHaveBeenCalled();
  });

  it.each([
    [408, "timeout", true],
    [504, "timeout", true],
    [429, "rate_limited", true],
    [500, "server", true],
    [503, "server", true],
    [403, "forbidden", false],
  ] as const)("clasifica HTTP %s como %s sin logout", async (status, type, retryable) => {
    const service = authenticationService(vi.fn(async () => response(status, { error: {} })));
    const client = createBrowserApiClient(service);

    await expect(client.requestJson("/api/reports/analyze", {
      init: { method: "POST" },
      parse: parseOk,
    })).rejects.toMatchObject({ type, status, retryable });
    expect(service.signOutLocal).not.toHaveBeenCalled();
  });

  it("clasifica JSON inválido sin exponer la respuesta", async () => {
    const service = authenticationService(vi.fn(async () => response(200, null, true)));
    const client = createBrowserApiClient(service);

    const promise = client.requestJson("/api/history", { parse: parseOk });
    await expect(promise).rejects.toBeInstanceOf(ApiRequestError);
    await promise.catch((error) => expect(error).toMatchObject({ type: "invalid_response" }));
  });

  it("cancela por timeout y no confunde la cancelación externa", async () => {
    vi.useFakeTimers();
    const service = authenticationService(vi.fn((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    })));
    const client = createBrowserApiClient(service);
    const timeoutRequest = client.requestJson("/api/reports/analyze", {
      init: { method: "POST" },
      timeoutMs: 25,
      parse: parseOk,
    });
    const timeoutExpectation = expect(timeoutRequest).rejects.toMatchObject({ type: "timeout", retryable: true });
    await vi.advanceTimersByTimeAsync(25);
    await timeoutExpectation;

    const controller = new AbortController();
    const abortedRequest = client.requestJson("/api/history", {
      init: { signal: controller.signal },
      timeoutMs: 100,
      parse: parseOk,
    });
    controller.abort();
    await expect(abortedRequest).rejects.toMatchObject({ type: "aborted", retryable: false });
  });

  it("mantiene el timeout activo mientras se lee y parsea el cuerpo", async () => {
    vi.useFakeTimers();
    const body = deferred<unknown>();
    const service = authenticationService(vi.fn(async () => ({
      ok: true,
      status: 200,
      json: vi.fn(() => body.promise),
    } as unknown as Response)));
    const client = createBrowserApiClient(service);
    const request = client.requestJson("/api/history", { timeoutMs: 25, parse: parseOk });
    const expectation = expect(request).rejects.toMatchObject({ type: "timeout", retryable: true });

    await vi.advanceTimersByTimeAsync(25);
    await expectation;
  });

  it("acepta un cuerpo válido justo antes del límite y limpia su temporizador", async () => {
    vi.useFakeTimers();
    const body = deferred<unknown>();
    const service = authenticationService(vi.fn(async () => ({
      ok: true,
      status: 200,
      json: vi.fn(() => body.promise),
    } as unknown as Response)));
    const client = createBrowserApiClient(service);
    const request = client.requestJson("/api/history", { timeoutMs: 25, parse: parseOk });

    await vi.advanceTimersByTimeAsync(24);
    body.resolve({ ok: true });

    await expect(request).resolves.toEqual({ ok: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clasifica un rechazo durante la lectura del cuerpo y limpia su temporizador", async () => {
    vi.useFakeTimers();
    const service = authenticationService(vi.fn(async () => ({
      ok: true,
      status: 200,
      json: vi.fn(async () => { throw new TypeError("synthetic body failure"); }),
    } as unknown as Response)));
    const client = createBrowserApiClient(service);

    await expect(client.requestJson("/api/history", { timeoutMs: 25, parse: parseOk }))
      .rejects.toMatchObject({ type: "invalid_response", retryable: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("propaga una cancelación externa durante la lectura del cuerpo", async () => {
    const body = deferred<unknown>();
    const service = authenticationService(vi.fn(async () => ({
      ok: true,
      status: 200,
      json: vi.fn(() => body.promise),
    } as unknown as Response)));
    const client = createBrowserApiClient(service);
    const controller = new AbortController();
    const request = client.requestJson("/api/history", {
      init: { signal: controller.signal },
      timeoutMs: 100,
      parse: parseOk,
    });

    controller.abort();

    await expect(request).rejects.toMatchObject({ type: "aborted", retryable: false });
  });

  it("reintenta una sola vez una lectura idempotente y nunca un POST", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("synthetic network failure"))
      .mockResolvedValueOnce(response(200, { ok: true }));
    const service = authenticationService(fetchMock);
    const client = createBrowserApiClient(service);
    const retried = client.requestJson("/api/history", { retry: "once", parse: parseOk });
    await vi.advanceTimersByTimeAsync(150);
    await expect(retried).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockClear();
    fetchMock.mockRejectedValue(new TypeError("synthetic network failure"));
    await expect(client.requestJson("/api/reports/upload", {
      init: { method: "POST" },
      retry: "none",
      parse: parseOk,
    })).rejects.toMatchObject({ type: "network" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("comprueba /api/health sin autenticación ni datos adicionales", async () => {
    const authenticatedFetch = vi.fn();
    const publicFetch = vi.fn(async () => response(200, { status: "ok" }));
    const client = createBrowserApiClient(authenticationService(authenticatedFetch), { fetch: publicFetch });

    await expect(client.checkHealth()).resolves.toBeUndefined();
    expect(publicFetch).toHaveBeenCalledWith("/api/health", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(authenticatedFetch).not.toHaveBeenCalled();
  });
});
