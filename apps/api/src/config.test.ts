import { describe, expect, it } from "vitest";

import { DEFAULT_OPENAI_TIMEOUT_MS, DEFAULT_PDF_EXTRACTION_LIMITS, loadEnv, resolvePdfExtractionLimits } from "./config.js";

describe("configuración sensible", () => {
  it("rechaza el arranque cuando falta VIN_HMAC_SECRET", () => {
    expect(() => loadEnv({})).toThrow();
  });

  it("rechaza secretos menores de 32 bytes", () => {
    expect(() => loadEnv({ VIN_HMAC_SECRET: "demasiado-corto" })).toThrow();
  });

  it("acepta una clave sintética segura sin cambiar los valores predeterminados", () => {
    const env = loadEnv({ VIN_HMAC_SECRET: "synthetic-config-secret-with-32-bytes" });

    expect(env.PORT).toBe(3000);
    expect(env.REPORT_MAX_SIZE_BYTES).toBe(10 * 1024 * 1024);
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.OPENAI_MODEL).toBeUndefined();
    expect(env.OPENAI_TIMEOUT_MS).toBe(DEFAULT_OPENAI_TIMEOUT_MS);
    expect({
      maxPages: env.PDF_EXTRACTION_MAX_PAGES,
      maxTextItems: env.PDF_EXTRACTION_MAX_TEXT_ITEMS,
      maxCharacters: env.PDF_EXTRACTION_MAX_CHARACTERS,
      timeoutMs: env.PDF_EXTRACTION_TIMEOUT_MS,
      workerMemoryMb: env.PDF_EXTRACTION_WORKER_MEMORY_MB,
    }).toEqual(DEFAULT_PDF_EXTRACTION_LIMITS);
  });

  it("interpreta variables numéricas opcionales vacías como ausentes", () => {
    const env = loadEnv({
      VIN_HMAC_SECRET: "synthetic-config-secret-with-32-bytes",
      PORT: " ",
      REPORT_MAX_SIZE_BYTES: "",
      PDF_EXTRACTION_MAX_PAGES: "\t",
      PDF_EXTRACTION_MAX_TEXT_ITEMS: "",
      PDF_EXTRACTION_MAX_CHARACTERS: " ",
      PDF_EXTRACTION_TIMEOUT_MS: "",
      PDF_EXTRACTION_WORKER_MEMORY_MB: "\r\n",
      OPENAI_TIMEOUT_MS: " ",
    });

    expect(env.PORT).toBe(3_000);
    expect(env.REPORT_MAX_SIZE_BYTES).toBe(10 * 1024 * 1024);
    expect(env.OPENAI_TIMEOUT_MS).toBe(DEFAULT_OPENAI_TIMEOUT_MS);
    expect({
      maxPages: env.PDF_EXTRACTION_MAX_PAGES,
      maxTextItems: env.PDF_EXTRACTION_MAX_TEXT_ITEMS,
      maxCharacters: env.PDF_EXTRACTION_MAX_CHARACTERS,
      timeoutMs: env.PDF_EXTRACTION_TIMEOUT_MS,
      workerMemoryMb: env.PDF_EXTRACTION_WORKER_MEMORY_MB,
    }).toEqual(DEFAULT_PDF_EXTRACTION_LIMITS);
  });

  it("mantiene VIN_HMAC_SECRET como configuración obligatoria aunque esté vacía", () => {
    expect(() => loadEnv({ VIN_HMAC_SECRET: "" })).toThrow();
    expect(() => loadEnv({ VIN_HMAC_SECRET: " " })).toThrow();
  });

  it.each([
    ["PDF_EXTRACTION_MAX_PAGES", "0"],
    ["PDF_EXTRACTION_MAX_TEXT_ITEMS", "0"],
    ["PDF_EXTRACTION_MAX_CHARACTERS", "0"],
    ["PDF_EXTRACTION_TIMEOUT_MS", "99"],
    ["PDF_EXTRACTION_WORKER_MEMORY_MB", "8"],
  ])("rechaza el valor inválido de %s", (name, value) => {
    expect(() => loadEnv({ VIN_HMAC_SECRET: "synthetic-config-secret-with-32-bytes", [name]: value })).toThrow();
  });

  it("valida también los límites inyectados en la aplicación", () => {
    expect(() => resolvePdfExtractionLimits({ maxPages: 0 })).toThrow();
    expect(() => resolvePdfExtractionLimits({ workerMemoryMb: 513 })).toThrow();
  });

  it("trata configuraciones OpenAI vacías como ausentes y valida el timeout", () => {
    const env = loadEnv({
      VIN_HMAC_SECRET: "synthetic-config-secret-with-32-bytes",
      OPENAI_API_KEY: " ",
      OPENAI_MODEL: "",
    });

    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.OPENAI_MODEL).toBeUndefined();
    expect(() =>
      loadEnv({ VIN_HMAC_SECRET: "synthetic-config-secret-with-32-bytes", OPENAI_TIMEOUT_MS: "999" }),
    ).toThrow();
  });
});
