import { z } from "zod";

export const DEFAULT_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
export const DEFAULT_OPENAI_TIMEOUT_MS = 20_000;

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

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(3_000),
  REPORT_MAX_SIZE_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .max(100 * 1024 * 1024)
    .default(DEFAULT_MAX_FILE_SIZE_BYTES),
  PDF_EXTRACTION_MAX_PAGES: z.coerce.number().int().min(1).max(1_000).default(DEFAULT_PDF_EXTRACTION_LIMITS.maxPages),
  PDF_EXTRACTION_MAX_TEXT_ITEMS: z.coerce
    .number()
    .int()
    .min(1)
    .max(1_000_000)
    .default(DEFAULT_PDF_EXTRACTION_LIMITS.maxTextItems),
  PDF_EXTRACTION_MAX_CHARACTERS: z.coerce
    .number()
    .int()
    .min(1)
    .max(20_000_000)
    .default(DEFAULT_PDF_EXTRACTION_LIMITS.maxCharacters),
  PDF_EXTRACTION_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(120_000)
    .default(DEFAULT_PDF_EXTRACTION_LIMITS.timeoutMs),
  PDF_EXTRACTION_WORKER_MEMORY_MB: z.coerce
    .number()
    .int()
    .min(16)
    .max(512)
    .default(DEFAULT_PDF_EXTRACTION_LIMITS.workerMemoryMb),
  OPENAI_API_KEY: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().trim().min(1).optional(),
  ),
  OPENAI_MODEL: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().trim().min(1).max(100).optional(),
  ),
  OPENAI_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(DEFAULT_OPENAI_TIMEOUT_MS),
  VIN_HMAC_SECRET: z.string().refine((value) => Buffer.byteLength(value, "utf8") >= 32, {
    message: "VIN_HMAC_SECRET debe contener al menos 32 bytes.",
  }),
});

export function loadEnv(source: NodeJS.ProcessEnv = process.env) {
  return envSchema.parse(source);
}
