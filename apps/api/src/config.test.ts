import { describe, expect, it } from "vitest";

import {
  DEFAULT_OPENAI_EMBEDDING_MODEL,
  DEFAULT_OPENAI_TIMEOUT_MS,
  DEFAULT_PDF_EXTRACTION_LIMITS,
  DEFAULT_RAG_MATCH_COUNT,
  DEFAULT_RAG_MATCH_THRESHOLD,
  DEFAULT_RAG_MAX_CONTEXT_CHARACTERS,
  loadEnv,
  resolvePdfExtractionLimits,
} from "./config.js";

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
    expect(env.RAG_ENABLED).toBe(false);
    expect(env.OPENAI_EMBEDDING_MODEL).toBe(DEFAULT_OPENAI_EMBEDDING_MODEL);
    expect(env.RAG_MATCH_COUNT).toBe(DEFAULT_RAG_MATCH_COUNT);
    expect(env.RAG_MATCH_THRESHOLD).toBe(DEFAULT_RAG_MATCH_THRESHOLD);
    expect(env.RAG_MAX_CONTEXT_CHARACTERS).toBe(DEFAULT_RAG_MAX_CONTEXT_CHARACTERS);
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
      RAG_ENABLED: "",
      OPENAI_EMBEDDING_MODEL: " ",
      RAG_MATCH_COUNT: "",
      RAG_MATCH_THRESHOLD: " ",
      RAG_MAX_CONTEXT_CHARACTERS: "",
    });

    expect(env.PORT).toBe(3_000);
    expect(env.REPORT_MAX_SIZE_BYTES).toBe(10 * 1024 * 1024);
    expect(env.OPENAI_TIMEOUT_MS).toBe(DEFAULT_OPENAI_TIMEOUT_MS);
    expect(env.RAG_ENABLED).toBe(false);
    expect(env.OPENAI_EMBEDDING_MODEL).toBe(DEFAULT_OPENAI_EMBEDDING_MODEL);
    expect(env.RAG_MATCH_COUNT).toBe(DEFAULT_RAG_MATCH_COUNT);
    expect(env.RAG_MATCH_THRESHOLD).toBe(DEFAULT_RAG_MATCH_THRESHOLD);
    expect(env.RAG_MAX_CONTEXT_CHARACTERS).toBe(DEFAULT_RAG_MAX_CONTEXT_CHARACTERS);
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

describe("configuración RAG", () => {
  const secret = "synthetic-config-secret-with-32-bytes";

  it("acepta activación explícita y separa el modelo de embeddings", () => {
    const env = loadEnv({
      VIN_HMAC_SECRET: secret,
      RAG_ENABLED: "true",
      OPENAI_EMBEDDING_MODEL: "text-embedding-3-small",
      RAG_MATCH_COUNT: "5",
      RAG_MATCH_THRESHOLD: "0.75",
      RAG_MAX_CONTEXT_CHARACTERS: "7000",
    });
    expect(env).toMatchObject({
      RAG_ENABLED: true,
      OPENAI_EMBEDDING_MODEL: "text-embedding-3-small",
      RAG_MATCH_COUNT: 5,
      RAG_MATCH_THRESHOLD: 0.75,
      RAG_MAX_CONTEXT_CHARACTERS: 7_000,
    });
  });

  it.each([
    ["RAG_ENABLED", "yes"],
    ["RAG_MATCH_COUNT", "11"],
    ["RAG_MATCH_THRESHOLD", "1.1"],
    ["RAG_MAX_CONTEXT_CHARACTERS", "499"],
  ])("rechaza %s fuera de contrato", (name, value) => {
    expect(() => loadEnv({ VIN_HMAC_SECRET: secret, [name]: value })).toThrow();
  });
});
