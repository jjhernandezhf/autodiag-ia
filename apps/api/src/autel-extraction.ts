import { parseAutelReport } from "./autel-parser.js";
import { detectAutelVehicleDiagnosticReport } from "./autel-detector.js";
import { extractPdfPages, type PdfExtractionError } from "./pdf-extractor.js";
import type { AutelExtraction, ExtractedPdfPage } from "./report-types.js";

export type PdfPageExtractor = (buffer: Buffer) => Promise<ExtractedPdfPage[]>;

export class AutelFormatError extends Error {
  readonly code = "AUTEL_FORMAT_NOT_RECOGNIZED";

  constructor() {
    super("El PDF no corresponde a un reporte Autel compatible.");
  }
}

export async function extractAutelReport(
  buffer: Buffer,
  vinHmacSecret: string,
  extractor: PdfPageExtractor = extractPdfPages,
): Promise<AutelExtraction> {
  const pages = await extractor(buffer);
  if (!detectAutelVehicleDiagnosticReport(pages)) throw new AutelFormatError();
  return parseAutelReport(pages, vinHmacSecret);
}

export type SafeExtractionError = PdfExtractionError | AutelFormatError;
