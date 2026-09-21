// @vitest-environment jsdom

import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import {
  BrowserAuthenticationError,
  createBrowserAuthenticationService,
  type SupportedAuthEvent,
} from "./auth-service";
import { SupabaseBrowserConfigurationError } from "./supabase-client";

const IDENTITY = { id: "6a103df0-8e4d-4c51-89f5-7030c5443d89", username: "usuario.apellido" };
const TOKENS = { access_token: "synthetic-access-token", refresh_token: "synthetic-refresh-token" };

function response(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: vi.fn(async () => body) } as unknown as Response;
}

function createClient(session: { access_token: string } | null = { access_token: TOKENS.access_token }) {
  let listener: ((event: SupportedAuthEvent) => void) | undefined;
  const unsubscribe = vi.fn();
  const getSession = vi.fn(async () => ({ data: { session }, error: null }));
  const setSession = vi.fn(async () => ({ data: { session }, error: null }));
  const signOut = vi.fn(async () => ({ error: null }));
  const onAuthStateChange = vi.fn((callback: (event: SupportedAuthEvent) => void) => {
    listener = callback;
    return { data: { subscription: { unsubscribe } } };
  });
  const client = { auth: { getSession, setSession, signOut, onAuthStateChange } } as unknown as SupabaseClient;
  return { client, getSession, setSession, signOut, onAuthStateChange, unsubscribe, emit: (event: SupportedAuthEvent) => listener?.(event) };
}

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
    expect((fetchMock.mock.calls[1]?.[1] as RequestInit).headers).toEqual({ Authorization: "Bearer synthetic-access-token" });
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

  it("trata 401 y 403 de /me como sesión inválida", async () => {
    for (const status of [401, 403]) {
      const sdk = createClient();
      const service = createBrowserAuthenticationService({
        getClient: () => sdk.client,
        fetch: vi.fn(async () => response(status, { error: { code: "AUTH_SESSION_INVALID" } })),
      });
      await expect(service.validateCurrentSession()).rejects.toMatchObject({ code: "AUTH_SESSION_INVALID" });
    }
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

  it("se suscribe una vez, entrega eventos soportados y libera el listener", () => {
    const sdk = createClient();
    const listener = vi.fn();
    const service = createBrowserAuthenticationService({ getClient: () => sdk.client });

    const unsubscribe = service.subscribe(listener);
    sdk.emit("TOKEN_REFRESHED");
    unsubscribe();

    expect(sdk.onAuthStateChange).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith("TOKEN_REFRESHED");
    expect(sdk.unsubscribe).toHaveBeenCalledOnce();
  });

  it("cierra solamente la sesión local", async () => {
    const sdk = createClient();
    const service = createBrowserAuthenticationService({ getClient: () => sdk.client });

    await service.signOutLocal();
    expect(sdk.signOut).toHaveBeenCalledWith({ scope: "local" });
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
