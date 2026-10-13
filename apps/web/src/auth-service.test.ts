// @vitest-environment jsdom

import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BrowserAuthenticationError,
  createBrowserAuthenticationService,
  type SupportedAuthEvent,
} from "./auth-service";
import { SupabaseBrowserConfigurationError } from "./supabase-client";

const IDENTITY = { id: "6a103df0-8e4d-4c51-89f5-7030c5443d89", username: "usuario.apellido" };
const SECOND_IDENTITY = { id: "d4e03fb0-9431-4bda-a6de-477be0ef7864", username: "segundo.usuario" };
const THIRD_IDENTITY = { id: "9ce17b55-159e-4a44-a40c-daa9c26a8f4d", username: "tercer.usuario" };
const TOKENS = { access_token: "synthetic-access-token", refresh_token: "synthetic-refresh-token" };

interface TestSession {
  access_token: string;
  user: { id: string };
}

function testSession(accessToken = TOKENS.access_token, userId = IDENTITY.id): TestSession {
  return { access_token: accessToken, user: { id: userId } };
}

function response(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: vi.fn(async () => body) } as unknown as Response;
}

function createClient(initialSession: TestSession | null = testSession()) {
  let session = initialSession;
  let listener: ((event: SupportedAuthEvent, session: TestSession | null) => void) | undefined;
  const unsubscribe = vi.fn();
  const getSession = vi.fn(async () => ({ data: { session }, error: null }));
  const setSession = vi.fn(async () => ({ data: { session }, error: null }));
  const refreshSession = vi.fn(async () => ({
    data: { session: testSession("synthetic-refreshed-token", session?.user.id ?? IDENTITY.id) },
    error: null,
  }));
  const signOut = vi.fn(async () => ({ error: null }));
  const onAuthStateChange = vi.fn((callback: (event: SupportedAuthEvent, session: TestSession | null) => void) => {
    listener = callback;
    return { data: { subscription: { unsubscribe } } };
  });
  const client = { auth: { getSession, setSession, refreshSession, signOut, onAuthStateChange } } as unknown as SupabaseClient;
  return {
    client,
    getSession,
    setSession,
    refreshSession,
    signOut,
    onAuthStateChange,
    unsubscribe,
    setCurrentSession(nextSession: TestSession | null) {
      session = nextSession;
    },
    emit(event: SupportedAuthEvent, emittedSession = event === "SIGNED_OUT" ? null : session) {
      listener?.(event, emittedSession);
    },
  };
}

function installCoalescingRefresh(sdk: ReturnType<typeof createClient>) {
  type RefreshResult = { data: { session: TestSession | null }; error: unknown };
  let active: {
    promise: Promise<RefreshResult>;
    resolve: (result: RefreshResult) => void;
    reject: (error: unknown) => void;
  } | null = null;

  sdk.refreshSession.mockImplementation(() => {
    if (active) return active.promise as never;
    let resolve!: (result: RefreshResult) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<RefreshResult>((promiseResolve, promiseReject) => {
      resolve = promiseResolve;
      reject = promiseReject;
    });
    active = { promise, resolve, reject };
    return promise as never;
  });

  return {
    resolve(session: TestSession) {
      if (!active) throw new Error("No provider refresh is pending.");
      const operation = active;
      active = null;
      operation.resolve({ data: { session }, error: null });
    },
    reject(error: unknown) {
      if (!active) throw new Error("No provider refresh is pending.");
      const operation = active;
      active = null;
      operation.reject(error);
    },
  };
}

async function flushMicrotasks() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("servicio frontend de autenticación", () => {
  it("inicia sesión sin Authorization, delega tokens a Supabase y valida /me", async () => {
    const sdk = createClient();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, TOKENS))
      .mockResolvedValueOnce(response(200, IDENTITY));
    const service = createBrowserAuthenticationService({ getClient: () => sdk.client, fetch: fetchMock });

    await expect(service.login("Usuario.Apellido", "synthetic-password")).resolves.toEqual(IDENTITY);

    expect(fetchMock.mock.calls[0]).toEqual(["/api/auth/login", expect.objectContaining({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nombre_usuario: "Usuario.Apellido", password: "synthetic-password" }),
    })]);
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).not.toHaveProperty("Authorization");
    expect(sdk.setSession).toHaveBeenCalledWith(TOKENS);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/auth/me");
    expect(((fetchMock.mock.calls[1]?.[1] as RequestInit).headers as Headers).get("Authorization"))
      .toBe("Bearer synthetic-access-token");
  });

  it.each([
    [401, { error: { code: "AUTH_CREDENTIALS_INVALID" } }, "AUTH_CREDENTIALS_INVALID", "Usuario o contraseña incorrectos."],
    [429, { error: { code: "AUTH_RATE_LIMITED" } }, "AUTH_RATE_LIMITED", "Demasiados intentos. Intenta nuevamente más tarde."],
    [503, { error: { code: "AUTH_PROVIDER_UNAVAILABLE" } }, "AUTH_PROVIDER_UNAVAILABLE", "No fue posible iniciar sesión. Intenta nuevamente."],
  ])("normaliza un login HTTP %s", async (status, body, code, message) => {
    const sdk = createClient();
    const service = createBrowserAuthenticationService({
      getClient: () => sdk.client,
      fetch: vi.fn(async () => response(status, body)),
    });

    const promise = service.login("usuario.apellido", "private");
    await expect(promise).rejects.toThrow(message);
    await promise.catch((error) => expect(error).toMatchObject({ code }));
    expect(sdk.setSession).not.toHaveBeenCalled();
  });

  it("restaura una sesión por pestaña y rechaza una identidad no validable", async () => {
    const sdk = createClient();
    const valid = createBrowserAuthenticationService({
      getClient: () => sdk.client,
      fetch: vi.fn(async () => response(200, IDENTITY)),
    });
    await expect(valid.initialize()).resolves.toEqual(IDENTITY);

    const invalid = createBrowserAuthenticationService({
      getClient: () => sdk.client,
      fetch: vi.fn(async () => response(200, { ...IDENTITY, email: "private@example.invalid" })),
    });
    await expect(invalid.initialize()).rejects.toMatchObject({ code: "AUTH_PROVIDER_UNAVAILABLE" });
  });

  it("devuelve null sin sesión y no llama /me", async () => {
    const sdk = createClient(null);
    const fetchMock = vi.fn();
    const service = createBrowserAuthenticationService({ getClient: () => sdk.client, fetch: fetchMock });

    await expect(service.initialize()).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renueva una sola vez un /me con 401 y no convierte un 403 en logout", async () => {
    const refreshedSdk = createClient();
    const refreshedFetch = vi.fn()
      .mockResolvedValueOnce(response(401, { error: { code: "AUTH_SESSION_INVALID" } }))
      .mockResolvedValueOnce(response(200, IDENTITY));
    const refreshed = createBrowserAuthenticationService({
      getClient: () => refreshedSdk.client,
      fetch: refreshedFetch,
    });
    await expect(refreshed.validateCurrentSession()).resolves.toEqual(IDENTITY);
    expect(refreshedSdk.refreshSession).toHaveBeenCalledOnce();

    const forbiddenSdk = createClient();
    const forbidden = createBrowserAuthenticationService({
      getClient: () => forbiddenSdk.client,
      fetch: vi.fn(async () => response(403, { error: { code: "AUTH_PROFILE_FORBIDDEN" } })),
    });
    await expect(forbidden.validateCurrentSession()).rejects.toMatchObject({ code: "AUTH_PROVIDER_UNAVAILABLE" });
    expect(forbiddenSdk.refreshSession).not.toHaveBeenCalled();
    expect(forbiddenSdk.signOut).not.toHaveBeenCalled();
  });

  it.each(["/api/reports/upload", "/api/reports/analyze"])(
    "agrega Bearer a %s sin conservar una copia manual",
    async (endpoint) => {
    const sdk = createClient();
    const fetchMock = vi.fn<typeof fetch>(async () => response(200, {}));
    const service = createBrowserAuthenticationService({ getClient: () => sdk.client, fetch: fetchMock });

    await service.authenticatedFetch(endpoint, { method: "POST", headers: { Accept: "application/json" } });

    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer synthetic-access-token");
    expect(headers.get("Accept")).toBe("application/json");
    expect(sdk.getSession).toHaveBeenCalledOnce();
    },
  );

  it("ante 401 renueva, repite una sola vez con el token nuevo y no cierra sesión", async () => {
    const sdk = createClient();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(401, { error: { code: "AUTH_SESSION_INVALID" } }))
      .mockResolvedValueOnce(response(200, {}));
    const service = createBrowserAuthenticationService({ getClient: () => sdk.client, fetch: fetchMock });

    await expect(service.authenticatedFetch("/api/history")).resolves.toMatchObject({ status: 200 });

    expect(sdk.refreshSession).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[0]?.[1]?.headers as Headers).get("Authorization")).toBe("Bearer synthetic-access-token");
    expect((fetchMock.mock.calls[1]?.[1]?.headers as Headers).get("Authorization")).toBe("Bearer synthetic-refreshed-token");
    expect(sdk.signOut).not.toHaveBeenCalled();
  });

  it("comparte una renovación entre solicitudes 401 simultáneas", async () => {
    const sdk = createClient();
    let releaseRefresh!: () => void;
    const pendingRefresh = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    sdk.refreshSession.mockImplementation(async () => {
      await pendingRefresh;
      return { data: { session: testSession("synthetic-refreshed-token") }, error: null } as never;
    });
    const calls = new Map<string, number>();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const key = String(input);
      const count = calls.get(key) ?? 0;
      calls.set(key, count + 1);
      return response(count === 0 ? 401 : 200, {});
    });
    const service = createBrowserAuthenticationService({ getClient: () => sdk.client, fetch: fetchMock });

    const first = service.authenticatedFetch("/api/history");
    const second = service.authenticatedFetch("/api/history/id");
    await vi.waitFor(() => expect(sdk.refreshSession).toHaveBeenCalledOnce());
    releaseRefresh();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);

    expect(sdk.refreshSession).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("un fallo de red durante refresh conserva la sesión local", async () => {
    const sdk = createClient();
    sdk.refreshSession.mockRejectedValueOnce(new TypeError("synthetic network failure"));
    const service = createBrowserAuthenticationService({
      getClient: () => sdk.client,
      fetch: vi.fn(async () => response(401, {})),
    });

    await expect(service.authenticatedFetch("/api/history")).rejects.toMatchObject({
      code: "AUTH_PROVIDER_UNAVAILABLE",
    });
    expect(sdk.signOut).not.toHaveBeenCalled();
  });

  it("no comparte una renovación entre identidades distintas ni reintenta A con el token de B", async () => {
    const sdk = createClient(testSession("token-a", IDENTITY.id));
    const provider = installCoalescingRefresh(sdk);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const token = (init?.headers as Headers).get("Authorization");
      return response(token === "Bearer token-b-renovado" ? 200 : 401, {});
    });
    const service = createBrowserAuthenticationService({ getClient: () => sdk.client, fetch: fetchMock });
    const authEvents = vi.fn();
    service.subscribe(authEvents);

    const requestA = service.authenticatedFetch("/api/history/a");
    await vi.waitFor(() => expect(sdk.refreshSession).toHaveBeenCalledOnce());
    sdk.setCurrentSession(testSession("token-b", SECOND_IDENTITY.id));
    sdk.emit("SIGNED_IN");
    authEvents.mockClear();
    const requestB = service.authenticatedFetch("/api/history/b");
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input) === "/api/history/b")).toBe(true));
    expect(sdk.refreshSession).toHaveBeenCalledOnce();

    sdk.emit("TOKEN_REFRESHED", testSession("token-a-renovado", IDENTITY.id));
    provider.resolve(testSession("token-a-renovado", IDENTITY.id));
    await expect(requestA).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(sdk.refreshSession).toHaveBeenCalledTimes(2));
    provider.resolve(testSession("token-b-renovado", SECOND_IDENTITY.id));
    await expect(requestB).resolves.toMatchObject({ status: 200 });

    const callsForB = fetchMock.mock.calls.filter(([input]) => String(input) === "/api/history/b");
    expect(callsForB).toHaveLength(2);
    expect((callsForB[1]?.[1]?.headers as Headers).get("Authorization")).toBe("Bearer token-b-renovado");
    expect(callsForB.some(([, init]) => (init?.headers as Headers).get("Authorization") === "Bearer token-a-renovado"))
      .toBe(false);
    expect(authEvents).not.toHaveBeenCalledWith("TOKEN_REFRESHED", IDENTITY.id);
  });

  it("descarta una renovación tardía después de cerrar sesión", async () => {
    const sdk = createClient();
    let releaseRefresh!: () => void;
    const pendingRefresh = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    sdk.refreshSession.mockImplementationOnce(async () => {
      await pendingRefresh;
      sdk.emit("TOKEN_REFRESHED", testSession("late-token"));
      return { data: { session: testSession("late-token") }, error: null } as never;
    });
    const fetchMock = vi.fn(async () => response(401, {}));
    const service = createBrowserAuthenticationService({ getClient: () => sdk.client, fetch: fetchMock });
    const authEvents = vi.fn();
    service.subscribe(authEvents);

    const request = service.authenticatedFetch("/api/history");
    await vi.waitFor(() => expect(sdk.refreshSession).toHaveBeenCalledOnce());
    await service.signOutLocal();
    releaseRefresh();

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(authEvents).not.toHaveBeenCalledWith("TOKEN_REFRESHED", IDENTITY.id);
  });

  it("no comparte refresh entre generaciones distintas del mismo UUID", async () => {
    const sdk = createClient(testSession("generation-one"));
    const provider = installCoalescingRefresh(sdk);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const token = (init?.headers as Headers).get("Authorization");
      return response(token === "Bearer current-refresh" ? 200 : 401, {});
    });
    const service = createBrowserAuthenticationService({ getClient: () => sdk.client, fetch: fetchMock });
    service.subscribe(() => undefined);

    const oldRequest = service.authenticatedFetch("/api/history/old");
    await vi.waitFor(() => expect(sdk.refreshSession).toHaveBeenCalledOnce());
    sdk.setCurrentSession(testSession("generation-two"));
    sdk.emit("SIGNED_IN");
    const currentRequest = service.authenticatedFetch("/api/history/current");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(sdk.refreshSession).toHaveBeenCalledOnce();
    provider.resolve(testSession("stale-refresh"));
    await expect(oldRequest).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(sdk.refreshSession).toHaveBeenCalledTimes(2));
    provider.resolve(testSession("current-refresh"));
    await expect(currentRequest).resolves.toMatchObject({ status: 200 });
  });

  it("libera la barrera física tras un rechazo de A y permite refrescar B", async () => {
    const sdk = createClient(testSession("token-a", IDENTITY.id));
    const provider = installCoalescingRefresh(sdk);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const token = (init?.headers as Headers).get("Authorization");
      return response(token === "Bearer token-b-renovado" ? 200 : 401, {});
    });
    const service = createBrowserAuthenticationService({ getClient: () => sdk.client, fetch: fetchMock });
    service.subscribe(() => undefined);

    const requestA = service.authenticatedFetch("/api/history/a");
    await vi.waitFor(() => expect(sdk.refreshSession).toHaveBeenCalledOnce());
    sdk.setCurrentSession(testSession("token-b", SECOND_IDENTITY.id));
    sdk.emit("SIGNED_IN");
    const requestB = service.authenticatedFetch("/api/history/b");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(sdk.refreshSession).toHaveBeenCalledOnce();

    const staleExpectation = expect(requestA).rejects.toMatchObject({ name: "AbortError" });
    provider.reject(new TypeError("synthetic provider failure"));
    await staleExpectation;
    await vi.waitFor(() => expect(sdk.refreshSession).toHaveBeenCalledTimes(2));
    provider.resolve(testSession("token-b-renovado", SECOND_IDENTITY.id));

    await expect(requestB).resolves.toMatchObject({ status: 200 });
    expect(sdk.signOut).not.toHaveBeenCalled();
  });

  it("no refresca B si cambia a C mientras espera la barrera física de A", async () => {
    const sdk = createClient(testSession("token-a", IDENTITY.id));
    const provider = installCoalescingRefresh(sdk);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const token = (init?.headers as Headers).get("Authorization");
      return response(token === "Bearer token-c-renovado" ? 200 : 401, {});
    });
    const service = createBrowserAuthenticationService({ getClient: () => sdk.client, fetch: fetchMock });
    service.subscribe(() => undefined);

    const requestA = service.authenticatedFetch("/api/history/a");
    const staleA = expect(requestA).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(sdk.refreshSession).toHaveBeenCalledOnce());
    sdk.setCurrentSession(testSession("token-b", SECOND_IDENTITY.id));
    sdk.emit("SIGNED_IN");
    const requestB = service.authenticatedFetch("/api/history/b");
    const staleB = expect(requestB).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(sdk.refreshSession).toHaveBeenCalledOnce();
    sdk.setCurrentSession(testSession("token-c", THIRD_IDENTITY.id));
    sdk.emit("SIGNED_IN");
    const requestC = service.authenticatedFetch("/api/history/c");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(sdk.refreshSession).toHaveBeenCalledOnce();

    provider.resolve(testSession("token-a-renovado", IDENTITY.id));
    await Promise.all([staleA, staleB]);
    await vi.waitFor(() => expect(sdk.refreshSession).toHaveBeenCalledTimes(2));
    provider.resolve(testSession("token-c-renovado", THIRD_IDENTITY.id));

    await expect(requestC).resolves.toMatchObject({ status: 200 });
    expect(sdk.refreshSession).toHaveBeenCalledTimes(2);
  });

  it("dos solicitudes de B esperan A y comparten un único refresh físico de B", async () => {
    const sdk = createClient(testSession("token-a", IDENTITY.id));
    const provider = installCoalescingRefresh(sdk);
    const requestCounts = new Map<string, number>();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const key = String(input);
      requestCounts.set(key, (requestCounts.get(key) ?? 0) + 1);
      const token = (init?.headers as Headers).get("Authorization");
      return response(token === "Bearer token-b-renovado" ? 200 : 401, {});
    });
    const service = createBrowserAuthenticationService({ getClient: () => sdk.client, fetch: fetchMock });
    service.subscribe(() => undefined);

    const requestA = service.authenticatedFetch("/api/history/a");
    await vi.waitFor(() => expect(sdk.refreshSession).toHaveBeenCalledOnce());
    sdk.setCurrentSession(testSession("token-b", SECOND_IDENTITY.id));
    sdk.emit("SIGNED_IN");
    const firstB = service.authenticatedFetch("/api/history/b/1");
    const secondB = service.authenticatedFetch("/api/history/b/2");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(sdk.refreshSession).toHaveBeenCalledOnce();

    const staleA = expect(requestA).rejects.toMatchObject({ name: "AbortError" });
    provider.resolve(testSession("token-a-renovado", IDENTITY.id));
    await staleA;
    await vi.waitFor(() => expect(sdk.refreshSession).toHaveBeenCalledTimes(2));
    provider.resolve(testSession("token-b-renovado", SECOND_IDENTITY.id));

    await expect(Promise.all([firstB, secondB])).resolves.toHaveLength(2);
    expect(sdk.refreshSession).toHaveBeenCalledTimes(2);
  });

  it("logout mientras B espera impide iniciar su refresh físico", async () => {
    const sdk = createClient(testSession("token-a", IDENTITY.id));
    const provider = installCoalescingRefresh(sdk);
    const service = createBrowserAuthenticationService({
      getClient: () => sdk.client,
      fetch: vi.fn(async () => response(401, {})),
    });
    service.subscribe(() => undefined);

    const requestA = service.authenticatedFetch("/api/history/a");
    await vi.waitFor(() => expect(sdk.refreshSession).toHaveBeenCalledOnce());
    sdk.setCurrentSession(testSession("token-b", SECOND_IDENTITY.id));
    sdk.emit("SIGNED_IN");
    const requestB = service.authenticatedFetch("/api/history/b");
    await vi.waitFor(() => expect(sdk.getSession).toHaveBeenCalledTimes(2));
    await service.signOutLocal();

    const staleA = expect(requestA).rejects.toMatchObject({ name: "AbortError" });
    const staleB = expect(requestB).rejects.toMatchObject({ name: "AbortError" });
    provider.resolve(testSession("token-a-renovado", IDENTITY.id));
    await Promise.all([staleA, staleB]);

    expect(sdk.refreshSession).toHaveBeenCalledOnce();
    expect(sdk.signOut).toHaveBeenCalledOnce();
  });

  it("serializa setSession detrás de un refresh físico anterior", async () => {
    const sdk = createClient(testSession("token-a", IDENTITY.id));
    const provider = installCoalescingRefresh(sdk);
    sdk.setSession.mockImplementationOnce(async () => {
      const nextSession = testSession("token-b", SECOND_IDENTITY.id);
      sdk.setCurrentSession(nextSession);
      sdk.emit("SIGNED_IN", nextSession);
      return { data: { session: nextSession }, error: null } as never;
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/auth/login") return response(200, TOKENS);
      if (String(input) === "/api/auth/me") return response(200, SECOND_IDENTITY);
      return response(401, {});
    });
    const service = createBrowserAuthenticationService({ getClient: () => sdk.client, fetch: fetchMock });
    service.subscribe(() => undefined);

    const requestA = service.authenticatedFetch("/api/history/a");
    await vi.waitFor(() => expect(sdk.refreshSession).toHaveBeenCalledOnce());
    await service.signOutLocal();
    const login = service.login("segundo.usuario", "synthetic-password");
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input) === "/api/auth/login")).toBe(true));
    expect(sdk.setSession).not.toHaveBeenCalled();

    const staleA = expect(requestA).rejects.toMatchObject({ name: "AbortError" });
    provider.resolve(testSession("token-a-renovado", IDENTITY.id));
    await staleA;

    await expect(login).resolves.toEqual(SECOND_IDENTITY);
    expect(sdk.setSession).toHaveBeenCalledOnce();
  });

  it("finaliza login B por timeout sin liberar el refresh físico infinito de A ni ejecutar setSession tarde", async () => {
    vi.useFakeTimers();
    const sdk = createClient(testSession("token-a", IDENTITY.id));
    const provider = installCoalescingRefresh(sdk);
    sdk.setSession.mockImplementation(async () => {
      throw new Error("setSession must not run");
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => (
      String(input) === "/api/auth/login"
        ? response(200, TOKENS)
        : response(401, {})
    ));
    const service = createBrowserAuthenticationService({
      getClient: () => sdk.client,
      fetch: fetchMock,
      providerOperationTimeoutMs: 25,
    });
    service.subscribe(() => undefined);

    const requestA = service.authenticatedFetch("/api/history/a");
    const requestAExpectation = expect(requestA).rejects.toMatchObject({
      code: "AUTH_PROVIDER_UNAVAILABLE",
    });
    await flushMicrotasks();
    expect(sdk.refreshSession).toHaveBeenCalledOnce();
    sdk.setCurrentSession(null);
    await service.signOutLocal();
    const loginB = service.login("segundo.usuario", "synthetic-password");
    const loginExpectation = expect(loginB).rejects.toMatchObject({
      code: "AUTH_PROVIDER_UNAVAILABLE",
      message: "El servicio de autenticación no respondió a tiempo. Tu sesión no fue cerrada. Intenta nuevamente.",
    });
    await flushMicrotasks();
    expect(sdk.setSession).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(25);
    await Promise.all([requestAExpectation, loginExpectation]);
    expect(sdk.refreshSession).toHaveBeenCalledOnce();
    expect(sdk.setSession).not.toHaveBeenCalled();

    provider.resolve(testSession("token-a-renovado", IDENTITY.id));
    await flushMicrotasks();
    expect(sdk.setSession).not.toHaveBeenCalled();
    expect(sdk.refreshSession).toHaveBeenCalledOnce();
    expect(sdk.signOut).toHaveBeenCalledOnce();
  });

  it("cancela inmediatamente setSession en cola y lo omite cuando termina el refresh anterior", async () => {
    const sdk = createClient(testSession("token-a", IDENTITY.id));
    const provider = installCoalescingRefresh(sdk);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => (
      String(input) === "/api/auth/login"
        ? response(200, TOKENS)
        : response(401, {})
    ));
    const service = createBrowserAuthenticationService({
      getClient: () => sdk.client,
      fetch: fetchMock,
      providerOperationTimeoutMs: 1_000,
    });
    service.subscribe(() => undefined);

    const requestA = service.authenticatedFetch("/api/history/a");
    await vi.waitFor(() => expect(sdk.refreshSession).toHaveBeenCalledOnce());
    sdk.setCurrentSession(null);
    await service.signOutLocal();
    const controller = new AbortController();
    const loginB = service.login("segundo.usuario", "synthetic-password", controller.signal);
    const loginExpectation = expect(loginB).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input) === "/api/auth/login")).toBe(true));
    controller.abort();

    await loginExpectation;
    expect(sdk.setSession).not.toHaveBeenCalled();
    const staleA = expect(requestA).rejects.toMatchObject({ name: "AbortError" });
    provider.resolve(testSession("token-a-renovado", IDENTITY.id));
    await staleA;
    await flushMicrotasks();
    expect(sdk.setSession).not.toHaveBeenCalled();
    expect(sdk.refreshSession).toHaveBeenCalledOnce();
  });

  it("un consumidor cancelado no cancela el refresh físico compartido por otro consumidor", async () => {
    const sdk = createClient(testSession("token-b", SECOND_IDENTITY.id));
    const provider = installCoalescingRefresh(sdk);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const token = (init?.headers as Headers).get("Authorization");
      return response(token === "Bearer token-b-renovado" ? 200 : 401, {});
    });
    const service = createBrowserAuthenticationService({ getClient: () => sdk.client, fetch: fetchMock });
    const firstController = new AbortController();
    const first = service.authenticatedFetch("/api/history/b/1", { signal: firstController.signal });
    const second = service.authenticatedFetch("/api/history/b/2");
    const firstExpectation = expect(first).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(sdk.refreshSession).toHaveBeenCalledOnce());

    firstController.abort();
    await firstExpectation;
    expect(sdk.refreshSession).toHaveBeenCalledOnce();
    provider.resolve(testSession("token-b-renovado", SECOND_IDENTITY.id));

    await expect(second).resolves.toMatchObject({ status: 200 });
    expect(sdk.refreshSession).toHaveBeenCalledOnce();
  });

  it("un consumidor expira con refresh ya iniciado, pero la barrera permanece y otro consumidor reutiliza la operación", async () => {
    vi.useFakeTimers();
    const sdk = createClient(testSession("token-b", SECOND_IDENTITY.id));
    const provider = installCoalescingRefresh(sdk);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const token = (init?.headers as Headers).get("Authorization");
      return response(token === "Bearer token-b-renovado" ? 200 : 401, {});
    });
    const service = createBrowserAuthenticationService({
      getClient: () => sdk.client,
      fetch: fetchMock,
      providerOperationTimeoutMs: 25,
    });

    const expired = service.authenticatedFetch("/api/history/b/expired");
    const expiredExpectation = expect(expired).rejects.toMatchObject({
      code: "AUTH_PROVIDER_UNAVAILABLE",
    });
    await flushMicrotasks();
    expect(sdk.refreshSession).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(25);
    await expiredExpectation;

    const current = service.authenticatedFetch("/api/history/b/current");
    await flushMicrotasks();
    expect(sdk.refreshSession).toHaveBeenCalledOnce();
    provider.resolve(testSession("token-b-renovado", SECOND_IDENTITY.id));

    await expect(current).resolves.toMatchObject({ status: 200 });
    expect(sdk.refreshSession).toHaveBeenCalledOnce();
  });

  it("una validación con refresh físico infinito termina con timeout recuperable sin logout", async () => {
    vi.useFakeTimers();
    const sdk = createClient(testSession("token-a", IDENTITY.id));
    installCoalescingRefresh(sdk);
    const service = createBrowserAuthenticationService({
      getClient: () => sdk.client,
      fetch: vi.fn(async () => response(401, {})),
      providerOperationTimeoutMs: 25,
    });

    const validation = service.validateCurrentSession();
    const expectation = expect(validation).rejects.toMatchObject({
      code: "AUTH_PROVIDER_UNAVAILABLE",
      message: "El servicio de autenticación no respondió a tiempo. Tu sesión no fue cerrada. Intenta nuevamente.",
    });
    await flushMicrotasks();
    expect(sdk.refreshSession).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(25);

    await expectation;
    expect(sdk.signOut).not.toHaveBeenCalled();
    expect(sdk.refreshSession).toHaveBeenCalledOnce();
  });

  it("un segundo 401 después del refresh confirma una sesión inválida sin bucle", async () => {
    const sdk = createClient();
    const fetchMock = vi.fn(async () => response(401, {}));
    const service = createBrowserAuthenticationService({ getClient: () => sdk.client, fetch: fetchMock });

    await expect(service.authenticatedFetch("/api/history")).rejects.toMatchObject({
      code: "AUTH_SESSION_INVALID",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sdk.refreshSession).toHaveBeenCalledOnce();
  });

  it("solo confirma sesión inválida cuando Supabase rechaza definitivamente el refresh", async () => {
    const sdk = createClient();
    sdk.refreshSession.mockResolvedValueOnce({
      data: { session: null, user: null },
      error: { name: "AuthApiError", status: 400 },
    } as never);
    const service = createBrowserAuthenticationService({
      getClient: () => sdk.client,
      fetch: vi.fn(async () => response(401, {})),
    });

    await expect(service.authenticatedFetch("/api/history")).rejects.toMatchObject({
      code: "AUTH_SESSION_INVALID",
    });
    expect(sdk.signOut).not.toHaveBeenCalled();
  });

  it("se suscribe una vez, entrega eventos soportados y libera el listener", () => {
    const sdk = createClient();
    const listener = vi.fn();
    const service = createBrowserAuthenticationService({ getClient: () => sdk.client });

    const unsubscribe = service.subscribe(listener);
    sdk.emit("TOKEN_REFRESHED");
    unsubscribe();

    expect(sdk.onAuthStateChange).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith("TOKEN_REFRESHED", IDENTITY.id);
    expect(sdk.unsubscribe).toHaveBeenCalledOnce();
  });

  it("cierra solamente la sesión local", async () => {
    const sdk = createClient();
    const service = createBrowserAuthenticationService({ getClient: () => sdk.client });

    await service.signOutLocal();
    expect(sdk.signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it.each([
    ["red", () => { throw new TypeError("synthetic network failure"); }],
    ["HTTP 500", async () => response(500, { error: { code: "INTERNAL" } })],
  ])("conserva la sesión establecida si /me falla temporalmente por %s", async (_case, meResult) => {
    const sdk = createClient();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, TOKENS))
      .mockImplementationOnce(meResult);
    const service = createBrowserAuthenticationService({ getClient: () => sdk.client, fetch: fetchMock });

    await expect(service.login("usuario.apellido", "synthetic-password")).rejects.toMatchObject({
      code: "AUTH_PROVIDER_UNAVAILABLE",
      sessionEstablished: true,
    });
    expect(sdk.signOut).not.toHaveBeenCalled();
  });

  it("limpia la sesión establecida solamente cuando /me confirma credenciales inválidas", async () => {
    const sdk = createClient();
    sdk.refreshSession.mockResolvedValueOnce({
      data: { session: null, user: null },
      error: { name: "AuthApiError", status: 400 },
    } as never);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, TOKENS))
      .mockResolvedValueOnce(response(401, { error: { code: "AUTH_SESSION_INVALID" } }));
    const service = createBrowserAuthenticationService({ getClient: () => sdk.client, fetch: fetchMock });

    await expect(service.login("usuario.apellido", "synthetic-password")).rejects.toMatchObject({
      code: "AUTH_SESSION_INVALID",
      sessionEstablished: false,
    });
    expect(sdk.signOut).toHaveBeenCalledOnce();
  });

  it("controla configuración ausente sin intentar red ni revelar variables", async () => {
    const fetchMock = vi.fn();
    const service = createBrowserAuthenticationService({
      getClient: () => { throw new SupabaseBrowserConfigurationError(); },
      fetch: fetchMock,
    });

    const promise = service.initialize();
    await expect(promise).rejects.toBeInstanceOf(BrowserAuthenticationError);
    await promise.catch((error) => {
      expect(error).toMatchObject({ code: "AUTH_CONFIGURATION_UNAVAILABLE" });
      expect(String(error)).not.toMatch(/VITE_|SUPABASE_|sb_publishable_/u);
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
