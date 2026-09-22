import { z } from "zod";

export const DEFAULT_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
export const DEFAULT_OPENAI_TIMEOUT_MS = 20_000;
export const DEFAULT_OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
export const DEFAULT_RAG_MATCH_COUNT = 4;
export const DEFAULT_RAG_MATCH_THRESHOLD = 0.7;
export const DEFAULT_RAG_MAX_CONTEXT_CHARACTERS = 6_000;

export interface PdfExtractionLimits {
  maxPages: number;
  maxTextItems: number;
  maxCharacters: number;
  timeoutMs: number;
  workerMemoryMb: number;
}

export const DEFAULT_PDF_EXTRACTION_LIMITS: PdfExtractionLimits = {
  maxPages: 100,
  maxTextItems: 100_000,
  maxCharacters: 2_000_000,
  timeoutMs: 15_000,
  workerMemoryMb: 192,
};

const pdfExtractionLimitsSchema = z.object({
  maxPages: z.number().int().min(1).max(1_000),
  maxTextItems: z.number().int().min(1).max(1_000_000),
  maxCharacters: z.number().int().min(1).max(20_000_000),
  timeoutMs: z.number().int().min(100).max(120_000),
  workerMemoryMb: z.number().int().min(16).max(512),
});

export function resolvePdfExtractionLimits(input: Partial<PdfExtractionLimits> = {}): PdfExtractionLimits {
  return pdfExtractionLimitsSchema.parse({ ...DEFAULT_PDF_EXTRACTION_LIMITS, ...input });
}

function emptyEnvironmentValueAsUndefined(value: unknown) {
  return typeof value === "string" && value.trim() === "" ? undefined : value;
}

function optionalIntegerFromEnvironment(minimum: number, maximum: number, defaultValue: number) {
  return z.preprocess(
    emptyEnvironmentValueAsUndefined,
    z.coerce.number().int().min(minimum).max(maximum).default(defaultValue),
  );
}

function optionalNumberFromEnvironment(minimum: number, maximum: number, defaultValue: number) {
  return z.preprocess(
    emptyEnvironmentValueAsUndefined,
    z.coerce.number().finite().min(minimum).max(maximum).default(defaultValue),
  );
}

const optionalBooleanFromEnvironment = z.preprocess(
  emptyEnvironmentValueAsUndefined,
  z.union([
    z.boolean(),
    z.enum(["true", "false"]).transform((value) => value === "true"),
  ]).default(false),
);

const envSchema = z.object({
  PORT: optionalIntegerFromEnvironment(1, 65_535, 3_000),
  REPORT_MAX_SIZE_BYTES: optionalIntegerFromEnvironment(1, 100 * 1024 * 1024, DEFAULT_MAX_FILE_SIZE_BYTES),
  PDF_EXTRACTION_MAX_PAGES: optionalIntegerFromEnvironment(1, 1_000, DEFAULT_PDF_EXTRACTION_LIMITS.maxPages),
  PDF_EXTRACTION_MAX_TEXT_ITEMS: optionalIntegerFromEnvironment(
    1,
    1_000_000,
    DEFAULT_PDF_EXTRACTION_LIMITS.maxTextItems,
  ),
  PDF_EXTRACTION_MAX_CHARACTERS: optionalIntegerFromEnvironment(
    1,
    20_000_000,
    DEFAULT_PDF_EXTRACTION_LIMITS.maxCharacters,
  ),
  PDF_EXTRACTION_TIMEOUT_MS: optionalIntegerFromEnvironment(100, 120_000, DEFAULT_PDF_EXTRACTION_LIMITS.timeoutMs),
  PDF_EXTRACTION_WORKER_MEMORY_MB: optionalIntegerFromEnvironment(
    16,
    512,
    DEFAULT_PDF_EXTRACTION_LIMITS.workerMemoryMb,
  ),
  OPENAI_API_KEY: z.preprocess(
    emptyEnvironmentValueAsUndefined,
    z.string().trim().min(1).optional(),
  ),
  OPENAI_MODEL: z.preprocess(
    emptyEnvironmentValueAsUndefined,
    z.string().trim().min(1).max(100).optional(),
  ),
  OPENAI_TIMEOUT_MS: optionalIntegerFromEnvironment(1_000, 120_000, DEFAULT_OPENAI_TIMEOUT_MS),
  RAG_ENABLED: optionalBooleanFromEnvironment,
  OPENAI_EMBEDDING_MODEL: z.preprocess(
    emptyEnvironmentValueAsUndefined,
    z.string().trim().min(1).max(100).default(DEFAULT_OPENAI_EMBEDDING_MODEL),
  ),
  RAG_MATCH_COUNT: optionalIntegerFromEnvironment(1, 10, DEFAULT_RAG_MATCH_COUNT),
  RAG_MATCH_THRESHOLD: optionalNumberFromEnvironment(0, 1, DEFAULT_RAG_MATCH_THRESHOLD),
  RAG_MAX_CONTEXT_CHARACTERS: optionalIntegerFromEnvironment(500, 20_000, DEFAULT_RAG_MAX_CONTEXT_CHARACTERS),
  VIN_HMAC_SECRET: z.string().refine((value) => Buffer.byteLength(value, "utf8") >= 32, {
    message: "VIN_HMAC_SECRET debe contener al menos 32 bytes.",
  }),
});

export function loadEnv(source: NodeJS.ProcessEnv = process.env) {
  return envSchema.parse(source);
}
