import { type ChangeEvent, type DragEvent, type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import autodiagLogoUrl from "./assets/autodiag-ia-logo.png";
import { HistoryAnalyticsExport } from "./HistoryAnalyticsExport";
import { HistoryAutomation } from "./HistoryAutomation";
import { HistoryStatistics } from "./HistoryStatistics";
import { ReportReviewPanel } from "./ReportReviewPanel";
import { isReviewEvidence, isDtcObservations, isReviewContext, hasConsistentObservedStates, MAX_ANALYSIS_DTCS, MAX_ANALYSIS_OBSERVATIONS, type ReportReviewEvidence, type ReviewContext } from "./report-review-data";
import { describeRagProvenance, isRagProvenance } from "./rag-provenance";
import {
  API_UNAVAILABLE_MESSAGE,
  ApiRequestError,
  createBrowserApiClient,
  type BrowserApiClient,
} from "./api-client";
import {
  browserAuthenticationService,
  BrowserAuthenticationError,
  type AuthIdentity,
  type BrowserAuthenticationService,
} from "./auth-service";
import {
  buildReportExportModel,
  containsSensitiveReportText,
  downloadReportPdf,
  isSafeRagSourceUrl,
  type ReportExportSource,
} from "./report-pdf";

const PDF_MIME_TYPE = "application/pdf";
const MAX_VEHICLE_OBSERVATIONS_LENGTH = 1_000;

type UploadStatus = "idle" | "uploading" | "success" | "error";
type AnalysisStatus = "unavailable" | "ready" | "confirming" | "analyzing" | "completed" | "error" | "cancelled";
type PdfStatus = "idle" | "generating" | "success" | "error";
type ConnectivityStatus = "checking" | "connected" | "unavailable";

type DtcStatus =
  | "current"
  | "confirmed"
  | "stored"
  | "pending"
  | "permanent"
  | "intermittent"
  | "on_demand"
  | "continuous_memory"
  | "provisional"
  | "reviewed_uncertain"
  | "multiple_observed"
  | "history"
  | "unknown";
type ActionableDtcStatus = Exclude<DtcStatus, "history" | "unknown">;
type DtcClassification = "actionable" | "historical" | "unknown";

interface ExtractionResult {
  review?: ReportReviewEvidence;
  status: "completed" | "partial";
  format: "autel_vehicle_diagnostic_report";
  requiresManualReview: boolean;
  vehicle: {
    year: number | null;
    make: string | null;
    model: string | null;
    engine: string | null;
    odometer: { value: number; unit: "km" | "mi" } | null;
    odometerRaw?: string;
    vinMasked: string | null;
    vinPseudonym: string | null;
  };
  scanSummary: {
    declaredSystems: number | null;
    parsedSystems: number;
    declaredDtcs: number | null;
    parsedDtcs: number;
  };
  systems: Array<{ code: string | null; name: string; dtcCount: number }>;
  dtcs: Array<{
    code: string;
    moduleCode: string | null;
    moduleName: string;
    status: DtcStatus;
    statusOriginal: string | null;
    classification: DtcClassification;
    descriptionOriginal: string;
  }>;
  warnings: Array<{ code: string; message: string }>;
}

interface DiagnosticAnalysisInput {
  vehicle: { make: string; model: string; year: number };
  modules: Array<{
    code: string | null;
    name: string;
    dtcs: Array<{ code: string; description: string; status: ActionableDtcStatus; alsoHistorical: boolean;
      observations?: Array<{ description: string; status: Exclude<DtcStatus, "multiple_observed">; statusOriginal: string | null }> }>;
  }>;
  observations?: string;
  reviewContext?: ReviewContext;
}

interface AnalysisCounts {
  detected: number;
  actionable: number;
  historical: number;
  identities?: number;
}

interface AnalysisAvailabilityReason {
  code: string;
  message: string;
}

type AnalysisPreparation =
  | { available: true; input: DiagnosticAnalysisInput; reasons: AnalysisAvailabilityReason[]; warnings: string[]; counts: AnalysisCounts }
  | { available: false; reasons: AnalysisAvailabilityReason[]; warnings: string[]; counts: AnalysisCounts };

type AnalysisPriority = "critical" | "high" | "medium" | "low";
type AnalysisConfidence = "high" | "medium" | "low";
type RagStatus = "used" | "disabled" | "not_configured" | "no_matches" | "unavailable";

interface RagSource {
  id: string;
  title: string;
  label: string;
  url?: string;
  similarity: number;
  excerpt: string;
  provenance?: import("./rag-provenance").RagProvenance;
}

interface RagMetadata {
  enabled: boolean;
  used: boolean;
  status: RagStatus;
  querySummary: string;
  sources: RagSource[];
}

interface DiagnosticFinding {
  relatedDtc: { code: string; moduleCode: string | null; moduleName: string } | null;
  priority: AnalysisPriority;
  simpleExplanation: string;
  possibleCauses: string[];
  recommendedChecks: string[];
  safetyWarnings: string[];
  confidence: AnalysisConfidence;
}

interface DiagnosticAnalysis {
  technicalSummary: string;
  findings: DiagnosticFinding[];
  observationCorrelation: {
    status: "not_provided" | "no_clear_match" | "matches_found";
    summary: string;
    matches: Array<{
      relatedDtc: NonNullable<DiagnosticFinding["relatedDtc"]>;
      observation: string;
      possibleRelation: string;
      confidence: AnalysisConfidence;
    }>;
  };
  safetyWarnings: string[];
  confidence: AnalysisConfidence;
  requiresTechnicianConfirmation: true;
}

interface AnalysisResponse {
  status: "completed";
  reused: boolean;
  analysis: DiagnosticAnalysis;
  rag: RagMetadata;
  history: { status: "saved"; id: string } | { status: "unavailable" };
}

interface AnalysisUiState {
  status: AnalysisStatus;
  analysis?: DiagnosticAnalysis;
  rag?: RagMetadata;
  message?: string;
  submittedObservations?: string;
}

interface UploadResponse {
  extractionToken?: string;
  id: string;
  originalName: string;
  size: number;
  sha256: string;
  contentToken: string;
  type: string;
  status: "received";
  extraction: ExtractionResult;
  analysisPreparation: AnalysisPreparation;
}

interface HistoryListItem {
  id: string;
  createdAt: string;
  reportReference: string | null;
  vehicle: { make: string; model: string; year: number };
  odometer: { value: number; unit: "km" | "mi" } | null;
  dtcCount: number;
  ragStatus: RagStatus;
}

interface HistorySnapshot {
  extraction: ExtractionResult;
  analysis: {
    input: DiagnosticAnalysisInput;
    counts: AnalysisCounts;
    output: DiagnosticAnalysis;
    submittedObservations: string;
  };
  rag: RagMetadata;
}

interface HistoryDetail extends HistoryListItem {
  analysisModel: string;
  embeddingModel: string | null;
  schemaVersion: 1;
  snapshot: HistorySnapshot;
}

interface HistoryListResponse {
  items: HistoryListItem[];
  nextCursor: string | null;
}

type HistoryViewState =
  | { status: "idle" | "loading"; items: HistoryListItem[]; nextCursor: string | null }
  | { status: "ready" | "empty"; items: HistoryListItem[]; nextCursor: string | null }
  | { status: "error"; items: HistoryListItem[]; nextCursor: string | null; message: string };

interface ErrorResponse {
  error?: {
    code?: string;
    message?: string;
  };
}

const PUBLIC_API_ERROR_MESSAGES: Record<string, string> = {
  FILE_REQUIRED: 'Selecciona un archivo PDF en el campo "report".',
  FILE_TOO_LARGE: "El archivo excede el límite permitido por el servidor.",
  INVALID_FILE_FORMAT: "El contenido del archivo no corresponde a un PDF válido.",
  INVALID_UPLOAD: "Envía un único archivo PDF.",
  PDF_ENCRYPTED: "El PDF está protegido y no puede procesarse.",
  PDF_UNREADABLE: "No fue posible leer el contenido del PDF.",
  PDF_NO_USABLE_TEXT: "El PDF no contiene texto utilizable para el análisis.",
  PDF_EXTRACTION_LIMIT_EXCEEDED: "El PDF supera los límites seguros de extracción.",
  PDF_EXTRACTION_TIMEOUT: "La extracción del PDF agotó el tiempo disponible.",
  AUTEL_FORMAT_NOT_RECOGNIZED: "El PDF no corresponde a un reporte Autel compatible.",
  PDF_EXTRACTION_ERROR: "No fue posible extraer el contenido del PDF.",
  HISTORY_REQUEST_INVALID: "La solicitud de historial no es válida.",
  HISTORY_ID_INVALID: "El identificador del diagnóstico no es válido.",
  HISTORY_NOT_FOUND: "El diagnóstico solicitado no existe.",
  HISTORY_DATA_INVALID: "El historial almacenado no cumple el contrato esperado.",
  HISTORY_UNAVAILABLE: "El historial no está disponible temporalmente.",
};
const UPLOAD_RECOVERY: Record<string, string> = {
  [PUBLIC_API_ERROR_MESSAGES.FILE_TOO_LARGE]: "Selecciona otro reporte Autel completo dentro del tamaño permitido; no se analizará una selección truncada.",
  [PUBLIC_API_ERROR_MESSAGES.INVALID_FILE_FORMAT]: "Vuelve a exportar un PDF válido desde Autel y selecciona el archivo nuevo.",
  [PUBLIC_API_ERROR_MESSAGES.PDF_ENCRYPTED]: "Solicita una exportación autorizada sin protección y vuelve a cargarla.",
  [PUBLIC_API_ERROR_MESSAGES.PDF_UNREADABLE]: "Vuelve a exportar el reporte desde Autel, comprueba que se abre correctamente y selecciona el nuevo PDF.",
  [PUBLIC_API_ERROR_MESSAGES.PDF_NO_USABLE_TEXT]: "Usa la exportación original de Autel con texto seleccionable, no una fotografía o escaneo. No se inventarán datos ni se ejecutará IA.",
  [PUBLIC_API_ERROR_MESSAGES.PDF_EXTRACTION_LIMIT_EXCEEDED]: "Selecciona un reporte completo que cumpla los límites de páginas y texto. Este archivo no se truncará ni se analizará parcialmente.",
  [PUBLIC_API_ERROR_MESSAGES.PDF_EXTRACTION_TIMEOUT]: "Puedes reintentar explícitamente una vez. Si vuelve a ocurrir, reexporta el reporte compatible; no se elevarán los límites automáticamente.",
  [PUBLIC_API_ERROR_MESSAGES.AUTEL_FORMAT_NOT_RECOGNIZED]: "Usa un informe de diagnóstico Autel compatible. No se habilita revisión manual para convertir archivos ajenos en reportes válidos.",
};

const ANALYSIS_AVAILABILITY_REASON_CODES = new Set([
  "EXTRACTION_INCOMPLETE",
  "MANUAL_REVIEW_REQUIRED",
  "SYSTEM_TOTAL_MISMATCH",
  "DTC_TOTAL_MISMATCH",
  "EXTRACTION_DATA_INCONSISTENT",
  "VEHICLE_DATA_MISSING",
  "NO_VALID_DTCS",
  "MODULE_DATA_INVALID",
  "DTC_DATA_INVALID",
  "UNKNOWN_DTC_STATUS",
  "ONLY_HISTORICAL_DTCS",
  "DTC_DESCRIPTION_CONFLICT",
  "DTC_STATUS_CONFLICT",
  "DTC_MODULE_MISMATCH",
  "SENSITIVE_CONTENT_DETECTED",
  "ANALYSIS_LIMIT_EXCEEDED",
]);

function controlledErrorMessage(value: unknown, fallback: string) {
  if (!value || typeof value !== "object") return fallback;
  const code = (value as ErrorResponse).error?.code;
  return typeof code === "string" ? PUBLIC_API_ERROR_MESSAGES[code] ?? fallback : fallback;
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function validateFile(file: File) {
  const hasInvalidMimeType = file.type !== "" && file.type !== PDF_MIME_TYPE;

  if (!file.name.toLowerCase().endsWith(".pdf") || hasInvalidMimeType) {
    return "Selecciona un archivo PDF válido (.pdf).";
  }

  return null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0
    && value.every((item) => typeof item === "string" && item.trim().length > 0);
}

function isRelatedDtc(value: unknown): value is NonNullable<DiagnosticFinding["relatedDtc"]> {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<NonNullable<DiagnosticFinding["relatedDtc"]>>;
  return (
    typeof candidate.code === "string" &&
    candidate.code.trim().length > 0 &&
    candidate.code.length <= 32 &&
    (candidate.moduleCode === null || (
      typeof candidate.moduleCode === "string" &&
      candidate.moduleCode.trim().length > 0 &&
      candidate.moduleCode.length <= 32
    )) &&
    typeof candidate.moduleName === "string" &&
    candidate.moduleName.trim().length > 0 &&
    candidate.moduleName.length <= 160
  );
}

function isDiagnosticAnalysis(value: unknown): value is DiagnosticAnalysis {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<DiagnosticAnalysis>;
  const priorities = new Set<AnalysisPriority>(["critical", "high", "medium", "low"]);
  const confidences = new Set<AnalysisConfidence>(["high", "medium", "low"]);

  return (
    typeof candidate.technicalSummary === "string" &&
    candidate.technicalSummary.trim().length > 0 &&
    Array.isArray(candidate.findings) &&
    candidate.findings.length > 0 &&
    candidate.findings.length <= MAX_ANALYSIS_DTCS &&
    candidate.findings.every(
      (finding) =>
        finding !== null &&
        typeof finding === "object" &&
        (finding.relatedDtc === null || isRelatedDtc(finding.relatedDtc)) &&
        priorities.has(finding.priority) &&
        typeof finding.simpleExplanation === "string" &&
        finding.simpleExplanation.trim().length > 0 &&
        isStringArray(finding.possibleCauses) &&
        isStringArray(finding.recommendedChecks) &&
        isStringArray(finding.safetyWarnings) &&
        confidences.has(finding.confidence),
    ) &&
    candidate.observationCorrelation !== undefined &&
    candidate.observationCorrelation !== null &&
    typeof candidate.observationCorrelation === "object" &&
    ["not_provided", "no_clear_match", "matches_found"].includes(candidate.observationCorrelation.status) &&
    typeof candidate.observationCorrelation.summary === "string" &&
    candidate.observationCorrelation.summary.trim().length > 0 &&
    candidate.observationCorrelation.summary.length <= 1_000 &&
    Array.isArray(candidate.observationCorrelation.matches) &&
    candidate.observationCorrelation.matches.length <= MAX_ANALYSIS_DTCS &&
    candidate.observationCorrelation.matches.every((match) =>
      match !== null &&
      typeof match === "object" &&
      isRelatedDtc(match.relatedDtc) &&
      typeof match.observation === "string" &&
      match.observation.trim().length > 0 &&
      match.observation.length <= 300 &&
      typeof match.possibleRelation === "string" &&
      match.possibleRelation.trim().length > 0 &&
      match.possibleRelation.length <= 700 &&
      confidences.has(match.confidence)
    ) &&
    (candidate.observationCorrelation.status === "matches_found"
      ? candidate.observationCorrelation.matches.length > 0
      : candidate.observationCorrelation.matches.length === 0) &&
    isStringArray(candidate.safetyWarnings) &&
    candidate.confidence !== undefined &&
    confidences.has(candidate.confidence) &&
    candidate.requiresTechnicianConfirmation === true
  );
}

function hasOnlyKeys(value: object, allowed: readonly string[]) {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isRagSource(value: unknown): value is RagSource {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<RagSource>;
  if (!hasOnlyKeys(candidate, ["id", "title", "label", "url", "similarity", "excerpt", "provenance"])) return false;
  if (candidate.provenance !== undefined && (!isRagProvenance(candidate.provenance, (text) => containsSensitiveReportText(text, "source_text"))
    || (candidate.provenance.origin === "official_documentation" && (!candidate.provenance.publisher || !candidate.url)))) return false;
  const validUrl = candidate.url === undefined || (
    typeof candidate.url === "string" && isSafeRagSourceUrl(candidate.url)
  );
  return (
    typeof candidate.id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(candidate.id) &&
    typeof candidate.title === "string" && candidate.title.trim().length > 0 && candidate.title.length <= 200 &&
    !containsSensitiveReportText(candidate.title, "source_text") &&
    typeof candidate.label === "string" && candidate.label.trim().length > 0 && candidate.label.length <= 200 &&
    !containsSensitiveReportText(candidate.label, "source_text") &&
    validUrl &&
    typeof candidate.similarity === "number" && Number.isFinite(candidate.similarity) &&
    candidate.similarity >= 0 && candidate.similarity <= 1 &&
    typeof candidate.excerpt === "string" && candidate.excerpt.trim().length > 0 && candidate.excerpt.length <= 320 &&
    !containsSensitiveReportText(candidate.excerpt, "source_text")
  );
}

function isRagMetadata(value: unknown): value is RagMetadata {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<RagMetadata>;
  if (!hasOnlyKeys(candidate, ["enabled", "used", "status", "querySummary", "sources"])) return false;
  const statuses = new Set<RagStatus>(["used", "disabled", "not_configured", "no_matches", "unavailable"]);
  const sources = candidate.sources;
  if (
    typeof candidate.enabled !== "boolean" ||
    typeof candidate.used !== "boolean" ||
    candidate.status === undefined || !statuses.has(candidate.status) ||
    typeof candidate.querySummary !== "string" || candidate.querySummary.trim().length === 0 ||
    containsSensitiveReportText(candidate.querySummary, "source_text") ||
    !Array.isArray(sources) || sources.length > 10 || !sources.every(isRagSource)
  ) return false;
  const shouldContainSources = candidate.status === "used";
  return candidate.used === shouldContainSources &&
    (shouldContainSources ? sources.length > 0 : sources.length === 0) &&
    !(candidate.status === "disabled" && candidate.enabled);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function parseHistoryListItem(value: unknown): HistoryListItem | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<HistoryListItem>;
  if (!hasOnlyKeys(candidate, ["id", "createdAt", "reportReference", "vehicle", "odometer", "dtcCount", "ragStatus"])) return null;
  if (
    !isUuid(candidate.id) ||
    typeof candidate.createdAt !== "string" || !Number.isFinite(Date.parse(candidate.createdAt)) ||
    !(candidate.reportReference === null || isUuid(candidate.reportReference)) ||
    !candidate.vehicle || typeof candidate.vehicle !== "object" ||
    !hasOnlyKeys(candidate.vehicle, ["make", "model", "year"]) ||
    typeof candidate.vehicle.make !== "string" || !candidate.vehicle.make.trim() ||
    typeof candidate.vehicle.model !== "string" || !candidate.vehicle.model.trim() ||
    typeof candidate.vehicle.year !== "number" || !Number.isInteger(candidate.vehicle.year) ||
    candidate.vehicle.year < 1886 || candidate.vehicle.year > 9_999 ||
    containsSensitiveReportText(candidate.vehicle.make, "structured_identifier") ||
    containsSensitiveReportText(candidate.vehicle.model, "structured_identifier") ||
    typeof candidate.dtcCount !== "number" || !Number.isInteger(candidate.dtcCount) || candidate.dtcCount < 0 ||
    !["used", "disabled", "not_configured", "no_matches", "unavailable"].includes(candidate.ragStatus ?? "")
  ) return null;
  if (candidate.odometer !== null) {
    if (
      !candidate.odometer || typeof candidate.odometer !== "object" ||
      !hasOnlyKeys(candidate.odometer, ["value", "unit"]) ||
      typeof candidate.odometer.value !== "number" || !Number.isFinite(candidate.odometer.value) || candidate.odometer.value < 0 ||
      !["km", "mi"].includes(candidate.odometer.unit)
    ) return null;
  }
  return candidate as HistoryListItem;
}

function isHistoryAnalysisInput(value: unknown, legacyRead = false): value is DiagnosticAnalysisInput {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<DiagnosticAnalysisInput>;
  if (!hasOnlyKeys(candidate, ["vehicle", "modules", "observations", "reviewContext"]) || !isReviewContext(candidate.reviewContext, s => containsSensitiveReportText(s, "source_text"))) return false;
  if (
    !candidate.vehicle || typeof candidate.vehicle !== "object" ||
    !hasOnlyKeys(candidate.vehicle, ["make", "model", "year"]) ||
    typeof candidate.vehicle.make !== "string" || !candidate.vehicle.make.trim() || candidate.vehicle.make.length > 80 ||
    typeof candidate.vehicle.model !== "string" || !candidate.vehicle.model.trim() || candidate.vehicle.model.length > 120 ||
    typeof candidate.vehicle.year !== "number" || !Number.isInteger(candidate.vehicle.year) ||
    candidate.vehicle.year < 1886 || candidate.vehicle.year > new Date().getUTCFullYear() + 1 ||
    containsSensitiveReportText(candidate.vehicle.make, "structured_identifier") ||
    containsSensitiveReportText(candidate.vehicle.model, "structured_identifier") ||
    !Array.isArray(candidate.modules) || candidate.modules.length === 0 || candidate.modules.length > 40
  ) return false;
  if (candidate.observations !== undefined && (
    typeof candidate.observations !== "string" || !candidate.observations.trim() || candidate.observations.length > 1_000 ||
    containsSensitiveReportText(candidate.observations, "free_text")
  )) return false;
  let totalDtcs = 0;
  const modulesValid = candidate.modules.every((module) =>
    module !== null && typeof module === "object" &&
    hasOnlyKeys(module, ["code", "name", "dtcs"]) &&
    (module.code === null || (typeof module.code === "string" && !!module.code.trim() && module.code.length <= 32 && !containsSensitiveReportText(module.code, "structured_identifier"))) &&
    typeof module.name === "string" && !!module.name.trim() && module.name.length <= 160 && !containsSensitiveReportText(module.name, "structured_identifier") &&
    Array.isArray(module.dtcs) && module.dtcs.length > 0 && module.dtcs.length <= (legacyRead && !candidate.reviewContext ? 50 : MAX_ANALYSIS_DTCS) &&
    (totalDtcs += module.dtcs.length) <= (legacyRead && !candidate.reviewContext ? 100 : MAX_ANALYSIS_DTCS) &&
    module.dtcs.every((dtc) =>
      dtc !== null && typeof dtc === "object" &&
      hasOnlyKeys(dtc, ["code", "description", "status", "alsoHistorical", "observations"]) && isDtcObservations(dtc.observations, s => containsSensitiveReportText(s, "source_text")) &&
      typeof dtc.code === "string" && !!dtc.code.trim() && dtc.code.length <= 32 && !containsSensitiveReportText(dtc.code, "structured_identifier") &&
      typeof dtc.description === "string" && !!dtc.description.trim() && dtc.description.length <= 1_000 && !containsSensitiveReportText(dtc.description, "free_text") &&
      ["current", "confirmed", "stored", "pending", "permanent", "intermittent", "on_demand", "continuous_memory", "provisional", "reviewed_uncertain", "multiple_observed"].includes(dtc.status) &&
      typeof dtc.alsoHistorical === "boolean" && hasConsistentObservedStates(dtc)
    )
  );
  const legacy = legacyRead && !candidate.reviewContext && candidate.modules.every(m => m.dtcs.length <= 20 && m.dtcs.every(d => !d.observations && ["current", "confirmed", "stored", "pending", "permanent", "intermittent"].includes(d.status)));
  return modulesValid && ((legacy && totalDtcs <= 100) || (totalDtcs <= MAX_ANALYSIS_DTCS && candidate.modules.reduce((sum, m) => sum + m.dtcs.reduce((n, d) => n + (d.observations?.length ?? 1), 0), 0) <= MAX_ANALYSIS_OBSERVATIONS && JSON.stringify(candidate).length <= 100_000));
}

function parseUploadExtraction(value: unknown): ExtractionResult | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<ExtractionResult>;
  if (!hasOnlyKeys(candidate, ["status", "format", "requiresManualReview", "vehicle", "scanSummary", "systems", "dtcs", "warnings", "review"]) ||
    (candidate.review !== undefined && !isReviewEvidence(candidate.review, s => containsSensitiveReportText(s, "source_text")))) return null;
  const vehicle = candidate.vehicle;
  const scan = candidate.scanSummary;
  const nullableText = (item: unknown, maxLength = 500) => item === null
    || (typeof item === "string" && item.trim().length > 0 && item.length <= maxLength);
  const optionalCount = (item: unknown) => item === null
    || (typeof item === "number" && Number.isInteger(item) && item >= 0);
  const count = (item: unknown) => typeof item === "number" && Number.isInteger(item) && item >= 0;
  if (
    !["completed", "partial"].includes(candidate.status ?? "")
    || candidate.format !== "autel_vehicle_diagnostic_report"
    || typeof candidate.requiresManualReview !== "boolean"
    || !vehicle || typeof vehicle !== "object"
    || !hasOnlyKeys(vehicle, ["year", "make", "model", "engine", "odometer", "vinMasked", "vinPseudonym", "odometerRaw"])
    || (vehicle.odometerRaw !== undefined && (typeof vehicle.odometerRaw !== "string" || vehicle.odometerRaw.length > 80))
    || !(vehicle.year === null || (typeof vehicle.year === "number" && Number.isInteger(vehicle.year) && vehicle.year >= 1886 && vehicle.year <= 9_999))
    || !nullableText(vehicle.make, 200)
    || !nullableText(vehicle.model, 200)
    || !nullableText(vehicle.engine, 300)
    || !(vehicle.vinMasked === null || (typeof vehicle.vinMasked === "string" && /^\*{13}[A-HJ-NPR-Z0-9]{4}$/u.test(vehicle.vinMasked)))
    || !(vehicle.vinPseudonym === null || (typeof vehicle.vinPseudonym === "string" && /^vin_v1_[a-f0-9]{64}$/u.test(vehicle.vinPseudonym)))
    || ((vehicle.vinMasked === null) !== (vehicle.vinPseudonym === null))
    || !scan || typeof scan !== "object"
    || !hasOnlyKeys(scan, ["declaredSystems", "parsedSystems", "declaredDtcs", "parsedDtcs"])
    || !optionalCount(scan.declaredSystems)
    || !count(scan.parsedSystems)
    || !optionalCount(scan.declaredDtcs)
    || !count(scan.parsedDtcs)
    || !Array.isArray(candidate.systems)
    || !Array.isArray(candidate.dtcs)
    || !Array.isArray(candidate.warnings)
  ) return null;
  if (vehicle.odometer !== null && (
    !vehicle.odometer || typeof vehicle.odometer !== "object"
    || !hasOnlyKeys(vehicle.odometer, ["value", "unit"])
    || typeof vehicle.odometer.value !== "number" || !Number.isFinite(vehicle.odometer.value) || vehicle.odometer.value < 0
    || !["km", "mi"].includes(vehicle.odometer.unit)
  )) return null;
  const systemsValid = candidate.systems.every((system) =>
    system !== null && typeof system === "object"
    && hasOnlyKeys(system, ["code", "name", "dtcCount"])
    && nullableText(system.code, 64)
    && typeof system.name === "string" && system.name.trim().length > 0 && system.name.length <= 300
    && count(system.dtcCount)
  );
  const dtcsValid = candidate.dtcs.every((dtc) =>
    dtc !== null && typeof dtc === "object"
    && hasOnlyKeys(dtc, ["code", "moduleCode", "moduleName", "status", "statusOriginal", "classification", "descriptionOriginal"])
    && typeof dtc.code === "string" && dtc.code.trim().length > 0 && dtc.code.length <= 32
    && nullableText(dtc.moduleCode, 64)
    && typeof dtc.moduleName === "string" && dtc.moduleName.trim().length > 0 && dtc.moduleName.length <= 300
    && ["current", "confirmed", "stored", "pending", "permanent", "intermittent", "on_demand", "continuous_memory", "provisional", "reviewed_uncertain", "history", "unknown"].includes(dtc.status)
    && nullableText(dtc.statusOriginal, 200)
    && ["actionable", "historical", "unknown"].includes(dtc.classification)
    && typeof dtc.descriptionOriginal === "string" && dtc.descriptionOriginal.length <= 1_000
  );
  const warningsValid = candidate.warnings.every((warning) =>
    warning !== null && typeof warning === "object"
    && hasOnlyKeys(warning, ["code", "message"])
    && typeof warning.code === "string" && warning.code.trim().length > 0 && warning.code.length <= 100
    && typeof warning.message === "string" && warning.message.trim().length > 0 && warning.message.length <= 1_000
  );
  return systemsValid && dtcsValid && warningsValid ? candidate as ExtractionResult : null;
}

function parseAnalysisPreparation(value: unknown): AnalysisPreparation | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<AnalysisPreparation> & { input?: unknown };
  const allowedKeys = candidate.available === true
    ? ["available", "input", "reasons", "warnings", "counts"]
    : ["available", "reasons", "warnings", "counts"];
  if (!hasOnlyKeys(candidate, allowedKeys) || typeof candidate.available !== "boolean") return null;
  const counts = candidate.counts;
  const reasons = candidate.reasons;
  if (
    !counts || typeof counts !== "object" || !hasOnlyKeys(counts, ["detected", "actionable", "historical", "identities"])
    || (counts.identities !== undefined && (!Number.isInteger(counts.identities) || counts.identities < 0))
    || ![counts.detected, counts.actionable, counts.historical].every((item) => typeof item === "number" && Number.isInteger(item) && item >= 0)
    || !Array.isArray(reasons) || !reasons.every((reason) =>
      reason !== null && typeof reason === "object" && hasOnlyKeys(reason, ["code", "message"])
      && typeof reason.code === "string" && ANALYSIS_AVAILABILITY_REASON_CODES.has(reason.code)
      && typeof reason.message === "string" && reason.message.trim().length > 0 && reason.message.length <= 1_000
    )
    || !Array.isArray(candidate.warnings)
    || !candidate.warnings.every((warning) => typeof warning === "string" && warning.trim().length > 0 && warning.length <= 1_000)
  ) return null;
  if (candidate.available) {
    return isHistoryAnalysisInput(candidate.input) ? candidate as AnalysisPreparation : null;
  }
  return candidate as AnalysisPreparation;
}

function parseUploadResponse(value: unknown): UploadResponse | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<UploadResponse>;
  if (!hasOnlyKeys(candidate, ["id", "originalName", "size", "sha256", "contentToken", "type", "status", "extraction", "analysisPreparation", "extractionToken"]) ||
    (candidate.extractionToken !== undefined && (typeof candidate.extractionToken !== "string" || !/^review_v1_\d{13}\.[a-f0-9]{64}$/u.test(candidate.extractionToken)))) return null;
  const extraction = parseUploadExtraction(candidate.extraction);
  const analysisPreparation = parseAnalysisPreparation(candidate.analysisPreparation);
  if (
    !isUuid(candidate.id)
    || typeof candidate.originalName !== "string" || candidate.originalName.trim().length === 0 || candidate.originalName.length > 255
    || typeof candidate.size !== "number" || !Number.isInteger(candidate.size) || candidate.size <= 0
    || typeof candidate.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(candidate.sha256)
    || typeof candidate.contentToken !== "string" || !/^pdf_v1_[0-9a-f]{64}\.[0-9a-f]{64}$/u.test(candidate.contentToken)
    || candidate.type !== PDF_MIME_TYPE
    || candidate.status !== "received"
    || !extraction
    || !analysisPreparation
  ) return null;
  return { ...candidate, extraction, analysisPreparation } as UploadResponse;
}

function parseHistoryExtraction(value: unknown): ExtractionResult | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<ExtractionResult>;
  if (!hasOnlyKeys(candidate, ["status", "format", "requiresManualReview", "vehicle", "scanSummary", "systems", "dtcs", "warnings", "review"]) ||
    (candidate.review !== undefined && !isReviewEvidence(candidate.review, s => containsSensitiveReportText(s, "source_text")))) return null;
  const vehicle = candidate.vehicle;
  const scan = candidate.scanSummary;
  if (
    candidate.status !== "completed" || candidate.format !== "autel_vehicle_diagnostic_report" ||
    candidate.requiresManualReview !== false || !vehicle || typeof vehicle !== "object" ||
    !hasOnlyKeys(vehicle, ["year", "make", "model", "engine", "odometer", "vinMasked", "vinPseudonym", "odometerRaw"]) ||
    (vehicle.odometerRaw !== undefined && (typeof vehicle.odometerRaw !== "string" || vehicle.odometerRaw.length > 80 || containsSensitiveReportText(vehicle.odometerRaw, "source_text"))) ||
    !(vehicle.year === null || (Number.isInteger(vehicle.year) && vehicle.year >= 1886 && vehicle.year <= 9_999)) ||
    !(vehicle.make === null || (typeof vehicle.make === "string" && !!vehicle.make.trim() && !containsSensitiveReportText(vehicle.make, "structured_identifier"))) ||
    !(vehicle.model === null || (typeof vehicle.model === "string" && !!vehicle.model.trim() && !containsSensitiveReportText(vehicle.model, "structured_identifier"))) ||
    !(vehicle.engine === null || (typeof vehicle.engine === "string" && !!vehicle.engine.trim() && !containsSensitiveReportText(vehicle.engine, "structured_identifier"))) ||
    !(vehicle.vinMasked === null || (typeof vehicle.vinMasked === "string" && /^\*{13}[A-HJ-NPR-Z0-9]{4}$/u.test(vehicle.vinMasked))) ||
    vehicle.vinPseudonym !== null || !scan || typeof scan !== "object" ||
    !hasOnlyKeys(scan, ["declaredSystems", "parsedSystems", "declaredDtcs", "parsedDtcs"]) ||
    !Array.isArray(candidate.systems) || !Array.isArray(candidate.dtcs) || !Array.isArray(candidate.warnings)
  ) return null;
  if (vehicle.odometer !== null && (
    !vehicle.odometer || typeof vehicle.odometer !== "object" ||
    !hasOnlyKeys(vehicle.odometer, ["value", "unit"]) ||
    typeof vehicle.odometer.value !== "number" || !Number.isFinite(vehicle.odometer.value) || vehicle.odometer.value < 0 ||
    !["km", "mi"].includes(vehicle.odometer.unit)
  )) return null;
  const validOptionalCount = (item: unknown) => item === null || (typeof item === "number" && Number.isInteger(item) && item >= 0);
  const validRequiredCount = (item: unknown) => typeof item === "number" && Number.isInteger(item) && item >= 0;
  if (
    !validOptionalCount(scan.declaredSystems) || !validOptionalCount(scan.declaredDtcs) ||
    !validRequiredCount(scan.parsedSystems) || !validRequiredCount(scan.parsedDtcs)
  ) return null;
  const systemsValid = candidate.systems.every((system) =>
    system !== null && typeof system === "object" && hasOnlyKeys(system, ["code", "name", "dtcCount"]) &&
    (system.code === null || (typeof system.code === "string" && !!system.code.trim() && !containsSensitiveReportText(system.code, "structured_identifier"))) &&
    typeof system.name === "string" && !!system.name.trim() && !containsSensitiveReportText(system.name, "structured_identifier") &&
    typeof system.dtcCount === "number" && Number.isInteger(system.dtcCount) && system.dtcCount >= 0
  );
  const dtcsValid = candidate.dtcs.every((dtc) =>
    dtc !== null && typeof dtc === "object" &&
    hasOnlyKeys(dtc, ["code", "moduleCode", "moduleName", "status", "statusOriginal", "classification", "descriptionOriginal"]) &&
    typeof dtc.code === "string" && !!dtc.code.trim() && !containsSensitiveReportText(dtc.code, "structured_identifier") &&
    (dtc.moduleCode === null || (typeof dtc.moduleCode === "string" && !!dtc.moduleCode.trim() && !containsSensitiveReportText(dtc.moduleCode, "structured_identifier"))) &&
    typeof dtc.moduleName === "string" && !!dtc.moduleName.trim() && !containsSensitiveReportText(dtc.moduleName, "structured_identifier") &&
    ["current", "confirmed", "stored", "pending", "permanent", "intermittent", "on_demand", "continuous_memory", "provisional", "reviewed_uncertain", "history", "unknown"].includes(dtc.status) &&
    (dtc.statusOriginal === null || (typeof dtc.statusOriginal === "string" && !containsSensitiveReportText(dtc.statusOriginal, "source_text"))) &&
    ["actionable", "historical", "unknown"].includes(dtc.classification) &&
    typeof dtc.descriptionOriginal === "string" && !!dtc.descriptionOriginal.trim() &&
    !containsSensitiveReportText(dtc.descriptionOriginal, "source_text")
  );
  const warningsValid = candidate.warnings.every((warning) =>
    warning !== null && typeof warning === "object" && hasOnlyKeys(warning, ["code", "message"]) &&
    typeof warning.code === "string" && !!warning.code.trim() &&
    typeof warning.message === "string" && !!warning.message.trim() &&
    !containsSensitiveReportText(warning.message, "source_text")
  );
  return systemsValid && dtcsValid && warningsValid ? candidate as ExtractionResult : null;
}

function parseReviewedReport(value: unknown): Pick<UploadResponse, "extraction" | "analysisPreparation" | "extractionToken"> | null {
  if (!value || typeof value !== "object" || !hasOnlyKeys(value, ["extraction", "analysisPreparation", "extractionToken"])) return null;
  const candidate = value as Record<string, unknown>;
  const extraction = parseUploadExtraction(candidate.extraction), analysisPreparation = parseAnalysisPreparation(candidate.analysisPreparation);
  return extraction && analysisPreparation && typeof candidate.extractionToken === "string" && /^review_v1_\d{13}\.[a-f0-9]{64}$/u.test(candidate.extractionToken)
    ? { extraction, analysisPreparation, extractionToken: candidate.extractionToken } : null;
}

function parseHistoryDetail(value: unknown): HistoryDetail | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<HistoryDetail>;
  if (!hasOnlyKeys(candidate, [
    "id", "createdAt", "reportReference", "vehicle", "odometer", "dtcCount", "ragStatus",
    "analysisModel", "embeddingModel", "schemaVersion", "snapshot",
  ])) return null;
  const listItem = parseHistoryListItem({
    id: candidate.id,
    createdAt: candidate.createdAt,
    reportReference: candidate.reportReference,
    vehicle: candidate.vehicle,
    odometer: candidate.odometer,
    dtcCount: candidate.dtcCount,
    ragStatus: candidate.ragStatus,
  });
  const snapshot = candidate.snapshot;
  if (
    !listItem || typeof candidate.analysisModel !== "string" || !candidate.analysisModel.trim() ||
    containsSensitiveReportText(candidate.analysisModel, "structured_identifier") ||
    !(candidate.embeddingModel === null || (
      typeof candidate.embeddingModel === "string" && !!candidate.embeddingModel.trim() &&
      !containsSensitiveReportText(candidate.embeddingModel, "structured_identifier")
    )) ||
    candidate.schemaVersion !== 1 || !snapshot || typeof snapshot !== "object" ||
    !hasOnlyKeys(snapshot, ["extraction", "analysis", "rag"]) ||
    !snapshot.analysis || typeof snapshot.analysis !== "object" ||
    !hasOnlyKeys(snapshot.analysis, ["input", "counts", "output", "submittedObservations"])
  ) return null;
  const extraction = parseHistoryExtraction(snapshot.extraction);
  const input = isHistoryAnalysisInput(snapshot.analysis.input, true) ? snapshot.analysis.input : null;
  const output = isDiagnosticAnalysis(snapshot.analysis.output) ? snapshot.analysis.output : null;
  const rag = isRagMetadata(snapshot.rag) ? snapshot.rag : null;
  const counts = snapshot.analysis.counts;
  const inputDtcIdentities = input === null ? new Set<string>() : new Set(input.modules.flatMap((module) =>
    module.dtcs.map((dtc) => dtcIdentity({ code: dtc.code, moduleCode: module.code, moduleName: module.name })),
  ));
  const findingIdentities = output?.findings.flatMap((finding) =>
    finding.relatedDtc === null ? [] : [dtcIdentity(finding.relatedDtc)],
  ) ?? [];
  const correlationIdentities = output?.observationCorrelation.matches.map((match) => dtcIdentity(match.relatedDtc)) ?? [];
  if (
    !extraction || !input || !output || !rag || !counts || typeof counts !== "object" ||
    !hasOnlyKeys(counts, ["detected", "actionable", "historical", "identities"]) ||
    (counts.identities !== undefined && (!Number.isInteger(counts.identities) || counts.identities < 0)) ||
    ![counts.detected, counts.actionable, counts.historical].every((count) => typeof count === "number" && Number.isInteger(count) && count >= 0) ||
    typeof snapshot.analysis.submittedObservations !== "string" ||
    snapshot.analysis.submittedObservations !== (input.observations ?? "") ||
    listItem.dtcCount !== extraction.dtcs.length || listItem.ragStatus !== rag.status ||
    listItem.vehicle.make !== input.vehicle.make || listItem.vehicle.model !== input.vehicle.model ||
    listItem.vehicle.year !== input.vehicle.year ||
    JSON.stringify(listItem.odometer) !== JSON.stringify(extraction.vehicle.odometer) ||
    rag.used !== (candidate.embeddingModel !== null) ||
    counts.detected !== extraction.dtcs.length ||
    counts.actionable !== input.modules.reduce((total, module) => total + module.dtcs.length, 0) ||
    counts.historical !== extraction.dtcs.filter((dtc) => dtc.classification === "historical").length ||
    findingIdentities.some((identity) => !inputDtcIdentities.has(identity)) ||
    new Set(findingIdentities).size !== findingIdentities.length ||
    correlationIdentities.some((identity) => !inputDtcIdentities.has(identity)) ||
    new Set(correlationIdentities).size !== correlationIdentities.length
  ) return null;
  return { ...listItem, analysisModel: candidate.analysisModel, embeddingModel: candidate.embeddingModel, schemaVersion: 1, snapshot: { extraction, analysis: { input, counts, output, submittedObservations: snapshot.analysis.submittedObservations }, rag } };
}

function parseHistoryListResponse(value: unknown): HistoryListResponse | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<HistoryListResponse>;
  if (!hasOnlyKeys(candidate, ["items", "nextCursor"]) || !Array.isArray(candidate.items)) return null;
  const items = candidate.items.map(parseHistoryListItem);
  if (items.some((item) => item === null) || !(candidate.nextCursor === null || typeof candidate.nextCursor === "string")) return null;
  return { items: items as HistoryListItem[], nextCursor: candidate.nextCursor };
}

function parseAnalysisResponse(value: unknown): AnalysisResponse | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<AnalysisResponse>;
  if (
    !hasOnlyKeys(candidate, ["status", "reused", "analysis", "rag", "history"]) ||
    candidate.status !== "completed" || typeof candidate.reused !== "boolean" ||
    !isDiagnosticAnalysis(candidate.analysis) || !isRagMetadata(candidate.rag)
  ) return null;
  const history = candidate.history;
  if (history !== undefined && (
    !history || typeof history !== "object" ||
    !hasOnlyKeys(history, ["status", "id"]) ||
    !["saved", "unavailable"].includes(history.status) ||
    (history.status === "saved"
      ? !("id" in history) || !isUuid(history.id)
      : "id" in history)
  )) return null;
  return {
    status: candidate.status,
    reused: candidate.reused,
    analysis: candidate.analysis,
    rag: candidate.rag,
    history: history ?? { status: "unavailable" },
  };
}

function dtcIdentity(value: { code: string; moduleCode: string | null; moduleName: string }) {
  return JSON.stringify([value.moduleCode, value.moduleName, value.code]);
}

function getAiErrorMessage(code: string | undefined) {
  return (code && AI_ERROR_MESSAGES[code]) ?? "No fue posible obtener la orientación por IA.";
}

const AI_ERROR_MESSAGES: Record<string, string> = {
  OPENAI_API_KEY_MISSING: "La orientación por IA no está configurada en el servidor.",
  OPENAI_MODEL_MISSING: "El modelo de orientación por IA no está configurado en el servidor.",
  AI_INPUT_INVALID: "Los datos extraídos no son compatibles con el análisis por IA.",
  OBSERVATIONS_INVALID: "Las observaciones deben ser texto y no superar 1,000 caracteres.",
  OBSERVATIONS_SENSITIVE_CONTENT: "Las observaciones parecen contener un VIN, una clave o un secreto. Retira ese dato antes de continuar.",
  OPENAI_TIMEOUT: "La solicitud de orientación agotó el tiempo disponible.",
  OPENAI_LIMIT_EXCEEDED: "El servicio de orientación alcanzó su límite de uso o saldo.",
  OPENAI_RESPONSE_INVALID: "El servicio devolvió una orientación que no pudo validarse.",
  OPENAI_UNAVAILABLE: "El servicio de orientación por IA no está disponible temporalmente.",
  ANALYSIS_TIMEOUT: "El análisis está tardando más de lo esperado. Puede continuar procesándose. Usa Reintentar para recuperar el mismo resultado sin iniciar un análisis duplicado.",
  IDEMPOTENCY_KEY_INVALID: "No fue posible identificar de forma segura este intento de análisis.",
  IDEMPOTENCY_CONFLICT: "Este intento de análisis ya fue utilizado con datos diferentes. Revisa el reporte y vuelve a intentarlo.",
  CONTENT_TOKEN_INVALID: "La referencia privada del reporte no es válida. Vuelve a cargar el PDF.",
};

// Exceeds the bounded API budget (maximum 150 s), including response delivery.
const ANALYSIS_HTTP_TIMEOUT_MS = 160_000;
const ANALYSIS_TIMEOUT_MESSAGE =
  "El análisis está tardando más de lo esperado. Puede continuar procesándose. Usa Reintentar para recuperar el mismo resultado sin iniciar un análisis duplicado.";

const PRIORITY_LABELS: Record<AnalysisPriority, string> = {
  critical: "Crítica",
  high: "Alta",
  medium: "Media",
  low: "Baja",
};

const CONFIDENCE_LABELS: Record<AnalysisConfidence, string> = {
  high: "Alta",
  medium: "Media",
  low: "Baja",
};

function displayVehicleName(extraction: ExtractionResult) {
  return [extraction.vehicle.year, extraction.vehicle.make, extraction.vehicle.model].filter(Boolean).join(" · ") || "No disponible";
}

function isConfirmedZeroDtc(extraction: ExtractionResult) {
  return extraction.status === "completed" && !extraction.requiresManualReview && extraction.scanSummary.declaredDtcs === 0 &&
    extraction.scanSummary.parsedDtcs === 0 && extraction.dtcs.length === 0 && extraction.scanSummary.declaredSystems === extraction.systems.length &&
    extraction.scanSummary.parsedSystems === extraction.systems.length && extraction.systems.every(s => s.dtcCount === 0);
}

function VehicleConfirmation({ result, apiClient, disabled, onConfirmed, onSessionInvalid }: {
  result: UploadResponse; apiClient: BrowserApiClient; disabled: boolean;
  onConfirmed: (value: Pick<UploadResponse, "extraction" | "analysisPreparation">) => void;
  onSessionInvalid: () => void;
}) {
  const [make, setMake] = useState(result.extraction.vehicle.make ?? "");
  const [model, setModel] = useState(result.extraction.vehicle.model ?? "");
  const [year, setYear] = useState("");
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const active = useRef<AbortController | null>(null);
  useEffect(() => {
    if (disabled) { active.current?.abort(); active.current = null; }
    return () => { active.current?.abort(); active.current = null; };
  }, [disabled]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || active.current) return;
    const controller = new AbortController(); active.current = controller;
    setPending(true); setMessage("");
    try {
      const value = await apiClient.requestJson("/api/reports/confirm-vehicle", {
        init: { method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
          body: JSON.stringify({ extraction: result.extraction, vehicle: {
            make, model, year: result.extraction.vehicle.year ?? (year.trim() ? Number(year) : null),
          } }) },
        retry: "none",
        parse: raw => {
          if (!raw || typeof raw !== "object" || !hasOnlyKeys(raw, ["extraction", "analysisPreparation"])) return null;
          const data = raw as Record<string, unknown>;
          const extraction = parseUploadExtraction(data.extraction);
          const analysisPreparation = parseAnalysisPreparation(data.analysisPreparation);
          return extraction && analysisPreparation ? { extraction, analysisPreparation } : null;
        },
        invalidResponseMessage: "No se pudo validar la confirmación del vehículo.",
        errorMessage: () => "No se pudieron confirmar los datos. Revisa los campos e inténtalo de nuevo.",
      });
      if (active.current === controller && !controller.signal.aborted) onConfirmed(value);
    } catch (error) {
      if (active.current !== controller || controller.signal.aborted) return;
      if (error instanceof ApiRequestError && error.type === "unauthorized") { onSessionInvalid(); return; }
      setMessage("No se pudieron confirmar los datos. Revisa los campos o la conexión e inténtalo de nuevo.");
    } finally {
      if (active.current === controller) { active.current = null; setPending(false); }
    }
  }
  return <form className="warnings-panel vehicle-confirmation" onSubmit={event => void submit(event)}>
    <h3>Completar datos del vehículo</h3>
    <p>Confirma solo los datos ausentes usando documentación del vehículo. El nombre del archivo no acredita el año. Esto no elimina otras revisiones del reporte.</p>
    <label>Marca confirmada<input value={make} onChange={event => setMake(event.target.value)} required maxLength={80} readOnly={result.extraction.vehicle.make !== null} disabled={pending || disabled} /></label>
    <label>Modelo confirmado<input value={model} onChange={event => setModel(event.target.value)} required maxLength={120} readOnly={result.extraction.vehicle.model !== null} disabled={pending || disabled} /></label>
    <label>Año confirmado<input type="number" min={1886} max={new Date().getUTCFullYear() + 1} step={1} required value={result.extraction.vehicle.year ?? year} onChange={event => setYear(event.target.value)} readOnly={result.extraction.vehicle.year !== null} disabled={pending || disabled} /></label>
    <button className="analysis-button" type="submit" disabled={pending || disabled}>{pending ? "Confirmando…" : "Confirmar datos del vehículo"}</button>
    {message && <p role="alert">{message}</p>}
  </form>;
}

function ExtractionResults({ extraction, counts }: { extraction: ExtractionResult; counts: AnalysisCounts }) {
  const vehicle = extraction.vehicle;

  return (
    <section className="extraction-results" aria-labelledby="extraction-title">
      <div className="results-heading">
        <div>
          <span className="eyebrow">RESULTADO DE EXTRACCIÓN</span>
          <h2 id="extraction-title">Datos del reporte</h2>
        </div>
        <span className={`extraction-badge ${extraction.status}`}>
          {extraction.status === "completed" ? "Completa" : "Revisión requerida"}
        </span>
      </div>

      {extraction.requiresManualReview && (
        <div className="manual-review" role="alert">
          La extracción contiene diferencias o datos que requieren revisión manual.
        </div>
      )}

      <div className="vehicle-summary">
        <div className="vehicle-main">
          <span>Vehículo</span>
          <strong>{displayVehicleName(extraction)}</strong>
        </div>
        <dl className="vehicle-details">
          {vehicle.engine && <div><dt>Motor</dt><dd>{vehicle.engine}</dd></div>}
          {vehicle.odometer && <div><dt>Odómetro</dt><dd>{vehicle.odometer.value.toLocaleString("es-GT")} {vehicle.odometer.unit}</dd></div>}
          {!vehicle.odometer && vehicle.odometerRaw && <div><dt>Odómetro impreso</dt><dd>{vehicle.odometerRaw} (unidad no indicada)</dd></div>}
          {vehicle.vinMasked && <div><dt>VIN protegido</dt><dd>{vehicle.vinMasked}</dd></div>}
        </dl>
      </div>

      <div className="scan-totals" aria-label="Resumen del escaneo">
        <div><strong>{extraction.scanSummary.parsedSystems}</strong><span>Sistemas escaneados</span></div>
        <div><strong>{counts.detected}</strong><span>DTC detectados</span></div>
        <div><strong>{counts.actionable}</strong><span>DTC para análisis</span></div>
        <div><strong>{counts.historical}</strong><span>Registros históricos</span></div>
      </div>

      <p>{counts.detected} observaciones originales · {counts.identities ?? new Set(extraction.dtcs.map(d => dtcIdentity({ code: d.code, moduleCode: d.moduleCode, moduleName: d.moduleName }))).size} identidades código/módulo · {counts.actionable} elementos preparados para IA. Las observaciones repetidas conservan sus estados.</p>
      {isConfirmedZeroDtc(extraction) && <div className="status-message success" role="status">
        <p>¡Buenas noticias! Este escaneo no reportó códigos DTC en los {extraction.systems.length} sistemas revisados.</p>
        <p>Esto no descarta problemas no detectados. No hay códigos DTC que analizar.</p>
      </div>}
      {extraction.review && <details className="review-evidence"><summary>Originales y correcciones confirmadas por el usuario</summary>
        <p>{extraction.review.reason}</p>
        <p>Original: {extraction.review.original.scanSummary.declaredSystems ?? "?"} sistemas y {extraction.review.original.scanSummary.declaredDtcs ?? "?"} filas declarados. Interpretadas: {extraction.review.original.dtcs.length}.</p>
        <ul>{extraction.review.decisions.map((d, i) => <li key={i}><strong>{d.path}</strong>: {d.before ?? "No indicado"} → {d.after ?? "No indicado"}. Motivo: {d.reason}</li>)}</ul>
      </details>}

      {extraction.warnings.length > 0 && (
        <div className="warnings-panel">
          <h3>Advertencias de extracción</h3>
          <ul>{extraction.warnings.map((warning) => <li key={warning.code}>{warning.message}</li>)}</ul>
        </div>
      )}

      <div className="dtc-section">
        <h3>DTC reportados</h3>
        {extraction.dtcs.length === 0 ? (
          <p className="empty-dtc">{extraction.scanSummary.declaredDtcs === 0 ? "No se reportaron DTC en este escaneo" : "No se pudieron interpretar los DTC declarados; revisa el reporte."}</p>
        ) : (
          <div className="table-scroll" tabIndex={0}>
            <table>
              <caption className="sr-only">Códigos DTC extraídos del reporte Autel</caption>
              <thead><tr><th scope="col">Código</th><th scope="col">Módulo</th><th scope="col">Estado</th><th scope="col">Descripción</th></tr></thead>
              <tbody>
                {extraction.dtcs.map((dtc, index) => (
                  <tr key={`${dtc.moduleCode ?? dtc.moduleName}-${dtc.code}-${index}`}>
                    <td><code>{dtc.code}</code></td>
                    <td>{dtc.moduleCode ? `${dtc.moduleCode} · ${dtc.moduleName}` : dtc.moduleName}</td>
                    <td>{dtc.statusOriginal ?? "No indicado"}{["on_demand", "continuous_memory"].includes(dtc.status) && <small> · {dtc.status === "on_demand" ? "Prueba bajo demanda" : "Memoria continua"}; no confirma falla activa</small>}{dtc.status === "reviewed_uncertain" && <small> · Incertidumbre revisada por el usuario; actividad no confirmada</small>}</td>
                    <td>{dtc.descriptionOriginal}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

const RAG_STATUS_MESSAGES: Record<Exclude<RagStatus, "used">, string> = {
  disabled: "La recuperación de conocimiento está desactivada para este análisis.",
  not_configured: "La recuperación de conocimiento todavía no está configurada en el servidor.",
  no_matches: "No se encontraron fuentes suficientemente relacionadas con este caso.",
  unavailable: "La recuperación no estuvo disponible; la orientación se generó sin fuentes adicionales.",
};

function RagEvidence({ rag }: { rag: RagMetadata }) {
  return (
    <section className={`rag-evidence ${rag.status}`} aria-labelledby="rag-evidence-title">
      <div className="rag-evidence-heading">
        <h3 id="rag-evidence-title">Evidencia recuperada por RAG</h3>
        <span>{rag.sources.length} {rag.sources.length === 1 ? "fuente" : "fuentes"}</span>
      </div>
      {rag.status !== "used" ? (
        <p className="rag-status-message">{RAG_STATUS_MESSAGES[rag.status]}</p>
      ) : (
        <>
          <p className="rag-query-summary">{rag.querySummary}</p>
          <ol className="rag-sources">
            {rag.sources.map((source, index) => (
              <li key={source.id}>
                <div>
                  <strong>[K{index + 1}] {source.title}</strong>
                  <span>Similitud {(source.similarity * 100).toFixed(0)}%</span>
                </div>
                <p className="rag-source-label">{source.label}</p>
                <p>{describeRagProvenance(source.provenance)}</p>
                <p>{source.excerpt}</p>
                {source.url && <a href={source.url} target="_blank" rel="noreferrer">Consultar fuente HTTPS</a>}
              </li>
            ))}
          </ol>
          <p className="rag-caution">La similitud orienta la búsqueda; no confirma una causa ni sustituye documentación oficial.</p>
        </>
      )}
    </section>
  );
}

function AnalysisResult({ analysis, rag }: { analysis: DiagnosticAnalysis; rag: RagMetadata }) {
  return (
    <div className="analysis-result">
      <div className="analysis-summary">
        <h3>Resumen técnico</h3>
        <p>{analysis.technicalSummary}</p>
        <span>Confianza general: <strong>{CONFIDENCE_LABELS[analysis.confidence]}</strong></span>
      </div>

      <RagEvidence rag={rag} />

      <div className="analysis-findings">
        <h3>Hallazgos priorizados</h3>
        {analysis.findings.map((finding, index) => (
          <article
            className="analysis-finding"
            key={`${finding.relatedDtc?.moduleCode ?? finding.relatedDtc?.moduleName ?? "general"}-${finding.relatedDtc?.code ?? index}`}
          >
            <header>
              <div>
                <span>Hallazgo {index + 1}</span>
                <strong>{finding.relatedDtc?.code ?? "Sin DTC específico"}</strong>
                {finding.relatedDtc && (
                  <small>
                    {finding.relatedDtc.moduleCode
                      ? `${finding.relatedDtc.moduleCode} · ${finding.relatedDtc.moduleName}`
                      : finding.relatedDtc.moduleName}
                  </small>
                )}
              </div>
              <span className={`priority-badge ${finding.priority}`}>Prioridad {PRIORITY_LABELS[finding.priority]}</span>
            </header>
            <p>{finding.simpleExplanation}</p>
            <div className="guidance-grid">
              <div>
                <h4>Posibles causas</h4>
                {finding.possibleCauses.length > 0 ? (
                  <ul>{finding.possibleCauses.map((cause) => <li key={cause}>{cause}</li>)}</ul>
                ) : <p>No se propusieron causas específicas.</p>}
              </div>
              <div>
                <h4>Comprobaciones recomendadas</h4>
                {finding.recommendedChecks.length > 0 ? (
                  <ul>{finding.recommendedChecks.map((check) => <li key={check}>{check}</li>)}</ul>
                ) : <p>No se propusieron comprobaciones específicas.</p>}
              </div>
            </div>
            {finding.safetyWarnings.length > 0 && (
              <div className="analysis-warning">
                <h4>Advertencias de seguridad</h4>
                <ul>{finding.safetyWarnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
              </div>
            )}
            <span className="finding-confidence">Confianza: {CONFIDENCE_LABELS[finding.confidence]}</span>
          </article>
        ))}
      </div>

      <div className={`observation-correlation ${analysis.observationCorrelation.status}`}>
        <h3>Relación con las observaciones del vehículo</h3>
        {analysis.observationCorrelation.status === "not_provided" ? (
          <p>No se proporcionaron observaciones adicionales. El análisis se realizó únicamente con los DTC extraídos del reporte.</p>
        ) : (
          <p>{analysis.observationCorrelation.summary}</p>
        )}
        {analysis.observationCorrelation.matches.length > 0 && (
          <ul className="observation-matches">
            {analysis.observationCorrelation.matches.map((match) => (
              <li key={dtcIdentity(match.relatedDtc)}>
                <div>
                  <strong>{match.relatedDtc.code}</strong>
                  <span>
                    {match.relatedDtc.moduleCode
                      ? `${match.relatedDtc.moduleCode} · ${match.relatedDtc.moduleName}`
                      : match.relatedDtc.moduleName}
                  </span>
                </div>
                <p><strong>Observación relacionada:</strong> {match.observation}</p>
                <p>{match.possibleRelation}</p>
                <span>Confianza de la relación: {CONFIDENCE_LABELS[match.confidence]}</span>
              </li>
            ))}
          </ul>
        )}
        {analysis.observationCorrelation.status !== "not_provided" && (
          <p className="correlation-caution">
            Una coincidencia es orientativa y debe verificarse mediante comprobaciones profesionales.
          </p>
        )}
      </div>

      {analysis.safetyWarnings.length > 0 && (
        <div className="analysis-warning overall">
          <h3>Advertencias generales de seguridad</h3>
          <ul>{analysis.safetyWarnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
        </div>
      )}

      {analysis.requiresTechnicianConfirmation && (
        <p className="technician-confirmation">Requiere confirmación del técnico</p>
      )}
    </div>
  );
}

interface AiAnalysisSectionProps {
  preparation: AnalysisPreparation;
  state: AnalysisUiState;
  onRequestConfirmation: () => void;
  onCancelConfirmation: () => void;
  onConfirm: () => void;
  observationsProvided: boolean;
  observationsChanged: boolean;
  pdfStatus: PdfStatus;
  pdfMessage: string;
  onDownloadPdf: () => void;
}

function normalizeObservations(value: string) {
  return value.replace(/\r\n?/gu, "\n").trim();
}

function buildHistoryContext(reportReference: string, contentToken: string, extraction: ExtractionResult, extractionToken?: string) {
  return {
    reportReference,
    contentToken,
    ...(extractionToken ? { extractionToken } : {}),
    extraction: {
      ...(extraction.review ? { review: extraction.review } : {}),
      status: extraction.status,
      format: extraction.format,
      requiresManualReview: extraction.requiresManualReview,
      vehicle: {
        year: extraction.vehicle.year,
        make: extraction.vehicle.make,
        model: extraction.vehicle.model,
        engine: extraction.vehicle.engine,
        odometer: extraction.vehicle.odometer === null ? null : { ...extraction.vehicle.odometer },
        vinMasked: extraction.vehicle.vinMasked,
        vinPseudonym: extraction.vehicle.vinPseudonym,
        ...(extraction.vehicle.odometerRaw ? { odometerRaw: extraction.vehicle.odometerRaw } : {}),
      },
      scanSummary: { ...extraction.scanSummary },
      systems: extraction.systems.map((system) => ({ ...system })),
      dtcs: extraction.dtcs.map((dtc) => ({ ...dtc })),
      warnings: extraction.warnings.map((warning) => ({ ...warning })),
    },
  };
}

function createReportExportSource(
  extraction: ExtractionResult,
  input: DiagnosticAnalysisInput,
  counts: AnalysisCounts,
  analysis: DiagnosticAnalysis,
  rag: RagMetadata,
  submittedObservations: string,
): ReportExportSource {
  return {
    ...(extraction.review ? { review: extraction.review } : {}),
    vehicle: {
      make: extraction.vehicle.make,
      model: extraction.vehicle.model,
      year: extraction.vehicle.year,
      odometer: extraction.vehicle.odometer === null ? null : { ...extraction.vehicle.odometer },
      ...(extraction.vehicle.odometerRaw ? { odometerRaw: extraction.vehicle.odometerRaw } : {}),
    },
    counts: {
      systems: extraction.scanSummary.parsedSystems,
      detected: counts.detected,
      actionable: counts.actionable,
      historical: counts.historical,
    },
    actionableModules: input.modules.map((module) => ({
      code: module.code,
      name: module.name,
      dtcs: module.dtcs.map((dtc) => ({
        code: dtc.code,
        description: dtc.description,
        status: dtc.status,
        alsoHistorical: dtc.alsoHistorical,
      })),
    })),
    documentaryDtcs: extraction.dtcs.map((dtc) => ({
      code: dtc.code,
      moduleCode: dtc.moduleCode,
      moduleName: dtc.moduleName,
      description: dtc.descriptionOriginal,
      originalStatus: dtc.statusOriginal,
      normalizedClassification: dtc.classification,
    })),
    analysis: {
      technicalSummary: analysis.technicalSummary,
      findings: analysis.findings.map((finding) => ({
        relatedDtc: finding.relatedDtc === null ? null : { ...finding.relatedDtc },
        priority: finding.priority,
        simpleExplanation: finding.simpleExplanation,
        possibleCauses: [...finding.possibleCauses],
        recommendedChecks: [...finding.recommendedChecks],
        safetyWarnings: [...finding.safetyWarnings],
        confidence: finding.confidence,
      })),
      observationCorrelation: {
        status: analysis.observationCorrelation.status,
        summary: analysis.observationCorrelation.summary,
        matches: analysis.observationCorrelation.matches.map((match) => ({
          relatedDtc: { ...match.relatedDtc },
          observation: match.observation,
          possibleRelation: match.possibleRelation,
          confidence: match.confidence,
        })),
      },
      safetyWarnings: [...analysis.safetyWarnings],
      confidence: analysis.confidence,
      requiresTechnicianConfirmation: analysis.requiresTechnicianConfirmation,
    },
    rag: {
      enabled: rag.enabled,
      used: rag.used,
      status: rag.status,
      querySummary: rag.querySummary,
      sources: rag.sources.map((source) => ({
        id: source.id,
        title: source.title,
        label: source.label,
        ...(source.url === undefined ? {} : { url: source.url }),
        similarity: source.similarity,
        excerpt: source.excerpt,
        ...(source.provenance === undefined ? {} : { provenance: { ...source.provenance } }),
      })),
    },
    submittedObservations,
  };
}

function AiAnalysisSection({
  preparation,
  state,
  onRequestConfirmation,
  onCancelConfirmation,
  onConfirm,
  observationsProvided,
  observationsChanged,
  pdfStatus,
  pdfMessage,
  onDownloadPdf,
}: AiAnalysisSectionProps) {
  const requestButtonRef = useRef<HTMLButtonElement>(null);
  const confirmationTitleRef = useRef<HTMLHeadingElement>(null);
  const previousStatusRef = useRef(state.status);

  useEffect(() => {
    if (state.status === "confirming") confirmationTitleRef.current?.focus();
    if (previousStatusRef.current === "confirming" && ["ready", "completed"].includes(state.status)) {
      requestButtonRef.current?.focus();
    }
    previousStatusRef.current = state.status;
  }, [state.status]);

  return (
    <section className="ai-analysis" aria-labelledby="ai-analysis-title">
      <div className="results-heading">
        <div>
          <span className="eyebrow">ORIENTACIÓN, NO DIAGNÓSTICO DEFINITIVO</span>
          <h2 id="ai-analysis-title">Orientación asistida por IA</h2>
        </div>
        <span className={`analysis-state ${state.status}`}>
          {state.status === "completed" ? "Completada" : state.status === "analyzing" ? "Analizando" : "Opcional"}
        </span>
      </div>

      {!preparation.available ? (
        <div className="analysis-unavailable" role="status">
          <h3>Análisis no disponible</h3>
          <ul>{preparation.reasons.map((reason) => <li key={reason.code}>{reason.message}</li>)}</ul>
        </div>
      ) : (
        <>
          {preparation.warnings.length > 0 && (
            <div className="analysis-preparation-warnings">
              <ul>{preparation.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
            </div>
          )}

          {state.status === "ready" && (
            <div className="analysis-ready">
              <p>Solicita una orientación basada únicamente en los DTC extraídos cuando estés listo.</p>
              <button ref={requestButtonRef} className="analysis-button" type="button" onClick={onRequestConfirmation}>Analizar DTC con IA</button>
            </div>
          )}

          {state.status === "confirming" && (
            <div className="analysis-confirmation" role="group" aria-labelledby="analysis-confirmation-title">
              <h3 ref={confirmationTitleRef} id="analysis-confirmation-title" tabIndex={-1}>Confirma los datos que se enviarán</h3>
              <p>Se enviarán únicamente:</p>
              <ul>
                <li>Marca, modelo y año.</li>
                <li>Nombres y códigos de módulos.</li>
                <li>Códigos DTC, descripciones y estados.</li>
                {observationsProvided && <li>Las observaciones del vehículo escritas en el formulario.</li>}
              </ul>
              <p className="data-exclusion"><strong>No se enviarán a OpenAI</strong> el VIN protegido, el PDF, el odómetro ni datos del cliente. El historial recibe solo snapshots técnicos sanitizados.</p>
              <div className="confirmation-actions">
                <button className="analysis-button" type="button" onClick={onConfirm}>Confirmar y analizar</button>
                <button className="secondary-button" type="button" onClick={onCancelConfirmation}>Cancelar</button>
              </div>
            </div>
          )}

          {state.status === "analyzing" && (
            <div className="analysis-progress" role="status" aria-live="polite">
              <span className="analysis-spinner" aria-hidden="true" />
              <div><strong>Analizando DTC…</strong><span>Preparando orientación y comprobaciones recomendadas.</span></div>
              <button className="analysis-button" type="button" disabled>Analizar DTC con IA</button>
            </div>
          )}

          {state.status === "error" && (
            <div className="analysis-error" role="alert">
              <h3>No fue posible obtener la orientación</h3>
              <p>{state.message}</p>
              <button className="analysis-button" type="button" onClick={onRequestConfirmation}>Reintentar</button>
            </div>
          )}

          {state.status === "completed" && state.message && (
            <p className="analysis-reused" role="status" aria-live="polite">{state.message}</p>
          )}

          {state.status !== "completed" && state.analysis && state.rag && (
            <div className="preserved-analysis">
              <p className="preserved-analysis-note" role="status">
                Se conserva la orientación anterior mientras reintentas la solicitud.
              </p>
              <AnalysisResult analysis={state.analysis} rag={state.rag} />
            </div>
          )}

          {state.status === "completed" && state.analysis && state.rag && (
            <>
              <AnalysisResult analysis={state.analysis} rag={state.rag} />
              <div className="pdf-download" aria-live="polite">
                <button
                  className="pdf-download-button"
                  type="button"
                  onClick={onDownloadPdf}
                  disabled={observationsChanged || pdfStatus === "generating"}
                >
                  {pdfStatus === "generating" ? <span className="spinner" aria-hidden="true" /> : (
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M12 4v11m0 0 4-4m-4 4-4-4M5 18v2h14v-2" />
                    </svg>
                  )}
                  {pdfStatus === "generating" ? "Creando informe…" : "Descargar informe PDF"}
                </button>
                {observationsChanged ? (
                  <p>Vuelve a analizar las observaciones actuales antes de descargar un informe actualizado.</p>
                ) : pdfMessage ? (
                  <p className={pdfStatus === "error" ? "pdf-error" : "pdf-success"} role={pdfStatus === "error" ? "alert" : "status"}>
                    {pdfMessage}
                  </p>
                ) : (
                  <p>Se genera localmente sin otra llamada a OpenAI ni consumo adicional de tokens.</p>
                )}
              </div>
              {observationsChanged && (
                <div className="analysis-observations-changed" role="status">
                  <p>Las observaciones cambiaron después de este resultado. La orientación mostrada no se actualizará automáticamente.</p>
                  <button ref={requestButtonRef} className="analysis-button" type="button" onClick={onRequestConfirmation}>
                    Volver a analizar con las observaciones actuales
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}

interface ReportWorkspaceProps {
  apiClient: BrowserApiClient;
  identity: AuthIdentity;
  connectivityStatus: ConnectivityStatus;
  connectionRestored: boolean;
  isLoggingOut: boolean;
  logoutError: string;
  onLogout: () => void;
  onSessionInvalid: () => void;
  onConnectivityChecking: () => void;
  onConnectivityUnavailable: () => void;
  onConnectivityConnected: () => void;
}

function ReportWorkspace({
  apiClient,
  identity,
  connectivityStatus,
  connectionRestored,
  isLoggingOut,
  logoutError,
  onLogout,
  onSessionInvalid,
  onConnectivityChecking,
  onConnectivityUnavailable,
  onConnectivityConnected,
}: ReportWorkspaceProps) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [status, setStatus] = useState<UploadStatus>("idle");
  const [message, setMessage] = useState("");
  const [uploadResult, setUploadResult] = useState<UploadResponse | null>(null);
  const [reviewEditing, setReviewEditing] = useState(false);
  const reviewEditingRef = useRef(false);
  const [analysisState, setAnalysisState] = useState<AnalysisUiState>({ status: "unavailable" });
  const [observations, setObservations] = useState("");
  const [observationsError, setObservationsError] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [pdfStatus, setPdfStatus] = useState<PdfStatus>("idle");
  const [pdfMessage, setPdfMessage] = useState("");
  const [workspaceView, setWorkspaceView] = useState<"new" | "history" | "statistics">("new");
  const [historyState, setHistoryState] = useState<HistoryViewState>({ status: "idle", items: [], nextCursor: null });
  const [historyDetail, setHistoryDetail] = useState<HistoryDetail | null>(null);
  const [historyDetailStatus, setHistoryDetailStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [historyDetailMessage, setHistoryDetailMessage] = useState("");
  const [historyPdfStatus, setHistoryPdfStatus] = useState<PdfStatus>("idle");
  const [historyPdfMessage, setHistoryPdfMessage] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const logoRef = useRef<HTMLImageElement>(null);
  const uploadInProgressRef = useRef(false);
  const uploadSequenceRef = useRef(0);
  const activeUploadRef = useRef<{ id: number; file: File; controller: AbortController } | null>(null);
  const analysisInProgressRef = useRef(false);
  const analysisSequenceRef = useRef(0);
  const activeAnalysisRef = useRef<{ id: number; reportId: string; controller: AbortController } | null>(null);
  const analysisIdempotencyRef = useRef<{ signature: string; key: string } | null>(null);
  const pdfGenerationInProgressRef = useRef(false);
  const pdfSequenceRef = useRef(0);
  const activePdfGenerationRef = useRef<{ id: number; reportId: string } | null>(null);
  const historyListSequenceRef = useRef(0);
  const historyDetailSequenceRef = useRef(0);
  const historyListControllerRef = useRef<AbortController | null>(null);
  const historyDetailControllerRef = useRef<AbortController | null>(null);
  const historyDetailRequestIdRef = useRef<string | null>(null);
  const healthControllerRef = useRef<AbortController | null>(null);
  const retryActionRef = useRef<(() => void) | null>(null);

  useEffect(() => () => {
    uploadSequenceRef.current += 1;
    analysisSequenceRef.current += 1;
    pdfSequenceRef.current += 1;
    activeUploadRef.current?.controller.abort();
    activeAnalysisRef.current?.controller.abort();
    historyListControllerRef.current?.abort();
    historyDetailControllerRef.current?.abort();
    healthControllerRef.current?.abort();
    activeUploadRef.current = null;
    activeAnalysisRef.current = null;
    analysisIdempotencyRef.current = null;
    uploadInProgressRef.current = false;
    analysisInProgressRef.current = false;
    pdfGenerationInProgressRef.current = false;
    activePdfGenerationRef.current = null;
    historyListControllerRef.current = null;
    historyDetailControllerRef.current = null;
    historyDetailRequestIdRef.current = null;
    healthControllerRef.current = null;
    retryActionRef.current = null;
  }, []);

  function invalidateActiveSession() {
    uploadSequenceRef.current += 1;
    analysisSequenceRef.current += 1;
    pdfSequenceRef.current += 1;
    activeUploadRef.current?.controller.abort();
    activeAnalysisRef.current?.controller.abort();
    historyListControllerRef.current?.abort();
    historyDetailControllerRef.current?.abort();
    healthControllerRef.current?.abort();
    activeUploadRef.current = null;
    activeAnalysisRef.current = null;
    analysisIdempotencyRef.current = null;
    activePdfGenerationRef.current = null;
    historyListControllerRef.current = null;
    historyDetailControllerRef.current = null;
    historyDetailRequestIdRef.current = null;
    healthControllerRef.current = null;
    retryActionRef.current = null;
    historyListSequenceRef.current += 1;
    historyDetailSequenceRef.current += 1;
    setHistoryState({ status: "idle", items: [], nextCursor: null });
    setHistoryDetail(null);
    setHistoryDetailStatus("idle");
    setHistoryDetailMessage("");
    uploadInProgressRef.current = false;
    analysisInProgressRef.current = false;
    pdfGenerationInProgressRef.current = false;
    onSessionInvalid();
  }

  function handleApiFailure(error: unknown, retry: () => void) {
    if (!(error instanceof ApiRequestError)) return false;
    if (error.type === "aborted") return true;
    if (error.type === "unauthorized") {
      invalidateActiveSession();
      return true;
    }
    retryActionRef.current = retry;
    if (["network", "timeout", "server", "invalid_response"].includes(error.type)) {
      onConnectivityUnavailable();
    } else {
      onConnectivityConnected();
    }
    return false;
  }

  async function checkConnection() {
    if (healthControllerRef.current) return;
    const controller = new AbortController();
    healthControllerRef.current = controller;
    onConnectivityChecking();
    try {
      await apiClient.checkHealth(controller.signal);
      if (healthControllerRef.current !== controller) return;
      onConnectivityConnected();
    } catch (error) {
      if (healthControllerRef.current !== controller) return;
      if (!(error instanceof ApiRequestError) || error.type !== "aborted") {
        onConnectivityUnavailable();
      }
    } finally {
      if (healthControllerRef.current === controller) healthControllerRef.current = null;
    }
  }

  function resetPdfGeneration() {
    pdfSequenceRef.current += 1;
    activePdfGenerationRef.current = null;
    pdfGenerationInProgressRef.current = false;
    setPdfStatus("idle");
    setPdfMessage("");
  }

  function resetAnalysisForReportChange(showCancellation: boolean) {
    reviewEditingRef.current = false;
    setReviewEditing(false);
    retryActionRef.current = null;
    resetPdfGeneration();
    analysisSequenceRef.current += 1;
    activeAnalysisRef.current?.controller.abort();
    activeAnalysisRef.current = null;
    analysisIdempotencyRef.current = null;
    analysisInProgressRef.current = false;
    setAnalysisState(
      showCancellation
        ? { status: "cancelled", message: "La orientación anterior se canceló al cambiar de reporte." }
        : { status: "unavailable" },
    );
  }

  function selectFile(file: File | undefined) {
    if (!file || uploadInProgressRef.current) return false;

    const validationError = validateFile(file);
    const replacesReport = selectedFile !== null || uploadResult !== null;
    resetAnalysisForReportChange(uploadResult !== null || activeAnalysisRef.current !== null);
    setUploadResult(null);
    if (replacesReport) {
      setObservations("");
      setObservationsError("");
    }

    if (validationError) {
      setSelectedFile(null);
      setStatus("error");
      setMessage(validationError);
      if (inputRef.current) inputRef.current.value = "";
      return false;
    }

    setSelectedFile(file);
    setStatus("idle");
    setMessage("");
    return true;
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";

    if (uploadInProgressRef.current) return;
    selectFile(file);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);

    if (uploadInProgressRef.current) return;

    if (event.dataTransfer.files.length > 1) {
      resetAnalysisForReportChange(uploadResult !== null || activeAnalysisRef.current !== null);
      setSelectedFile(null);
      setStatus("error");
      setMessage("Selecciona solamente un archivo PDF.");
      setObservations("");
      setObservationsError("");
      if (inputRef.current) inputRef.current.value = "";
      return;
    }

    if (selectFile(event.dataTransfer.files[0]) && inputRef.current) {
      inputRef.current.value = "";
    }
  }

  function removeFile() {
    if (uploadInProgressRef.current) return;

    resetAnalysisForReportChange(uploadResult !== null || activeAnalysisRef.current !== null);
    setSelectedFile(null);
    setStatus("idle");
    setMessage("");
    setUploadResult(null);
    setObservations("");
    setObservationsError("");
    if (inputRef.current) inputRef.current.value = "";
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submitReport();
  }

  async function submitReport() {
    if (!selectedFile || uploadInProgressRef.current) return;

    uploadInProgressRef.current = true;
    const uploadId = ++uploadSequenceRef.current;
    const fileBeingUploaded = selectedFile;
    const controller = new AbortController();
    activeUploadRef.current = { id: uploadId, file: fileBeingUploaded, controller };

    const isActiveUpload = () => {
      const activeUpload = activeUploadRef.current;
      return activeUpload?.id === uploadId
        && activeUpload.file === fileBeingUploaded
        && activeUpload.controller === controller;
    };

    setStatus("uploading");
    setMessage("Enviando reporte de forma segura…");

    const formData = new FormData();
    formData.append("report", fileBeingUploaded);

    try {
      const result = await apiClient.requestJson<UploadResponse>("/api/reports/upload", {
        init: {
          method: "POST",
          body: formData,
          signal: controller.signal,
        },
        retry: "none",
        parse: parseUploadResponse,
        invalidResponseMessage: "El servidor devolvió una respuesta de carga no válida.",
        errorMessage: (value) => controlledErrorMessage(value, "No fue posible enviar el reporte."),
      });
      if (!isActiveUpload()) return;
      resetAnalysisForReportChange(uploadResult !== null || activeAnalysisRef.current !== null);
      setUploadResult(result);
      setAnalysisState({ status: result.analysisPreparation.available ? "ready" : "unavailable" });
      setStatus("success");
      setMessage("Reporte recibido correctamente.");
      retryActionRef.current = null;
      onConnectivityConnected();
    } catch (error) {
      if (!isActiveUpload()) return;
      if (handleApiFailure(error, () => void submitReport())) return;

      setStatus("error");
      setMessage(error instanceof Error ? error.message : "No fue posible enviar el reporte.");
    } finally {
      if (isActiveUpload()) {
        activeUploadRef.current = null;
        uploadInProgressRef.current = false;
      }
    }
  }

  function requestAnalysisConfirmation() {
    if (reviewEditingRef.current || !uploadResult?.analysisPreparation.available || analysisInProgressRef.current) return;
    setAnalysisState((current) => ({
      status: "confirming",
      ...(current.analysis ? { analysis: current.analysis } : {}),
      ...(current.rag ? { rag: current.rag } : {}),
      ...(current.submittedObservations !== undefined
        ? { submittedObservations: current.submittedObservations }
        : {}),
    }));
  }

  function cancelAnalysisConfirmation() {
    if (analysisInProgressRef.current) return;
    setAnalysisState((current) => current.analysis
      ? {
          status: "completed",
          analysis: current.analysis,
          ...(current.rag ? { rag: current.rag } : {}),
          submittedObservations: current.submittedObservations ?? "",
        }
      : { status: "ready" });
  }

  async function confirmAnalysis() {
    const preparation = uploadResult?.analysisPreparation;
    if (reviewEditingRef.current || !uploadResult || !preparation?.available || analysisInProgressRef.current) return;
    const normalizedObservations = normalizeObservations(observations);
    const requestInput: DiagnosticAnalysisInput = {
      ...preparation.input,
      ...(normalizedObservations.length === 0 ? {} : { observations: normalizedObservations }),
    };
    const idempotencySignature = JSON.stringify({ reportReference: uploadResult.id, input: requestInput });
    if (analysisIdempotencyRef.current?.signature !== idempotencySignature) {
      analysisIdempotencyRef.current = {
        signature: idempotencySignature,
        key: globalThis.crypto.randomUUID(),
      };
    }
    const idempotencyKey = analysisIdempotencyRef.current.key;
    const preservedAnalysis = analysisState.analysis;
    const preservedRag = analysisState.rag;
    const preservedObservations = analysisState.submittedObservations;

    analysisInProgressRef.current = true;
    resetPdfGeneration();
    const requestId = ++analysisSequenceRef.current;
    const reportId = uploadResult.id;
    const controller = new AbortController();
    activeAnalysisRef.current = { id: requestId, reportId, controller };

    const isActiveAnalysis = () => {
      const active = activeAnalysisRef.current;
      return active?.id === requestId && active.reportId === reportId && active.controller === controller;
    };

    setAnalysisState({
      status: "analyzing",
      ...(preservedAnalysis ? { analysis: preservedAnalysis } : {}),
      ...(preservedRag ? { rag: preservedRag } : {}),
      ...(preservedObservations !== undefined ? { submittedObservations: preservedObservations } : {}),
    });

    try {
      const result = await apiClient.requestJson<AnalysisResponse>("/api/reports/analyze", {
        init: {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify({
            input: requestInput,
            historyContext: buildHistoryContext(uploadResult.id, uploadResult.contentToken, uploadResult.extraction, uploadResult.extractionToken),
          }),
          signal: controller.signal,
        },
        retry: "none",
        timeoutMs: ANALYSIS_HTTP_TIMEOUT_MS,
        parse: parseAnalysisResponse,
        invalidResponseMessage: AI_ERROR_MESSAGES.OPENAI_RESPONSE_INVALID,
        errorMessage: (value) => getAiErrorMessage((value as ErrorResponse | null)?.error?.code),
      });
      if (!isActiveAnalysis()) return;
      const inputDtcIdentities = new Set(
        requestInput.modules.flatMap((module) =>
          module.dtcs.map((dtc) => dtcIdentity({ code: dtc.code, moduleCode: module.code, moduleName: module.name })),
        ),
      );
      const relatedIdentities = result.analysis.findings.flatMap((finding) =>
        finding.relatedDtc === null ? [] : [dtcIdentity(finding.relatedDtc)],
      );
      const correlationIdentities = result.analysis.observationCorrelation.matches.map((match) =>
        dtcIdentity(match.relatedDtc)
      );
      const correlationStatusIsInvalid = normalizedObservations.length === 0
        ? result.analysis.observationCorrelation.status !== "not_provided"
        : result.analysis.observationCorrelation.status === "not_provided";
      const hasInvalidDtcReference = relatedIdentities.some((identity) => !inputDtcIdentities.has(identity))
        || new Set(relatedIdentities).size !== relatedIdentities.length
        || correlationIdentities.some((identity) => !inputDtcIdentities.has(identity))
        || new Set(correlationIdentities).size !== correlationIdentities.length;
      if (hasInvalidDtcReference || correlationStatusIsInvalid) {
        setAnalysisState({
          status: "error",
          message: AI_ERROR_MESSAGES.OPENAI_RESPONSE_INVALID,
          ...(preservedAnalysis ? { analysis: preservedAnalysis } : {}),
          ...(preservedRag ? { rag: preservedRag } : {}),
          ...(preservedObservations !== undefined ? { submittedObservations: preservedObservations } : {}),
        });
        return;
      }

      setAnalysisState({
        status: "completed",
        analysis: result.analysis,
        rag: result.rag,
        ...(result.reused
          ? { message: "Este reporte ya había sido analizado. Se recuperó el resultado existente sin repetir el procesamiento." }
          : {}),
        submittedObservations: normalizedObservations,
      });
      if (result.history.status === "saved") {
        setHistoryState({ status: "idle", items: [], nextCursor: null });
      }
      retryActionRef.current = null;
      onConnectivityConnected();
    } catch (error) {
      if (!isActiveAnalysis()) return;
      if (handleApiFailure(error, requestAnalysisConfirmation)) return;
      setAnalysisState({
        status: "error",
        message: error instanceof ApiRequestError && error.type === "timeout"
          ? ANALYSIS_TIMEOUT_MESSAGE
          : error instanceof Error ? error.message : "No fue posible obtener la orientación por IA.",
        ...(preservedAnalysis ? { analysis: preservedAnalysis } : {}),
        ...(preservedRag ? { rag: preservedRag } : {}),
        ...(preservedObservations !== undefined ? { submittedObservations: preservedObservations } : {}),
      });
    } finally {
      if (isActiveAnalysis()) {
        activeAnalysisRef.current = null;
        analysisInProgressRef.current = false;
      }
    }
  }

  async function handleDownloadPdf() {
    const preparation = uploadResult?.analysisPreparation;
    const analysis = analysisState.analysis;
    const rag = analysisState.rag;
    const submittedObservations = analysisState.submittedObservations;
    if (
      pdfGenerationInProgressRef.current ||
      !analysis ||
      !rag ||
      submittedObservations === undefined ||
      observationsChanged ||
      !uploadResult ||
      !preparation?.available ||
      !logoRef.current
    ) return;

    pdfGenerationInProgressRef.current = true;
    const generationId = ++pdfSequenceRef.current;
    const reportId = uploadResult.id;
    activePdfGenerationRef.current = { id: generationId, reportId };
    const isActiveGeneration = () => {
      const active = activePdfGenerationRef.current;
      return active?.id === generationId && active.reportId === reportId;
    };
    setPdfStatus("generating");
    setPdfMessage("Creando el informe de forma local…");

    try {
      const exportModel = buildReportExportModel({
        ...(uploadResult.extraction.review ? { review: uploadResult.extraction.review } : {}),
        vehicle: {
          make: uploadResult.extraction.vehicle.make,
          model: uploadResult.extraction.vehicle.model,
          year: uploadResult.extraction.vehicle.year,
          ...(uploadResult.extraction.vehicle.odometerRaw ? { odometerRaw: uploadResult.extraction.vehicle.odometerRaw } : {}),
          odometer: uploadResult.extraction.vehicle.odometer === null
            ? null
            : { ...uploadResult.extraction.vehicle.odometer },
        },
        counts: {
          systems: uploadResult.extraction.scanSummary.parsedSystems,
          detected: preparation.counts.detected,
          actionable: preparation.counts.actionable,
          historical: preparation.counts.historical,
        },
        actionableModules: preparation.input.modules.map((module) => ({
          code: module.code,
          name: module.name,
          dtcs: module.dtcs.map((dtc) => ({
            code: dtc.code,
            description: dtc.description,
            status: dtc.status,
            alsoHistorical: dtc.alsoHistorical,
          })),
        })),
        documentaryDtcs: uploadResult.extraction.dtcs.map((dtc) => ({
          code: dtc.code,
          moduleCode: dtc.moduleCode,
          moduleName: dtc.moduleName,
          description: dtc.descriptionOriginal,
          originalStatus: dtc.statusOriginal,
          normalizedClassification: dtc.classification,
        })),
        analysis: {
          technicalSummary: analysis.technicalSummary,
          findings: analysis.findings.map((finding) => ({
            relatedDtc: finding.relatedDtc === null ? null : {
              code: finding.relatedDtc.code,
              moduleCode: finding.relatedDtc.moduleCode,
              moduleName: finding.relatedDtc.moduleName,
            },
            priority: finding.priority,
            simpleExplanation: finding.simpleExplanation,
            possibleCauses: [...finding.possibleCauses],
            recommendedChecks: [...finding.recommendedChecks],
            safetyWarnings: [...finding.safetyWarnings],
            confidence: finding.confidence,
          })),
          observationCorrelation: {
            status: analysis.observationCorrelation.status,
            summary: analysis.observationCorrelation.summary,
            matches: analysis.observationCorrelation.matches.map((match) => ({
              relatedDtc: {
                code: match.relatedDtc.code,
                moduleCode: match.relatedDtc.moduleCode,
                moduleName: match.relatedDtc.moduleName,
              },
              observation: match.observation,
              possibleRelation: match.possibleRelation,
              confidence: match.confidence,
            })),
          },
          safetyWarnings: [...analysis.safetyWarnings],
          confidence: analysis.confidence,
          requiresTechnicianConfirmation: analysis.requiresTechnicianConfirmation,
        },
        rag: {
          enabled: rag.enabled,
          used: rag.used,
          status: rag.status,
          querySummary: rag.querySummary,
          sources: rag.sources.map((source) => ({
            id: source.id,
            title: source.title,
            label: source.label,
            ...(source.url === undefined ? {} : { url: source.url }),
            similarity: source.similarity,
            excerpt: source.excerpt,
            ...(source.provenance === undefined ? {} : { provenance: { ...source.provenance } }),
          })),
        },
        submittedObservations,
      });
      await downloadReportPdf(exportModel, new Date(), logoRef.current);
      if (!isActiveGeneration()) return;
      setPdfStatus("success");
      setPdfMessage("Informe PDF descargado correctamente.");
    } catch {
      if (!isActiveGeneration()) return;
      setPdfStatus("error");
      setPdfMessage("No fue posible crear el informe PDF. Puedes intentarlo de nuevo.");
    } finally {
      if (isActiveGeneration()) {
        activePdfGenerationRef.current = null;
        pdfGenerationInProgressRef.current = false;
      }
    }
  }

  async function loadHistory(append: boolean) {
    if (historyListControllerRef.current) return;
    const cursor = append ? historyState.nextCursor : null;
    if (append && cursor === null) return;
    const controller = new AbortController();
    const sequence = ++historyListSequenceRef.current;
    historyListControllerRef.current = controller;
    setHistoryState((current) => ({
      status: "loading",
      items: current.items,
      nextCursor: current.nextCursor,
    }));
    try {
      const parameters = new URLSearchParams({ limit: "20" });
      if (cursor) parameters.set("cursor", cursor);
      const parsed = await apiClient.requestJson<HistoryListResponse>(`/api/history?${parameters.toString()}`, {
        init: { signal: controller.signal },
        retry: "once",
        timeoutMs: 10_000,
        parse: parseHistoryListResponse,
        invalidResponseMessage: "El servidor devolvió un historial inválido.",
        errorMessage: (value) => controlledErrorMessage(value, "No fue posible cargar el historial."),
      });
      if (sequence !== historyListSequenceRef.current || historyListControllerRef.current !== controller) return;
      setHistoryState((current) => {
        const combined = append ? [...current.items, ...parsed.items] : parsed.items;
        const unique = combined.filter((item, index) => combined.findIndex((candidate) => candidate.id === item.id) === index);
        return {
          status: unique.length === 0 ? "empty" : "ready",
          items: unique,
          nextCursor: parsed.nextCursor,
        };
      });
      retryActionRef.current = null;
      onConnectivityConnected();
    } catch (error) {
      if (controller.signal.aborted || sequence !== historyListSequenceRef.current) return;
      if (handleApiFailure(error, () => void loadHistory(append))) return;
      setHistoryState((current) => ({
        status: "error",
        items: current.items,
        nextCursor: current.nextCursor,
        message: error instanceof Error ? error.message : "No fue posible cargar el historial.",
      }));
    } finally {
      if (historyListControllerRef.current === controller) historyListControllerRef.current = null;
    }
  }

  function showHistory() {
    setWorkspaceView("history");
    setHistoryDetail(null);
    setHistoryDetailStatus("idle");
    setHistoryDetailMessage("");
    setHistoryPdfStatus("idle");
    setHistoryPdfMessage("");
    if (historyState.status === "idle") void loadHistory(false);
  }

  function showNewDiagnostic() {
    historyDetailControllerRef.current?.abort();
    historyDetailControllerRef.current = null;
    historyDetailSequenceRef.current += 1;
    setWorkspaceView("new");
    setHistoryDetail(null);
    setHistoryDetailStatus("idle");
    setHistoryDetailMessage("");
    setHistoryPdfStatus("idle");
    setHistoryPdfMessage("");
  }

  async function openHistory(id: string) {
    if (historyDetailControllerRef.current) return;
    const controller = new AbortController();
    const sequence = ++historyDetailSequenceRef.current;
    historyDetailRequestIdRef.current = id;
    historyDetailControllerRef.current = controller;
    setHistoryDetail(null);
    setHistoryDetailStatus("loading");
    setHistoryDetailMessage("");
    setHistoryPdfStatus("idle");
    setHistoryPdfMessage("");
    try {
      const parsed = await apiClient.requestJson<HistoryDetail>(`/api/history/${encodeURIComponent(id)}`, {
        init: { signal: controller.signal },
        retry: "once",
        timeoutMs: 10_000,
        parse: (value) => {
          if (!value || typeof value !== "object" || !hasOnlyKeys(value, ["history"])) return null;
          return parseHistoryDetail((value as { history?: unknown }).history);
        },
        invalidResponseMessage: "El servidor devolvió un diagnóstico inválido.",
        errorMessage: (value) => controlledErrorMessage(value, "No fue posible abrir el diagnóstico."),
      });
      if (sequence !== historyDetailSequenceRef.current || historyDetailControllerRef.current !== controller) return;
      setHistoryDetail(parsed);
      setHistoryDetailStatus("ready");
      retryActionRef.current = null;
      onConnectivityConnected();
    } catch (error) {
      if (controller.signal.aborted || sequence !== historyDetailSequenceRef.current) return;
      if (handleApiFailure(error, () => void openHistory(id))) return;
      setHistoryDetailStatus("error");
      setHistoryDetailMessage(error instanceof Error ? error.message : "No fue posible abrir el diagnóstico.");
    } finally {
      if (historyDetailControllerRef.current === controller) historyDetailControllerRef.current = null;
    }
  }

  async function downloadHistoryPdf() {
    if (!historyDetail || historyPdfStatus === "generating" || !logoRef.current) return;
    setHistoryPdfStatus("generating");
    setHistoryPdfMessage("Creando el informe desde el historial…");
    try {
      const snapshot = historyDetail.snapshot;
      const source = createReportExportSource(
        snapshot.extraction,
        snapshot.analysis.input,
        snapshot.analysis.counts,
        snapshot.analysis.output,
        snapshot.rag,
        snapshot.analysis.submittedObservations,
      );
      await downloadReportPdf(buildReportExportModel(source), new Date(), logoRef.current);
      setHistoryPdfStatus("success");
      setHistoryPdfMessage("Informe histórico descargado correctamente.");
    } catch {
      setHistoryPdfStatus("error");
      setHistoryPdfMessage("No fue posible generar el informe histórico.");
    }
  }

  const normalizedObservations = normalizeObservations(observations);
  const observationsChanged = analysisState.analysis !== undefined
    && analysisState.submittedObservations !== undefined
    && analysisState.submittedObservations !== normalizedObservations;
  const observationsDisabled = status === "uploading" || analysisState.status === "analyzing";

  return (
    <main className="app-shell">
      <header className="brand">
        <img ref={logoRef} className="brand-logo" src={autodiagLogoUrl} alt="AutoDiag IA" width="2172" height="724" />
        <div className="session-controls">
          <span className="session-username">{identity.username}</span>
          <button
            className="logout-button"
            type="button"
            aria-label="Cerrar sesión"
            title="Cerrar sesión"
            onClick={onLogout}
            disabled={isLoggingOut}
          >
            {isLoggingOut ? "Cerrando sesión…" : "Cerrar sesión"}
          </button>
        </div>
      </header>

      {logoutError && <div className="logout-error" role="alert">{logoutError}</div>}

      {connectivityStatus === "unavailable" && (
        <section className="connectivity-banner unavailable" role="alert" aria-live="assertive">
          <div>
            <strong>Servidor temporalmente no disponible</strong>
            <p>{API_UNAVAILABLE_MESSAGE}</p>
          </div>
          <div className="connectivity-actions">
            <button type="button" onClick={() => {
              const retry = retryActionRef.current;
              if (retry) retry();
              else void checkConnection();
            }}>Reintentar</button>
            <button type="button" onClick={() => void checkConnection()}>Comprobar conexión</button>
          </div>
        </section>
      )}
      {connectivityStatus === "checking" && (
        <div className="connectivity-banner checking" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          <p>Comprobando conexión con el servidor…</p>
        </div>
      )}
      {connectivityStatus === "connected" && connectionRestored && (
        <div className="connectivity-banner restored" role="status" aria-live="polite">
          Conexión restablecida. Ya puedes continuar.
        </div>
      )}

      <nav className="workspace-navigation" aria-label="Secciones principales">
        <button
          type="button"
          className={workspaceView === "new" ? "is-active" : ""}
          aria-current={workspaceView === "new" ? "page" : undefined}
          onClick={showNewDiagnostic}
        >
          Nuevo diagnóstico
        </button>
        <button
          type="button"
          className={workspaceView === "history" ? "is-active" : ""}
          aria-current={workspaceView === "history" ? "page" : undefined}
          onClick={showHistory}
        >
          Historial
        </button>
        <button type="button" className={workspaceView === "statistics" ? "is-active" : ""}
          aria-current={workspaceView === "statistics" ? "page" : undefined}
          onClick={() => { showNewDiagnostic(); setWorkspaceView("statistics"); }}>Estadísticas</button>
      </nav>

      {workspaceView === "statistics" ? <HistoryStatistics apiClient={apiClient} onFailure={handleApiFailure}
        onOpen={id => { setWorkspaceView("history"); void openHistory(id); }} /> : workspaceView === "new" ? (
      <section className="upload-card" aria-labelledby="upload-title">
        <div className="intro">
          <span className="eyebrow">ANÁLISIS AUTOMOTRIZ</span>
          <h1 id="upload-title">Carga tu reporte Autel</h1>
          <p>Sube el reporte PDF generado por tu escáner. En esta etapa verificaremos que el archivo se reciba correctamente.</p>
        </div>

        <form onSubmit={handleSubmit}>
          <div
            className={`drop-zone${isDragging ? " is-dragging" : ""}${selectedFile ? " has-file" : ""}${status === "uploading" ? " is-disabled" : ""}`}
            aria-disabled={status === "uploading"}
            onDragEnter={(event) => {
              event.preventDefault();
              if (!uploadInProgressRef.current) setIsDragging(true);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setIsDragging(false);
            }}
            onDrop={handleDrop}
          >
            <input
              ref={inputRef}
              id="report-file"
              className="file-input"
              type="file"
              name="report"
              accept="application/pdf,.pdf"
              onChange={handleFileChange}
              disabled={status === "uploading"}
            />

            {selectedFile ? (
              <div className="selected-file">
                <span className="file-icon" aria-hidden="true">
                  <svg viewBox="0 0 40 48">
                    <path d="M7 1h17l9 9v37H7z" />
                    <path d="M24 1v10h9" />
                    <path d="M12 32h16M12 38h12M12 26h8" />
                  </svg>
                </span>
                <div className="file-details">
                  <strong>{selectedFile.name}</strong>
                  <span>{formatFileSize(selectedFile.size)} · PDF</span>
                </div>
                <div className="file-actions">
                  <label className={`text-button${status === "uploading" ? " is-disabled" : ""}`} htmlFor="report-file" aria-disabled={status === "uploading"}>Cambiar</label>
                  <button className="icon-button" type="button" onClick={removeFile} disabled={status === "uploading"} aria-label="Eliminar archivo seleccionado">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17" /></svg>
                  </button>
                </div>
              </div>
            ) : (
              <label className="drop-label" htmlFor="report-file">
                <span className="upload-icon" aria-hidden="true">
                  <svg viewBox="0 0 48 48">
                    <path d="M15 37h-3a8 8 0 0 1-.6-16A13 13 0 0 1 37 18a9.5 9.5 0 0 1-1 19h-4" />
                    <path d="m17 26 7-7 7 7M24 20v21" />
                  </svg>
                </span>
                <strong>{isDragging ? "Suelta el archivo aquí" : "Arrastra tu PDF aquí"}</strong>
                <span>o <u>selecciona un archivo</u> desde tu equipo</span>
              </label>
            )}
          </div>

          <div className="file-guidance" aria-label="Requisitos del archivo">
            <span><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z" /><path d="M10 9v5M10 6.5v.2" /></svg> Solo archivos PDF</span>
            <span>El servidor validará el tamaño permitido</span>
          </div>

          <div className="vehicle-observations">
            <div className="observations-heading">
              <label htmlFor="vehicle-observations">Observaciones del vehículo (opcional)</label>
              <span aria-live="polite">{observations.length}/{MAX_VEHICLE_OBSERVATIONS_LENGTH}</span>
            </div>
            <textarea
              id="vehicle-observations"
              value={observations}
              maxLength={MAX_VEHICLE_OBSERVATIONS_LENGTH}
              rows={4}
              disabled={observationsDisabled}
              aria-describedby="vehicle-observations-help vehicle-observations-error"
              aria-invalid={observationsError.length > 0}
              onChange={(event) => {
                if (uploadInProgressRef.current || analysisInProgressRef.current) return;
                const nextValue = event.currentTarget.value;
                if (nextValue.length > MAX_VEHICLE_OBSERVATIONS_LENGTH) {
                  setObservationsError("Las observaciones no pueden superar 1,000 caracteres.");
                  return;
                }
                setObservations(nextValue);
                setObservationsError("");
                resetPdfGeneration();
              }}
              placeholder="Ej.: vibración al acelerar, ruido en frío o pérdida intermitente de potencia."
            />
            <p id="vehicle-observations-help">
              Describe solo síntomas observables. No incluyas VIN, nombres, teléfonos, claves ni datos del cliente.
            </p>
            <p id="vehicle-observations-error" className="observations-error" role={observationsError ? "alert" : undefined}>
              {observationsError}
            </p>
          </div>

          <div className="status-region" aria-live="polite" aria-atomic="true">
            {message && (
              <div className={`status-message ${status}`} role={status === "error" ? "alert" : "status"}>
                <span aria-hidden="true">{status === "success" ? "✓" : status === "error" ? "!" : "↥"}</span>
                <div>
                  <strong>{message}</strong>
                  {status === "error" && UPLOAD_RECOVERY[message] && <p>{UPLOAD_RECOVERY[message]}</p>}
                  {uploadResult && <small>Referencia: {uploadResult.id}</small>}
                </div>
              </div>
            )}
          </div>

          <button className="submit-button" type="submit" disabled={!selectedFile || status === "uploading"}>
            {status === "uploading" ? <span className="spinner" aria-hidden="true" /> : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4m0 0L7 9m5-5 5 5M5 15v4h14v-4" /></svg>}
            {status === "uploading" ? "Enviando…" : status === "error" ? "Reintentar" : "Enviar reporte"}
          </button>
        </form>

        {uploadResult && (
          <>
            <ExtractionResults
              extraction={uploadResult.extraction}
              counts={uploadResult.analysisPreparation.counts}
            />
            {uploadResult.extractionToken && <ReportReviewPanel key={`${uploadResult.id}:${uploadResult.extractionToken}`} report={uploadResult} apiClient={apiClient}
              reasons={uploadResult.analysisPreparation.reasons}
              disabled={isLoggingOut || status === "uploading"} parse={parseReviewedReport}
              onEditing={() => { resetAnalysisForReportChange(false); reviewEditingRef.current = true; setReviewEditing(true); }}
              onCancel={() => { reviewEditingRef.current = false; setReviewEditing(false); setAnalysisState({ status: uploadResult.analysisPreparation.available ? "ready" : "unavailable" }); }}
              onFailure={error => { if (error instanceof ApiRequestError && error.type === "unauthorized") invalidateActiveSession(); }}
              onReviewed={reviewed => { resetAnalysisForReportChange(false); setUploadResult(current => current?.id === uploadResult.id ? { ...current, ...reviewed } : current);
                setAnalysisState({ status: reviewed.analysisPreparation.available ? "ready" : "unavailable" }); }} />}
            {!uploadResult.extractionToken && uploadResult.analysisPreparation.reasons.some(reason => reason.code === "VEHICLE_DATA_MISSING") && (
              <VehicleConfirmation key={uploadResult.id} result={uploadResult} apiClient={apiClient} disabled={isLoggingOut || status === "uploading"}
                onSessionInvalid={invalidateActiveSession}
                onConfirmed={confirmed => {
                  setUploadResult(current => current?.id === uploadResult.id ? { ...current, ...confirmed } : current);
                  setAnalysisState({ status: confirmed.analysisPreparation.available ? "ready" : "unavailable" });
                }} />
            )}
            {!isConfirmedZeroDtc(uploadResult.extraction) && <AiAnalysisSection
              preparation={reviewEditing ? { available: false, reasons: [{ code: "MANUAL_REVIEW_REQUIRED", message: "Valida o cancela las correcciones antes de solicitar orientación." }], warnings: [], counts: uploadResult.analysisPreparation.counts } : uploadResult.analysisPreparation}
              state={analysisState}
              onRequestConfirmation={requestAnalysisConfirmation}
              onCancelConfirmation={cancelAnalysisConfirmation}
              onConfirm={() => void confirmAnalysis()}
              observationsProvided={normalizedObservations.length > 0}
              observationsChanged={observationsChanged}
              pdfStatus={pdfStatus}
              pdfMessage={pdfMessage}
              onDownloadPdf={() => void handleDownloadPdf()}
            />}
          </>
        )}

        {!uploadResult && analysisState.status === "cancelled" && (
          <div className="analysis-cancelled" role="status">{analysisState.message}</div>
        )}

        <div className="privacy-note">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 10V7a6 6 0 0 1 12 0v3M5 10h14v11H5z" /><path d="M12 14v3" /></svg>
          <p><strong>Tu archivo se procesa de forma temporal</strong><span>El PDF no se almacena ni se envía. Tras el análisis se intenta guardar únicamente un historial técnico estructurado y sanitizado.</span></p>
        </div>
      </section>
      ) : (
        <section className="upload-card history-card" aria-labelledby="history-title">
          <div className="intro">
            <span className="eyebrow">HISTORIAL SEGURO</span>
            <h1 id="history-title">Diagnósticos anteriores</h1>
            <p>Consulta únicamente los diagnósticos asociados a tu sesión.</p>
          </div>

          <HistoryAnalyticsExport apiClient={apiClient} onFailure={handleApiFailure} />

          {historyDetailStatus === "loading" && (
            <div className="history-state" role="status"><span className="analysis-spinner" aria-hidden="true" /> Cargando diagnóstico…</div>
          )}
          {historyDetailStatus === "error" && (
            <div className="history-state history-error" role="alert">
              <p>{historyDetailMessage}</p>
              {historyDetailRequestIdRef.current && (
                <button type="button" onClick={() => void openHistory(historyDetailRequestIdRef.current!)}>Reintentar</button>
              )}
              <button type="button" onClick={() => setHistoryDetailStatus("idle")}>Volver al historial</button>
            </div>
          )}
          {historyDetailStatus === "ready" && historyDetail ? (
            <div className="history-detail">
              <button className="text-button history-back" type="button" onClick={() => {
                setHistoryDetail(null);
                setHistoryDetailStatus("idle");
                setHistoryDetailMessage("");
                setHistoryPdfStatus("idle");
                setHistoryPdfMessage("");
              }}>← Volver al historial</button>
              <div className="history-detail-heading">
                <div>
                  <h2>{historyDetail.vehicle.make} {historyDetail.vehicle.model}</h2>
                  <p>{new Date(historyDetail.createdAt).toLocaleString("es-GT")} · Año {historyDetail.vehicle.year}</p>
                </div>
                <span className={`rag-history-status ${historyDetail.ragStatus}`}>RAG: {historyDetail.ragStatus}</span>
              </div>
              <HistoryAutomation key={historyDetail.id} historyId={historyDetail.id} apiClient={apiClient} />
              {historyDetail.odometer && <p className="history-odometer">Odómetro: {historyDetail.odometer.value.toLocaleString("es-GT")} {historyDetail.odometer.unit}</p>}
              <ExtractionResults extraction={historyDetail.snapshot.extraction} counts={historyDetail.snapshot.analysis.counts} />
              <section className="analysis-panel completed" aria-labelledby="history-analysis-title">
                <div className="analysis-heading">
                  <div><span className="analysis-icon" aria-hidden="true">IA</span><div><h2 id="history-analysis-title">Orientación guardada</h2><p>No se realizó un nuevo análisis al abrir este registro.</p></div></div>
                </div>
                <AnalysisResult analysis={historyDetail.snapshot.analysis.output} rag={historyDetail.snapshot.rag} />
                <div className="pdf-download" aria-live="polite">
                  <button className="pdf-download-button" type="button" disabled={historyPdfStatus === "generating"} onClick={() => void downloadHistoryPdf()}>
                    {historyPdfStatus === "generating" ? "Generando informe…" : "Descargar informe PDF"}
                  </button>
                  {historyPdfMessage && <p className={historyPdfStatus === "error" ? "pdf-error" : "pdf-success"} role={historyPdfStatus === "error" ? "alert" : "status"}>{historyPdfMessage}</p>}
                </div>
              </section>
            </div>
          ) : historyDetailStatus === "idle" ? (
            <div className="history-list-region">
              {historyState.status === "loading" && historyState.items.length === 0 && (
                <div className="history-state" role="status"><span className="analysis-spinner" aria-hidden="true" /> Cargando historial…</div>
              )}
              {historyState.status === "empty" && <p className="history-state" role="status">Todavía no hay diagnósticos guardados.</p>}
              {historyState.status === "error" && (
                <div className="history-state history-error" role="alert">
                  <p>{historyState.message}</p>
                  <button type="button" onClick={() => void loadHistory(false)}>Reintentar</button>
                </div>
              )}
              {historyState.items.length > 0 && (
                <ul className="history-list">
                  {historyState.items.map((item) => (
                    <li key={item.id}>
                      <button type="button" onClick={() => void openHistory(item.id)} aria-label={`Abrir diagnóstico de ${item.vehicle.make} ${item.vehicle.model}`}>
                        <span className="history-list-main"><strong>{item.vehicle.make} {item.vehicle.model}</strong><small>{new Date(item.createdAt).toLocaleString("es-GT")} · Año {item.vehicle.year}</small></span>
                        <span className="history-list-meta">
                          {item.odometer && <span>{item.odometer.value.toLocaleString("es-GT")} {item.odometer.unit}</span>}
                          <span>{item.dtcCount} DTC</span>
                          <span>RAG: {item.ragStatus}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {historyState.nextCursor && (
                <button className="history-load-more" type="button" disabled={historyState.status === "loading"} onClick={() => void loadHistory(true)}>
                  {historyState.status === "loading" ? "Cargando…" : "Cargar más"}
                </button>
              )}
            </div>
          ) : null}
        </section>
      )}

      <footer>AutoDiag IA · Recepción segura de reportes</footer>
    </main>
  );
}

interface LoginScreenProps {
  authService: BrowserAuthenticationService;
  configurationUnavailable: boolean;
  initialMessage: string;
  onAuthenticated: (identity: AuthIdentity) => void;
  onValidationPending: () => void;
  onLoginActivity: (active: boolean) => void;
}

function LoginScreen({
  authService,
  configurationUnavailable,
  initialMessage,
  onAuthenticated,
  onValidationPending,
  onLoginActivity,
}: LoginScreenProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState(initialMessage);
  const submittingRef = useRef(false);
  const activeControllerRef = useRef<AbortController | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (errorMessage) errorRef.current?.focus();
  }, [errorMessage]);

  useEffect(() => () => {
    activeControllerRef.current?.abort();
    activeControllerRef.current = null;
    submittingRef.current = false;
    onLoginActivity(false);
  }, [onLoginActivity]);

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submittingRef.current || configurationUnavailable) return;

    submittingRef.current = true;
    setIsSubmitting(true);
    setErrorMessage("");
    onLoginActivity(true);
    const controller = new AbortController();
    activeControllerRef.current = controller;

    try {
      const identity = await authService.login(username, password, controller.signal);
      if (activeControllerRef.current !== controller) return;
      onAuthenticated(identity);
    } catch (error) {
      if (activeControllerRef.current !== controller) return;
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (
        error instanceof BrowserAuthenticationError
        && error.code === "AUTH_PROVIDER_UNAVAILABLE"
        && error.sessionEstablished
      ) {
        onValidationPending();
        return;
      }
      setPassword("");
      setErrorMessage(
        error instanceof BrowserAuthenticationError
          ? error.message
          : "No fue posible iniciar sesión. Intenta nuevamente.",
      );
    } finally {
      if (activeControllerRef.current === controller) {
        activeControllerRef.current = null;
        submittingRef.current = false;
        setIsSubmitting(false);
        onLoginActivity(false);
      }
    }
  }

  return (
    <main className="auth-shell">
      <section className="login-card" aria-labelledby="login-title">
        <img className="login-logo" src={autodiagLogoUrl} alt="AutoDiag IA" width="2172" height="724" />
        <div className="login-heading">
          <span className="eyebrow">ACCESO PRIVADO</span>
          <h1 id="login-title">Bienvenido a AutoDiag IA</h1>
          <p>Inicia sesión para analizar reportes de diagnóstico de forma segura.</p>
        </div>

        {errorMessage && (
          <div ref={errorRef} className="login-error" role="alert" aria-live="assertive" tabIndex={-1}>
            {errorMessage}
          </div>
        )}

        <form className="login-form" onSubmit={handleLogin}>
          <label htmlFor="login-username">Usuario</label>
          <input
            id="login-username"
            name="username"
            type="text"
            autoComplete="username"
            value={username}
            placeholder="Ej. usuario.apellido"
            disabled={isSubmitting || configurationUnavailable}
            required
            onChange={(event) => setUsername(event.currentTarget.value)}
          />

          <label htmlFor="login-password">Contraseña</label>
          <div className="password-field">
            <input
              id="login-password"
              name="password"
              type={showPassword ? "text" : "password"}
              autoComplete="current-password"
              value={password}
              placeholder="Ingresa tu contraseña"
              disabled={isSubmitting || configurationUnavailable}
              required
              onChange={(event) => setPassword(event.currentTarget.value)}
            />
            <button
              type="button"
              className="password-toggle"
              aria-label={showPassword ? "Ocultar contraseña" : "Mostrar contraseña"}
              aria-pressed={showPassword}
              disabled={isSubmitting || configurationUnavailable}
              onClick={() => setShowPassword((visible) => !visible)}
            >
              {showPassword ? "Ocultar" : "Mostrar"}
            </button>
          </div>

          <button className="login-button" type="submit" disabled={isSubmitting || configurationUnavailable}>
            {isSubmitting ? "Iniciando sesión..." : "Iniciar sesión"}
          </button>
        </form>
      </section>
    </main>
  );
}

type AuthViewState =
  | { status: "checking" }
  | { status: "unauthenticated"; message: string; configurationUnavailable: boolean }
  | { status: "authenticated"; identity: AuthIdentity };

interface AppProps {
  authService?: BrowserAuthenticationService;
  apiClient?: BrowserApiClient;
}

export function App({ authService = browserAuthenticationService, apiClient }: AppProps) {
  const resolvedApiClient = useMemo(
    () => apiClient ?? createBrowserApiClient(authService),
    [apiClient, authService],
  );
  const [authState, setAuthState] = useState<AuthViewState>({ status: "checking" });
  const [connectivityStatus, setConnectivityStatus] = useState<ConnectivityStatus>("checking");
  const [connectionRestored, setConnectionRestored] = useState(false);
  const [authRetrySequence, setAuthRetrySequence] = useState(0);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const [neutralHealthInProgress, setNeutralHealthInProgress] = useState(false);
  const identityRef = useRef<AuthIdentity | null>(null);
  const loginInProgressRef = useRef(false);
  const authValidationSequenceRef = useRef(0);
  const authValidationControllerRef = useRef<AbortController | null>(null);
  const invalidationInProgressRef = useRef(false);
  const connectivityStatusRef = useRef<ConnectivityStatus>("checking");
  const authStatusRef = useRef<AuthViewState["status"]>("checking");
  const authenticationGenerationRef = useRef(0);
  const neutralHealthSequenceRef = useRef(0);
  const neutralHealthControllerRef = useRef<AbortController | null>(null);
  const appMountedRef = useRef(true);

  const markConnectivityUnavailable = useCallback(() => {
    connectivityStatusRef.current = "unavailable";
    setConnectionRestored(false);
    setConnectivityStatus("unavailable");
  }, []);

  const markConnectivityChecking = useCallback(() => {
    connectivityStatusRef.current = "checking";
    setConnectionRestored(false);
    setConnectivityStatus("checking");
  }, []);

  const markConnectivityConnected = useCallback(() => {
    const wasUnavailable = connectivityStatusRef.current === "unavailable";
    connectivityStatusRef.current = "connected";
    setConnectionRestored(wasUnavailable);
    setConnectivityStatus("connected");
  }, []);

  const invalidateNeutralHealth = useCallback(() => {
    neutralHealthSequenceRef.current += 1;
    const controller = neutralHealthControllerRef.current;
    neutralHealthControllerRef.current = null;
    controller?.abort();
    if (appMountedRef.current) setNeutralHealthInProgress(false);
  }, []);

  const advanceAuthenticationGeneration = useCallback(() => {
    authenticationGenerationRef.current += 1;
    invalidateNeutralHealth();
  }, [invalidateNeutralHealth]);

  const updateAuthState = useCallback((nextState: AuthViewState) => {
    authStatusRef.current = nextState.status;
    setAuthState(nextState);
  }, []);

  const invalidateAuthenticationValidation = useCallback(() => {
    authValidationSequenceRef.current += 1;
    const controller = authValidationControllerRef.current;
    authValidationControllerRef.current = null;
    controller?.abort();
    return authValidationSequenceRef.current;
  }, []);

  useEffect(() => {
    appMountedRef.current = true;
    return () => {
      appMountedRef.current = false;
      neutralHealthSequenceRef.current += 1;
      neutralHealthControllerRef.current?.abort();
      neutralHealthControllerRef.current = null;
    };
  }, []);

  useEffect(() => {
    let mounted = true;

    const showUnauthenticated = (message = "", configurationUnavailable = false) => {
      if (!mounted) return;
      advanceAuthenticationGeneration();
      identityRef.current = null;
      updateAuthState({ status: "unauthenticated", message, configurationUnavailable });
    };

    const applyIdentity = (identity: AuthIdentity) => {
      if (!mounted) return;
      advanceAuthenticationGeneration();
      identityRef.current = identity;
      setLogoutError("");
      updateAuthState({ status: "authenticated", identity });
      markConnectivityConnected();
    };

    const handleAuthenticationError = (error: unknown) => {
      if (!mounted || (error instanceof DOMException && error.name === "AbortError")) return;
      invalidateAuthenticationValidation();
      if (error instanceof BrowserAuthenticationError) {
        if (error.code === "AUTH_SESSION_INVALID") {
          void authService.signOutLocal().catch(() => undefined);
          showUnauthenticated(error.message);
          return;
        }
        if (error.code === "AUTH_CONFIGURATION_UNAVAILABLE") {
          showUnauthenticated(error.message, true);
          return;
        }
        markConnectivityUnavailable();
        return;
      }
      markConnectivityUnavailable();
    };

    const validateCurrentSession = () => {
      const validationId = invalidateAuthenticationValidation();
      const controller = new AbortController();
      authValidationControllerRef.current = controller;
      void authService.validateCurrentSession(controller.signal).then((identity) => {
        if (!mounted || validationId !== authValidationSequenceRef.current) return;
        if (identity) applyIdentity(identity);
        else {
          invalidateAuthenticationValidation();
          markConnectivityConnected();
          showUnauthenticated();
        }
      }).catch((error: unknown) => {
        if (!mounted || validationId !== authValidationSequenceRef.current) return;
        handleAuthenticationError(error);
      }).finally(() => {
        if (validationId === authValidationSequenceRef.current && authValidationControllerRef.current === controller) {
          authValidationControllerRef.current = null;
        }
      });
    };

    let unsubscribe: () => void = () => undefined;
    let subscriptionReady = true;
    try {
      unsubscribe = authService.subscribe((event, eventUserId) => {
        if (event === "INITIAL_SESSION" || event === "PASSWORD_RECOVERY") return;
        if (event === "SIGNED_OUT") {
          invalidateAuthenticationValidation();
          markConnectivityConnected();
          showUnauthenticated();
          return;
        }
        if (event === "SIGNED_IN" && loginInProgressRef.current) return;
        const currentIdentity = identityRef.current;
        const mustValidateWithoutExposingCurrentWorkspace = event === "SIGNED_IN"
          ? eventUserId === null || eventUserId === undefined || currentIdentity?.id !== eventUserId
          : event === "TOKEN_REFRESHED"
            && eventUserId !== null
            && eventUserId !== undefined
            && currentIdentity?.id !== eventUserId;
        if (mustValidateWithoutExposingCurrentWorkspace) {
          invalidateAuthenticationValidation();
          advanceAuthenticationGeneration();
          identityRef.current = null;
          markConnectivityChecking();
          updateAuthState({ status: "checking" });
        }
        validateCurrentSession();
      });
    } catch (error) {
      subscriptionReady = false;
      handleAuthenticationError(error);
    }

    if (subscriptionReady) {
      const initializationId = invalidateAuthenticationValidation();
      const initialController = new AbortController();
      authValidationControllerRef.current = initialController;
      void authService.initialize(initialController.signal).then((identity) => {
        if (!mounted || initializationId !== authValidationSequenceRef.current) return;
        if (identity) applyIdentity(identity);
        else {
          invalidateAuthenticationValidation();
          showUnauthenticated();
        }
      }).catch((error: unknown) => {
        if (!mounted || initializationId !== authValidationSequenceRef.current) return;
        handleAuthenticationError(error);
      }).finally(() => {
        if (
          initializationId === authValidationSequenceRef.current &&
          authValidationControllerRef.current === initialController
        ) {
          authValidationControllerRef.current = null;
        }
      });
    }

    return () => {
      mounted = false;
      invalidateAuthenticationValidation();
      unsubscribe();
    };
  }, [advanceAuthenticationGeneration, authRetrySequence, authService, invalidateAuthenticationValidation, markConnectivityChecking, markConnectivityConnected, markConnectivityUnavailable, updateAuthState]);

  async function retryInitialConnectivity() {
    if (
      neutralHealthControllerRef.current
      || authStatusRef.current !== "checking"
      || connectivityStatusRef.current !== "unavailable"
    ) return;
    const controller = new AbortController();
    const requestSequence = ++neutralHealthSequenceRef.current;
    const authenticationGeneration = authenticationGenerationRef.current;
    const expectedIdentity = identityRef.current?.id ?? null;
    neutralHealthControllerRef.current = controller;
    setNeutralHealthInProgress(true);
    const isCurrentRequest = () => (
      appMountedRef.current
      && neutralHealthControllerRef.current === controller
      && neutralHealthSequenceRef.current === requestSequence
      && authenticationGenerationRef.current === authenticationGeneration
      && (identityRef.current?.id ?? null) === expectedIdentity
      && authStatusRef.current === "checking"
      && !controller.signal.aborted
    );
    try {
      await resolvedApiClient.checkHealth(controller.signal);
      if (!isCurrentRequest()) return;
      markConnectivityConnected();
      setAuthRetrySequence((current) => current + 1);
    } catch {
      if (!isCurrentRequest()) return;
      markConnectivityUnavailable();
    } finally {
      if (neutralHealthControllerRef.current === controller) {
        neutralHealthControllerRef.current = null;
        if (appMountedRef.current) setNeutralHealthInProgress(false);
      }
    }
  }

  function handleAuthenticated(identity: AuthIdentity) {
    invalidateAuthenticationValidation();
    advanceAuthenticationGeneration();
    identityRef.current = identity;
    setLogoutError("");
    markConnectivityConnected();
    updateAuthState({ status: "authenticated", identity });
  }

  function handleValidationPending() {
    invalidateAuthenticationValidation();
    advanceAuthenticationGeneration();
    identityRef.current = null;
    markConnectivityUnavailable();
    updateAuthState({ status: "checking" });
  }

  function handleInvalidSession() {
    if (invalidationInProgressRef.current) return;
    invalidationInProgressRef.current = true;
    invalidateAuthenticationValidation();
    advanceAuthenticationGeneration();
    identityRef.current = null;
    updateAuthState({
      status: "unauthenticated",
      message: "Tu sesión ya no es válida. Inicia sesión nuevamente.",
      configurationUnavailable: false,
    });
    void authService.signOutLocal().catch(() => undefined).finally(() => {
      invalidationInProgressRef.current = false;
    });
  }

  async function handleLogout() {
    if (isLoggingOut) return;
    const previousIdentity = identityRef.current;
    setIsLoggingOut(true);
    setLogoutError("");
    invalidateAuthenticationValidation();
    advanceAuthenticationGeneration();
    identityRef.current = null;
    markConnectivityChecking();
    updateAuthState({ status: "checking" });
    try {
      await authService.signOutLocal();
      markConnectivityConnected();
      updateAuthState({ status: "unauthenticated", message: "", configurationUnavailable: false });
    } catch {
      markConnectivityConnected();
      if (previousIdentity) {
        identityRef.current = previousIdentity;
        updateAuthState({ status: "authenticated", identity: previousIdentity });
        setLogoutError("No fue posible cerrar la sesión. Intenta nuevamente.");
      } else {
        updateAuthState({ status: "unauthenticated", message: "", configurationUnavailable: false });
      }
    } finally {
      setIsLoggingOut(false);
    }
  }

  if (authState.status === "checking") {
    return (
      <main className="auth-shell">
        <section className="login-card auth-checking" role="status" aria-live="polite">
          <img className="login-logo" src={autodiagLogoUrl} alt="AutoDiag IA" width="2172" height="724" />
          {connectivityStatus === "unavailable" ? (
            <>
              <h1>Servidor temporalmente no disponible</h1>
              <p>{API_UNAVAILABLE_MESSAGE}</p>
              <button
                className="login-button"
                type="button"
                disabled={neutralHealthInProgress}
                onClick={() => void retryInitialConnectivity()}
              >
                {neutralHealthInProgress ? "Comprobando conexión…" : "Comprobar conexión"}
              </button>
            </>
          ) : (
            <>
              <span className="analysis-spinner" aria-hidden="true" />
              <p>Verificando sesión segura…</p>
            </>
          )}
        </section>
      </main>
    );
  }

  if (authState.status === "unauthenticated") {
    return (
      <LoginScreen
        key={`${authState.configurationUnavailable}:${authState.message}`}
        authService={authService}
        configurationUnavailable={authState.configurationUnavailable}
        initialMessage={authState.message}
        onAuthenticated={handleAuthenticated}
        onValidationPending={handleValidationPending}
        onLoginActivity={(active) => { loginInProgressRef.current = active; }}
      />
    );
  }

  return (
    <ReportWorkspace
      key={authState.identity.id}
      apiClient={resolvedApiClient}
      identity={authState.identity}
      connectivityStatus={connectivityStatus}
      connectionRestored={connectionRestored}
      isLoggingOut={isLoggingOut}
      logoutError={logoutError}
      onLogout={() => void handleLogout()}
      onSessionInvalid={handleInvalidSession}
      onConnectivityChecking={markConnectivityChecking}
      onConnectivityUnavailable={markConnectivityUnavailable}
      onConnectivityConnected={markConnectivityConnected}
    />
  );
}
