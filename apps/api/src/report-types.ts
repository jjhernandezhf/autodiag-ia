import type { DiagnosticAnalysisInput } from "./ai-analysis-types.js";

export interface ExtractedTextFragment {
  text: string;
  x: number;
  width: number;
}

export interface ExtractedTextLine {
  text: string;
  y: number;
  fragments: ExtractedTextFragment[];
}

export interface ExtractedPdfPage {
  pageNumber: number;
  lines: ExtractedTextLine[];
}

export type DtcStatus =
  | "current"
  | "confirmed"
  | "stored"
  | "pending"
  | "permanent"
  | "intermittent"
  | "history"
  | "unknown";

export type DtcClassification = "actionable" | "historical" | "unknown";

export interface ExtractionWarning {
  code: string;
  message: string;
}

export interface VehicleData {
  year: number | null;
  make: string | null;
  model: string | null;
  engine: string | null;
  odometer: { value: number; unit: "km" | "mi" } | null;
  vinMasked: string | null;
  vinPseudonym: string | null;
}

export interface ScannedSystem {
  code: string | null;
  name: string;
  dtcCount: number;
}

export interface ParsedDtc {
  code: string;
  moduleCode: string | null;
  moduleName: string;
  status: DtcStatus;
  statusOriginal: string | null;
  classification: DtcClassification;
  descriptionOriginal: string;
}

export interface AutelExtraction {
  status: "completed" | "partial";
  format: "autel_vehicle_diagnostic_report";
  requiresManualReview: boolean;
  vehicle: VehicleData;
  scanSummary: {
    declaredSystems: number | null;
    parsedSystems: number;
    declaredDtcs: number | null;
    parsedDtcs: number;
  };
  systems: ScannedSystem[];
  dtcs: ParsedDtc[];
  warnings: ExtractionWarning[];
}

export type AiAnalysisAvailabilityReasonCode =
  | "EXTRACTION_INCOMPLETE"
  | "MANUAL_REVIEW_REQUIRED"
  | "SYSTEM_TOTAL_MISMATCH"
  | "DTC_TOTAL_MISMATCH"
  | "EXTRACTION_DATA_INCONSISTENT"
  | "VEHICLE_DATA_MISSING"
  | "NO_VALID_DTCS"
  | "MODULE_DATA_INVALID"
  | "DTC_DATA_INVALID"
  | "UNKNOWN_DTC_STATUS"
  | "ONLY_HISTORICAL_DTCS"
  | "DTC_DESCRIPTION_CONFLICT"
  | "DTC_STATUS_CONFLICT"
  | "DTC_MODULE_MISMATCH"
  | "SENSITIVE_CONTENT_DETECTED"
  | "ANALYSIS_LIMIT_EXCEEDED";

export interface AiAnalysisAvailabilityReason {
  code: AiAnalysisAvailabilityReasonCode;
  message: string;
}

interface AiAnalysisPreparationBase {
  reasons: AiAnalysisAvailabilityReason[];
  warnings: string[];
  counts: {
    detected: number;
    actionable: number;
    historical: number;
  };
}

export interface AvailableAiAnalysisPreparation extends AiAnalysisPreparationBase {
  available: true;
  input: DiagnosticAnalysisInput;
}

export interface UnavailableAiAnalysisPreparation extends AiAnalysisPreparationBase {
  available: false;
}

export type AiAnalysisPreparation = AvailableAiAnalysisPreparation | UnavailableAiAnalysisPreparation;

export interface UploadResponseBody {
  id: string;
  originalName: string;
  size: number;
  sha256: string;
  type: "application/pdf";
  status: "received";
  extraction: AutelExtraction;
  analysisPreparation: AiAnalysisPreparation;
}
