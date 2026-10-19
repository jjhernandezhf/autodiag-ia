import { z } from "zod";
import { resolvePdfExtractionLimits, type PdfExtractionLimits } from "./config.js";
import type { ExtractedPdfPage } from "./report-types.js";

export const MAX_PDF_INPUT_BYTES = 100 * 1024 * 1024;
export const PDF_PROCESS_TIMEOUT_EXIT_CODE = 124;
export const PDF_PROCESS_ERROR_CODES = ["PDF_ENCRYPTED", "PDF_UNREADABLE", "PDF_NO_USABLE_TEXT", "PDF_EXTRACTION_LIMIT_EXCEEDED", "PDF_EXTRACTION_ERROR"] as const;
export type PdfProcessResponse = { ok: true; pages: ExtractedPdfPage[] } | { ok: false; code: typeof PDF_PROCESS_ERROR_CODES[number] };
const limitsSchema = z.object({ maxPages: z.number(), maxTextItems: z.number(), maxCharacters: z.number(), timeoutMs: z.number(), workerMemoryMb: z.number() }).strict();
export const requestHeaderSchema = z.object({ size: z.number().int().min(1).max(MAX_PDF_INPUT_BYTES), deadlineAtMs: z.number().int().positive(), limits: limitsSchema }).strict()
  .transform((header) => ({ ...header, limits: resolvePdfExtractionLimits(header.limits) }));

// Escaped text appears twice (lines/fragments); include coordinates and keys.
export function maxPdfResponseBytes(limits: PdfExtractionLimits) {
  return 1024 + limits.maxCharacters * 24 + limits.maxTextItems * 512 + limits.maxPages * 128;
}
const finite = z.number().finite();
// reconstructLines retains the original y coordinate on each fragment.
const fragmentSchema = z.object({ text: z.string(), x: finite, y: finite.optional(), width: finite }).strict();
const lineSchema = z.object({ text: z.string(), y: finite, fragments: z.array(fragmentSchema) }).strict();
export function parsePdfProcessResponse(value: unknown, limits: PdfExtractionLimits): PdfProcessResponse {
  const response = z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(false), code: z.enum(PDF_PROCESS_ERROR_CODES) }).strict(),
    z.object({ ok: z.literal(true), pages: z.array(z.object({ pageNumber: z.number().int().positive(), lines: z.array(lineSchema) }).strict()).min(1).max(limits.maxPages) }).strict(),
  ]).parse(value);
  if (!response.ok) return response;
  let items = 0, lines = 0, characters = 0, lineCharacters = 0;
  for (const [index, page] of response.pages.entries()) {
    if (page.pageNumber !== index + 1) throw new Error("Invalid page order");
    for (const line of page.lines) {
      lines++; lineCharacters += line.text.length;
      for (const fragment of line.fragments) { items++; characters += fragment.text.length; }
    }
  }
  if (items > limits.maxTextItems || lines > limits.maxTextItems || characters > limits.maxCharacters
    || lineCharacters > limits.maxCharacters + limits.maxTextItems) throw new Error("Invalid response budget");
  return response;
}
