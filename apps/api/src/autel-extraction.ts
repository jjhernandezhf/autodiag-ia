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
  manualTranscription = false,
): Promise<AutelExtraction> {
  const pages = await extractor(buffer);
  // Recognized complete reports (especially a coherent zero-DTC report) keep
  // their normal result even through the contingency endpoint.
  if (detectAutelVehicleDiagnosticReport(pages)) return parseAutelReport(pages, vinHmacSecret);
  // Text extraction must succeed first; this is not OCR or a bypass for corrupt PDFs.
  const text = pages.flatMap(p => p.lines.map(l => l.text)).join("\n");
  const family = /\b(?:Autel|MaxiCOM|MaxiSys)\b/iu.test(text) || /(?:informe de diagn[oó]stico de veh[ií]culo|vehicle diagnostic report)/iu.test(text);
  if (!text.trim() || (!manualTranscription && (!family || !/\b(?:DTC|diagnostic|diagnóstico|diagnostico)\b/iu.test(text)))) throw new AutelFormatError();
  const partial = parseAutelReport(pages, vinHmacSecret);
  partial.status = "partial"; partial.requiresManualReview = true;
  partial.warnings.push({ code: "MANUAL_TRANSCRIPTION_REQUIRED", message: "Texto legible sin estructura confirmada. Transcribe solo datos técnicos revisados; no se confirmó el tipo ni la integridad del reporte." });
  if (manualTranscription) partial.warnings.push({ code: "DOCUMENT_TYPE_UNCONFIRMED", message: "El sistema no confirma que sea Autel. Verifica personalmente el tipo y la legibilidad del documento, explica la evidencia y transcribe solo sus datos técnicos. No acredita procedencia del fabricante." });
  return partial;
}

export type SafeExtractionError = PdfExtractionError | AutelFormatError;
