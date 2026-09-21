// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createSupabaseBrowserClientProvider,
  loadSupabaseBrowserConfig,
  SupabaseBrowserClientError,
  SupabaseBrowserConfigurationError,
} from "./supabase-client";

const sdk = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("@supabase/supabase-js", () => sdk);

const PUBLIC_KEY = ["sb", "publishable", "synthetic_public_key_for_tests"].join("_");
const ENVIRONMENT = {
  VITE_SUPABASE_URL: "https://synthetic-project.example.test/",
  VITE_SUPABASE_PUBLISHABLE_KEY: PUBLIC_KEY,
};

beforeEach(() => {
  sdk.createClient.mockReset();
  sdk.createClient.mockImplementation(() => ({ auth: {} } as unknown as SupabaseClient));
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Red prohibida en pruebas"); }));
  vi.spyOn(XMLHttpRequest.prototype, "open").mockImplementation(() => { throw new Error("Red prohibida en pruebas"); });
});

afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  expect(XMLHttpRequest.prototype.open).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("cliente Supabase preparado para el navegador", () => {
  it("se importa sin configuración, window ni inicialización del SDK", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_SUPABASE_URL", "");
    vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "");
    vi.stubGlobal("window", undefined);
    const module = await import("./supabase-client");
    expect(sdk.createClient).not.toHaveBeenCalled();
    expect(() => module.getSupabaseBrowserClient()).toThrow("La configuración pública de autenticación no está disponible o no es válida.");
    expect(sdk.createClient).not.toHaveBeenCalled();
  });

  it("el proveedor por defecto reutiliza una instancia y usa sessionStorage, nunca localStorage", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_SUPABASE_URL", ENVIRONMENT.VITE_SUPABASE_URL);
    vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", PUBLIC_KEY);
    const tabStorage = window.sessionStorage;
    const localStorageGetter = vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new Error("Almacenamiento persistente prohibido");
    });
    const { getSupabaseBrowserClient } = await import("./supabase-client");
    const first = getSupabaseBrowserClient();
    expect(getSupabaseBrowserClient()).toBe(first);
    expect(sdk.createClient).toHaveBeenCalledTimes(1);
    expect(sdk.createClient).toHaveBeenCalledWith("https://synthetic-project.example.test", PUBLIC_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storage: tabStorage },
    });
    expect(localStorageGetter).not.toHaveBeenCalled();
    expect(sdk.createClient.mock.calls[0]?.[2].auth).not.toHaveProperty("flowType");
  });

  it("permite almacenamiento inyectado y no lee configuración otra vez después de inicializar", () => {
    const readEnvironment = vi.fn(() => ENVIRONMENT);
    const storage = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn(), clear: vi.fn(), key: vi.fn(), length: 0 };
    const getClient = createSupabaseBrowserClientProvider({ readEnvironment, getStorage: () => storage });
    expect(sdk.createClient).not.toHaveBeenCalled();
    expect(getClient()).toBe(getClient());
    expect(readEnvironment).toHaveBeenCalledTimes(1);
    expect(sdk.createClient).toHaveBeenCalledTimes(1);
    expect(sdk.createClient.mock.calls[0]?.[2].auth.storage).toBe(storage);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { ...ENVIRONMENT, VITE_SUPABASE_URL: "" },
    { ...ENVIRONMENT, VITE_SUPABASE_PUBLISHABLE_KEY: "" },
    { ...ENVIRONMENT, VITE_SUPABASE_URL: "not-a-url" },
    { ...ENVIRONMENT, VITE_SUPABASE_URL: "https:example.test" },
    { ...ENVIRONMENT, VITE_SUPABASE_URL: "http://remote.example.test" },
    { ...ENVIRONMENT, VITE_SUPABASE_URL: "https://user:synthetic@example.test" },
    { ...ENVIRONMENT, VITE_SUPABASE_URL: "https://example.test?key=synthetic" },
    { ...ENVIRONMENT, VITE_SUPABASE_URL: "https://example.test/path" },
    { ...ENVIRONMENT, VITE_SUPABASE_URL: "https://example.test#fragment" },
    { ...ENVIRONMENT, VITE_SUPABASE_URL: " https://example.test" },
    { ...ENVIRONMENT, VITE_SUPABASE_PUBLISHABLE_KEY: ["sb", "secret", "synthetic_private_key_for_tests"].join("_") },
    { ...ENVIRONMENT, VITE_SUPABASE_PUBLISHABLE_KEY: "legacy-key-not-supported" },
  ])("rechaza configuración ausente o inválida sin inicializar ni revelar valores (%#)", (source) => {
    const getClient = createSupabaseBrowserClientProvider({ readEnvironment: () => source });
    expect(() => getClient()).toThrow("La configuración pública de autenticación no está disponible o no es válida.");
    expect(sdk.createClient).not.toHaveBeenCalled();
  });

  it("acepta HTTPS y HTTP exclusivamente de loopback", () => {
    for (const url of ["https://example.test", "http://localhost:54321", "http://127.0.0.1:54321", "http://[::1]:54321"]) {
      expect(loadSupabaseBrowserConfig({ ...ENVIRONMENT, VITE_SUPABASE_URL: url })).toEqual({ url, publishableKey: PUBLIC_KEY });
    }
  });

  it("controla la ausencia de window o el bloqueo de sessionStorage", () => {
    const getClient = createSupabaseBrowserClientProvider({ readEnvironment: () => ENVIRONMENT });
    vi.spyOn(window, "sessionStorage", "get").mockImplementation(() => { throw new Error("Detalle interno privado"); });
    expect(() => getClient()).toThrow(SupabaseBrowserClientError);
    vi.stubGlobal("window", undefined);
    expect(() => getClient()).toThrow(SupabaseBrowserClientError);
    expect(sdk.createClient).not.toHaveBeenCalled();
  });

  it("no cachea fallos y permite corregir configuración o reintentar inicialización", () => {
    let source = { ...ENVIRONMENT, VITE_SUPABASE_PUBLISHABLE_KEY: "" };
    const getClient = createSupabaseBrowserClientProvider({ readEnvironment: () => source });
    expect(() => getClient()).toThrow(SupabaseBrowserConfigurationError);
    source = ENVIRONMENT;
    sdk.createClient.mockImplementationOnce(() => { throw new Error("Detalle interno privado"); });
    expect(() => getClient()).toThrow("No fue posible preparar el cliente de autenticación de esta pestaña.");
    const result = getClient();
    expect(getClient()).toBe(result);
    expect(sdk.createClient).toHaveBeenCalledTimes(2);
  });

  it("mantiene públicos solamente los dos nombres Vite y no importa código backend", () => {
    const source = readFileSync(resolve(process.cwd(), "src/supabase-client.ts"), "utf8");
    expect(source).not.toContain(["SUPABASE", "SECRET", "KEY"].join("_"));
    expect(source).not.toContain(["service", "role"].join("_"));
    expect(source).not.toContain(["sb", "secret", ""].join("_"));
    expect(source).not.toMatch(/localStorage|apps\/api|\.\.\/.*api|console\.|process\.env/u);
    expect([...new Set(source.match(/VITE_[A-Z_]+/gu))].sort()).toEqual([
      "VITE_SUPABASE_PUBLISHABLE_KEY", "VITE_SUPABASE_URL",
    ]);
    expect(readFileSync(resolve(process.cwd(), ".env.example"), "utf8").trim().split(/\r?\n/u)).toEqual([
      "VITE_SUPABASE_URL=", "VITE_SUPABASE_PUBLISHABLE_KEY=",
    ]);
  });
});
