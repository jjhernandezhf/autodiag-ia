import { z } from "zod";

export const DEFAULT_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(3_000),
  REPORT_MAX_SIZE_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .max(100 * 1024 * 1024)
    .default(DEFAULT_MAX_FILE_SIZE_BYTES),
});

export const env = envSchema.parse(process.env);
