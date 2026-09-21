import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { loadEnv } from "./config.js";
import { loadSupabaseAdminConfig, loadSupabasePublicConfig, SupabaseConfigurationError } from "./supabase-config.js";

const PROJECT_URL = "https://synthetic-project.example.test";
const PUBLIC_KEY = ["sb", "publishable", "synthetic_public_key_for_tests"].join("_");
const SECRET_KEY = ["sb", "secret", "synthetic_private_key_for_tests"].join("_");

describe("contratos Supabase del servidor", () => {
  it("proyecta solamente la configuración propia de cada responsabilidad", () => {
    const source = { SUPABASE_URL: `${PROJECT_URL}/`, SUPABASE_PUBLISHABLE_KEY: PUBLIC_KEY, SUPABASE_SECRET_KEY: SECRET_KEY, OTHER: "ignored" };
    expect(loadSupabaseAdminConfig(source)).toEqual({ url: PROJECT_URL, secretKey: SECRET_KEY });
    expect(loadSupabasePublicConfig(source)).toEqual({ url: PROJECT_URL, publishableKey: PUBLIC_KEY });
    expect(loadSupabasePublicConfig({ SUPABASE_URL: PROJECT_URL, SUPABASE_PUBLISHABLE_KEY: PUBLIC_KEY })).toEqual({ url: PROJECT_URL, publishableKey: PUBLIC_KEY });
    expect(loadSupabaseAdminConfig({ SUPABASE_URL: PROJECT_URL, SUPABASE_SECRET_KEY: SECRET_KEY })).toEqual({ url: PROJECT_URL, secretKey: SECRET_KEY });
  });

  it.each([undefined, "", " ", "not-a-url", "https:example.test", "http://remote.example.test", "https://user:synthetic@example.test", "https://example.test/path", "https://example.test?key=synthetic", "https://example.test#fragment", " https://example.test"])(
    "rechaza URL ausente o inválida en ambos contratos (%#)", (url) => {
      expect(() => loadSupabaseAdminConfig({ SUPABASE_URL: url, SUPABASE_SECRET_KEY: SECRET_KEY })).toThrow(SupabaseConfigurationError);
      expect(() => loadSupabasePublicConfig({ SUPABASE_URL: url, SUPABASE_PUBLISHABLE_KEY: PUBLIC_KEY })).toThrow(SupabaseConfigurationError);
    },
  );

  it.each([undefined, "", " ", "legacy-key-not-supported", PUBLIC_KEY, `${SECRET_KEY} `, "x".repeat(513)])(
    "rechaza clave administrativa ausente, pública o inválida (%#)", (key) => {
      expect(() => loadSupabaseAdminConfig({ SUPABASE_URL: PROJECT_URL, SUPABASE_SECRET_KEY: key })).toThrow(SupabaseConfigurationError);
    },
  );

  it.each([undefined, "", " ", "legacy-key-not-supported", SECRET_KEY, `${PUBLIC_KEY} `, "x".repeat(513)])(
    "rechaza clave pública ausente, administrativa o inválida (%#)", (key) => {
      expect(() => loadSupabasePublicConfig({ SUPABASE_URL: PROJECT_URL, SUPABASE_PUBLISHABLE_KEY: key })).toThrow(SupabaseConfigurationError);
    },
  );

  it("admite desarrollo HTTP exclusivamente en loopback", () => {
    for (const url of ["http://localhost:54321", "http://127.0.0.1:54321", "http://[::1]:54321"]) {
      expect(loadSupabasePublicConfig({ SUPABASE_URL: url, SUPABASE_PUBLISHABLE_KEY: PUBLIC_KEY }).url).toBe(url);
    }
  });

  it("emite errores fijos sin claves, URL, issues Zod, causa ni entorno", () => {
    try {
      loadSupabaseAdminConfig({ SUPABASE_URL: "https://synthetic-private.example.test/path", SUPABASE_SECRET_KEY: SECRET_KEY });
      throw new Error("Se esperaba rechazo");
    } catch (error) {
      expect(error).toBeInstanceOf(SupabaseConfigurationError);
      const controlled = error as SupabaseConfigurationError;
      expect(controlled.code).toBe("SUPABASE_CONFIGURATION_INVALID");
      expect(controlled.message).toBe("La configuración de autenticación del servidor no está disponible o no es válida.");
      expect(JSON.stringify(controlled)).not.toContain(SECRET_KEY);
      expect(controlled.stack).not.toContain("synthetic-private.example.test");
      expect(controlled).not.toHaveProperty("cause");
      expect(controlled).not.toHaveProperty("issues");
    }
  });

  it("conserva el arranque actual sin variables Supabase", () => {
    expect(() => loadEnv({ VIN_HMAC_SECRET: "synthetic-config-secret-with-32-bytes" })).not.toThrow();
  });

  it("prepara ejemplos vacíos y mantiene ignorados los env reales en cualquier workspace", () => {
    const example = readFileSync(new URL("../../../.env.example", import.meta.url), "utf8");
    const entries = example.trim().split(/\r?\n/u);
    expect(entries.every((entry) => /^[A-Z_]+=$/u.test(entry))).toBe(true);
    expect(entries).toEqual(expect.arrayContaining(["SUPABASE_URL=", "SUPABASE_PUBLISHABLE_KEY=", "SUPABASE_SECRET_KEY="]));
    const ignore = readFileSync(new URL("../../../.gitignore", import.meta.url), "utf8");
    expect(ignore.split(/\r?\n/u)).toEqual(expect.arrayContaining([".env", ".env.*", "!.env.example"]));
  });
});
