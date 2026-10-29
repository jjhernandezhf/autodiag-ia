import { describe, expect, it } from "vitest";

import {
  DEFAULT_ANALYSIS_IDEMPOTENCY_MAX_ENTRIES,
  DEFAULT_ANALYSIS_IDEMPOTENCY_TTL_MS,
  DEFAULT_ANALYSIS_TOTAL_TIMEOUT_MS,
  DEFAULT_DIAGNOSTIC_HISTORY_SAVE_TIMEOUT_MS,
  DEFAULT_OPENAI_EMBEDDING_MODEL,
  DEFAULT_OPENAI_TIMEOUT_MS,
  DEFAULT_PDF_EXTRACTION_LIMITS,
  DEFAULT_RAG_MATCH_COUNT,
  DEFAULT_RAG_MATCH_THRESHOLD,
  DEFAULT_RAG_MAX_CONTEXT_CHARACTERS,
  loadEnv,
  resolveDiagnosticHistorySaveTimeout,
  resolveAnalysisTotalTimeout,
  resolvePdfExtractionLimits,
} from "./config.js";

describe("configuración sensible", () => {
  it.each([undefined, "", "   "])("conserva esfuerzo omitido para %s", (effort) => {
    const env = loadEnv({ VIN_HMAC_SECRET: "synthetic-config-secret-with-32-bytes", OPENAI_MODEL: "modelo-previo",
      ...(effort === undefined ? {} : { OPENAI_REASONING_EFFORT: effort }) });
    expect(env.OPENAI_REASONING_EFFORT).toBeUndefined();
  });

  it.each(["gpt-6.1-sol", "gpt-5.6-luna"])("acepta low explícito en %s", (model) => {
    const env = loadEnv({ VIN_HMAC_SECRET: "synthetic-config-secret-with-32-bytes", OPENAI_MODEL: ` ${model} `,
      OPENAI_REASONING_EFFORT: " low " });
    expect(env.OPENAI_REASONING_EFFORT).toBe("low");
    expect(env.OPENAI_MODEL).toBe(model);
  });

  it.each(["none", "minimal", "medium", "high", "max", "LOW", "invalid"])("rechaza esfuerzo fuera del alcance %s", (effort) => {
    expect(() => loadEnv({ VIN_HMAC_SECRET: "synthetic-config-secret-with-32-bytes", OPENAI_MODEL: "gpt-6.1-sol",
      OPENAI_REASONING_EFFORT: effort })).toThrow();
  });

  it.each([undefined, "", "gpt-4.1", "modelo-no-verificado"])("rechaza low sin compatibilidad verificada: %s", (model) => {
    expect(() => loadEnv({ VIN_HMAC_SECRET: "synthetic-config-secret-with-32-bytes", OPENAI_MODEL: model,
      OPENAI_REASONING_EFFORT: "low" })).toThrow();
  });

  it.each([150_001, 180_000, 1.5, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])("rechaza presupuesto integral inválido %s en ambos esquemas", (value) => {
    expect(() => resolveAnalysisTotalTimeout(value)).toThrow();
    expect(() => loadEnv({ VIN_HMAC_SECRET: "synthetic-config-secret-with-32-bytes", ANALYSIS_TOTAL_TIMEOUT_MS: String(value) })).toThrow();
  });

  it("conserva el presupuesto predeterminado de 80000 para blancos", () => {
    expect(resolveAnalysisTotalTimeout(80_000)).toBe(80_000);
    expect(resolveAnalysisTotalTimeout()).toBe(80_000);
    for (const value of ["", "   ", "80000"]) {
      expect(loadEnv({ VIN_HMAC_SECRET: "synthetic-config-secret-with-32-bytes", ANALYSIS_TOTAL_TIMEOUT_MS: value }).ANALYSIS_TOTAL_TIMEOUT_MS).toBe(80_000);
    }
  });
  it("permite 120 s por intento y 150 s totales sin aceptar presupuestos incoherentes", () => {
    const base = { VIN_HMAC_SECRET: "synthetic-config-secret-with-32-bytes", OPENAI_TIMEOUT_MS: "120000" };
    expect(loadEnv({ ...base, ANALYSIS_TOTAL_TIMEOUT_MS: "150000" }).OPENAI_TIMEOUT_MS).toBe(120_000);
    expect(resolveAnalysisTotalTimeout(150_000)).toBe(150_000);
    expect(() => loadEnv(base)).toThrow();
    expect(() => loadEnv({ ...base, ANALYSIS_TOTAL_TIMEOUT_MS: "120000" })).toThrow();
    expect(() => loadEnv({ ...base, OPENAI_TIMEOUT_MS: "120001", ANALYSIS_TOTAL_TIMEOUT_MS: "150000" })).toThrow();
  });
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
    expect(env.ANALYSIS_TOTAL_TIMEOUT_MS).toBe(DEFAULT_ANALYSIS_TOTAL_TIMEOUT_MS);
    expect(env.ANALYSIS_IDEMPOTENCY_TTL_MS).toBe(DEFAULT_ANALYSIS_IDEMPOTENCY_TTL_MS);
    expect(env.ANALYSIS_IDEMPOTENCY_MAX_ENTRIES).toBe(DEFAULT_ANALYSIS_IDEMPOTENCY_MAX_ENTRIES);
    expect(env.DIAGNOSTIC_HISTORY_SAVE_TIMEOUT_MS).toBe(DEFAULT_DIAGNOSTIC_HISTORY_SAVE_TIMEOUT_MS);
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
      ANALYSIS_TOTAL_TIMEOUT_MS: " ",
      ANALYSIS_IDEMPOTENCY_TTL_MS: "",
      ANALYSIS_IDEMPOTENCY_MAX_ENTRIES: "\t",
      DIAGNOSTIC_HISTORY_SAVE_TIMEOUT_MS: "\t",
      RAG_ENABLED: "",
      OPENAI_EMBEDDING_MODEL: " ",
      RAG_MATCH_COUNT: "",
      RAG_MATCH_THRESHOLD: " ",
      RAG_MAX_CONTEXT_CHARACTERS: "",
    });

    expect(env.PORT).toBe(3_000);
    expect(env.REPORT_MAX_SIZE_BYTES).toBe(10 * 1024 * 1024);
    expect(env.OPENAI_TIMEOUT_MS).toBe(DEFAULT_OPENAI_TIMEOUT_MS);
    expect(env.ANALYSIS_TOTAL_TIMEOUT_MS).toBe(DEFAULT_ANALYSIS_TOTAL_TIMEOUT_MS);
    expect(env.ANALYSIS_IDEMPOTENCY_TTL_MS).toBe(DEFAULT_ANALYSIS_IDEMPOTENCY_TTL_MS);
    expect(env.ANALYSIS_IDEMPOTENCY_MAX_ENTRIES).toBe(DEFAULT_ANALYSIS_IDEMPOTENCY_MAX_ENTRIES);
    expect(env.DIAGNOSTIC_HISTORY_SAVE_TIMEOUT_MS).toBe(DEFAULT_DIAGNOSTIC_HISTORY_SAVE_TIMEOUT_MS);
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

  it("exige una jerarquía segura entre OpenAI y el presupuesto total", () => {
    const secret = "synthetic-config-secret-with-32-bytes";
    const env = loadEnv({
      VIN_HMAC_SECRET: secret,
      OPENAI_TIMEOUT_MS: "60000",
      ANALYSIS_TOTAL_TIMEOUT_MS: "80000",
      ANALYSIS_IDEMPOTENCY_TTL_MS: "600000",
      ANALYSIS_IDEMPOTENCY_MAX_ENTRIES: "500",
    });
    expect(env.OPENAI_TIMEOUT_MS).toBe(60_000);
    expect(env.ANALYSIS_TOTAL_TIMEOUT_MS).toBe(80_000);
    expect(() => loadEnv({
      VIN_HMAC_SECRET: secret,
      OPENAI_TIMEOUT_MS: "80000",
      ANALYSIS_TOTAL_TIMEOUT_MS: "80000",
    })).toThrow();
  });

  it("valida el timeout limitado del guardado de historial", () => {
    const secret = "synthetic-config-secret-with-32-bytes";
    expect(loadEnv({ VIN_HMAC_SECRET: secret, DIAGNOSTIC_HISTORY_SAVE_TIMEOUT_MS: "100" })
      .DIAGNOSTIC_HISTORY_SAVE_TIMEOUT_MS).toBe(100);
    expect(loadEnv({ VIN_HMAC_SECRET: secret, DIAGNOSTIC_HISTORY_SAVE_TIMEOUT_MS: "10000" })
      .DIAGNOSTIC_HISTORY_SAVE_TIMEOUT_MS).toBe(10_000);
    expect(() => loadEnv({ VIN_HMAC_SECRET: secret, DIAGNOSTIC_HISTORY_SAVE_TIMEOUT_MS: "99" })).toThrow();
    expect(() => loadEnv({ VIN_HMAC_SECRET: secret, DIAGNOSTIC_HISTORY_SAVE_TIMEOUT_MS: "10001" })).toThrow();
    expect(() => resolveDiagnosticHistorySaveTimeout(99)).toThrow();
    expect(() => resolveDiagnosticHistorySaveTimeout(10_001)).toThrow();
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
