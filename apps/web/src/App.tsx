import { type ChangeEvent, type DragEvent, type FormEvent, useEffect, useRef, useState } from "react";
import autodiagLogoUrl from "./assets/autodiag-ia-logo.png";
import { buildReportExportModel, downloadReportPdf } from "./report-pdf";

const PDF_MIME_TYPE = "application/pdf";
const MAX_VEHICLE_OBSERVATIONS_LENGTH = 1_000;

type UploadStatus = "idle" | "uploading" | "success" | "error";
type AnalysisStatus = "unavailable" | "ready" | "confirming" | "analyzing" | "completed" | "error" | "cancelled";
type PdfStatus = "idle" | "generating" | "success" | "error";

type DtcStatus =
  | "current"
  | "confirmed"
  | "stored"
  | "pending"
  | "permanent"
  | "intermittent"
  | "history"
  | "unknown";
type ActionableDtcStatus = Exclude<DtcStatus, "history" | "unknown">;
type DtcClassification = "actionable" | "historical" | "unknown";

interface ExtractionResult {
  status: "completed" | "partial";
  format: "autel_vehicle_diagnostic_report";
  requiresManualReview: boolean;
  vehicle: {
    year: number | null;
    make: string | null;
    model: string | null;
    engine: string | null;
    odometer: { value: number; unit: "km" | "mi" } | null;
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
    dtcs: Array<{ code: string; description: string; status: ActionableDtcStatus; alsoHistorical: boolean }>;
  }>;
  observations?: string;
}

interface AnalysisCounts {
  detected: number;
  actionable: number;
  historical: number;
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
  analysis: DiagnosticAnalysis;
}

interface AnalysisUiState {
  status: AnalysisStatus;
  analysis?: DiagnosticAnalysis;
  message?: string;
  submittedObservations?: string;
}

interface UploadResponse {
  id: string;
  originalName: string;
  size: number;
  sha256: string;
  type: string;
  status: "received";
  extraction: ExtractionResult;
  analysisPreparation: AnalysisPreparation;
}

interface ErrorResponse {
  error?: {
    code?: string;
    message?: string;
  };
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
    candidate.observationCorrelation.matches.length <= 20 &&
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

function parseAnalysisResponse(value: unknown): AnalysisResponse | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<AnalysisResponse>;
  if (candidate.status !== "completed" || !isDiagnosticAnalysis(candidate.analysis)) return null;
  return { status: candidate.status, analysis: candidate.analysis };
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
};

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
          {vehicle.vinMasked && <div><dt>VIN protegido</dt><dd>{vehicle.vinMasked}</dd></div>}
        </dl>
      </div>

      <div className="scan-totals" aria-label="Resumen del escaneo">
        <div><strong>{extraction.scanSummary.parsedSystems}</strong><span>Sistemas escaneados</span></div>
        <div><strong>{counts.detected}</strong><span>DTC detectados</span></div>
        <div><strong>{counts.actionable}</strong><span>DTC para análisis</span></div>
        <div><strong>{counts.historical}</strong><span>Registros históricos</span></div>
      </div>

      {extraction.warnings.length > 0 && (
        <div className="warnings-panel">
          <h3>Advertencias de extracción</h3>
          <ul>{extraction.warnings.map((warning) => <li key={warning.code}>{warning.message}</li>)}</ul>
        </div>
      )}

      <div className="dtc-section">
        <h3>DTC reportados</h3>
        {extraction.dtcs.length === 0 ? (
          <p className="empty-dtc">No se reportaron DTC en este escaneo</p>
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
                    <td>{dtc.statusOriginal ?? "No indicado"}</td>
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

function AnalysisResult({ analysis }: { analysis: DiagnosticAnalysis }) {
  return (
    <div className="analysis-result">
      <div className="analysis-summary">
        <h3>Resumen técnico</h3>
        <p>{analysis.technicalSummary}</p>
        <span>Confianza general: <strong>{CONFIDENCE_LABELS[analysis.confidence]}</strong></span>
      </div>

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
  return value.trim();
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
              <p className="data-exclusion"><strong>No se enviarán</strong> VIN, PDF, odómetro ni datos del cliente.</p>
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
              <button className="analysis-button" type="button" onClick={onRequestConfirmation}>Intentar de nuevo</button>
            </div>
          )}

          {state.status === "completed" && state.analysis && (
            <>
              <AnalysisResult analysis={state.analysis} />
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

export function App() {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [status, setStatus] = useState<UploadStatus>("idle");
  const [message, setMessage] = useState("");
  const [uploadResult, setUploadResult] = useState<UploadResponse | null>(null);
  const [analysisState, setAnalysisState] = useState<AnalysisUiState>({ status: "unavailable" });
  const [observations, setObservations] = useState("");
  const [observationsError, setObservationsError] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [pdfStatus, setPdfStatus] = useState<PdfStatus>("idle");
  const [pdfMessage, setPdfMessage] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const logoRef = useRef<HTMLImageElement>(null);
  const uploadInProgressRef = useRef(false);
  const uploadSequenceRef = useRef(0);
  const activeUploadRef = useRef<{ id: number; file: File; controller: AbortController } | null>(null);
  const analysisInProgressRef = useRef(false);
  const analysisSequenceRef = useRef(0);
  const activeAnalysisRef = useRef<{ id: number; reportId: string; controller: AbortController } | null>(null);
  const pdfGenerationInProgressRef = useRef(false);
  const pdfSequenceRef = useRef(0);
  const activePdfGenerationRef = useRef<{ id: number; reportId: string } | null>(null);

  useEffect(() => () => {
    uploadSequenceRef.current += 1;
    analysisSequenceRef.current += 1;
    pdfSequenceRef.current += 1;
    activeUploadRef.current?.controller.abort();
    activeAnalysisRef.current?.controller.abort();
    activeUploadRef.current = null;
    activeAnalysisRef.current = null;
    uploadInProgressRef.current = false;
    analysisInProgressRef.current = false;
    pdfGenerationInProgressRef.current = false;
    activePdfGenerationRef.current = null;
  }, []);

  function resetPdfGeneration() {
    pdfSequenceRef.current += 1;
    activePdfGenerationRef.current = null;
    pdfGenerationInProgressRef.current = false;
    setPdfStatus("idle");
    setPdfMessage("");
  }

  function resetAnalysisForReportChange(showCancellation: boolean) {
    resetPdfGeneration();
    analysisSequenceRef.current += 1;
    activeAnalysisRef.current?.controller.abort();
    activeAnalysisRef.current = null;
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

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
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
    resetAnalysisForReportChange(uploadResult !== null || activeAnalysisRef.current !== null);
    setUploadResult(null);

    const formData = new FormData();
    formData.append("report", fileBeingUploaded);

    try {
      const response = await fetch("/api/reports/upload", {
        method: "POST",
        body: formData,
        signal: controller.signal,
      });
      let body: UploadResponse | ErrorResponse;

      try {
        body = (await response.json()) as UploadResponse | ErrorResponse;
      } catch {
        throw new Error("El servidor devolvió una respuesta inválida.");
      }

      if (!isActiveUpload()) return;

      if (!response.ok) {
        const errorBody = body as ErrorResponse;
        throw new Error(errorBody.error?.message ?? "No fue posible enviar el reporte.");
      }

      const result = body as UploadResponse;
      setUploadResult(result);
      setAnalysisState({ status: result.analysisPreparation.available ? "ready" : "unavailable" });
      setStatus("success");
      setMessage("Reporte recibido correctamente.");
    } catch (error) {
      if (!isActiveUpload()) return;

      setStatus("error");
      setMessage(
        error instanceof TypeError
          ? "No fue posible conectar con el servidor. Inténtalo de nuevo."
          : error instanceof Error
            ? error.message
            : "No fue posible enviar el reporte.",
      );
    } finally {
      if (isActiveUpload()) {
        activeUploadRef.current = null;
        uploadInProgressRef.current = false;
      }
    }
  }

  function requestAnalysisConfirmation() {
    if (!uploadResult?.analysisPreparation.available || analysisInProgressRef.current) return;
    setAnalysisState((current) => ({
      status: "confirming",
      ...(current.analysis ? { analysis: current.analysis } : {}),
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
          submittedObservations: current.submittedObservations ?? "",
        }
      : { status: "ready" });
  }

  async function confirmAnalysis() {
    const preparation = uploadResult?.analysisPreparation;
    if (!uploadResult || !preparation?.available || analysisInProgressRef.current) return;
    const normalizedObservations = normalizeObservations(observations);
    const requestInput: DiagnosticAnalysisInput = {
      ...preparation.input,
      ...(normalizedObservations.length === 0 ? {} : { observations: normalizedObservations }),
    };

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

    setAnalysisState({ status: "analyzing" });

    try {
      const response = await fetch("/api/reports/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestInput),
        signal: controller.signal,
      });

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        if (isActiveAnalysis()) {
          setAnalysisState({ status: "error", message: AI_ERROR_MESSAGES.OPENAI_RESPONSE_INVALID });
        }
        return;
      }

      if (!isActiveAnalysis()) return;

      if (!response.ok) {
        const errorBody = body as ErrorResponse;
        setAnalysisState({ status: "error", message: getAiErrorMessage(errorBody.error?.code) });
        return;
      }

      const result = parseAnalysisResponse(body);
      const inputDtcIdentities = new Set(
        requestInput.modules.flatMap((module) =>
          module.dtcs.map((dtc) => dtcIdentity({ code: dtc.code, moduleCode: module.code, moduleName: module.name })),
        ),
      );
      const relatedIdentities = result?.analysis.findings.flatMap((finding) =>
        finding.relatedDtc === null ? [] : [dtcIdentity(finding.relatedDtc)],
      ) ?? [];
      const correlationIdentities = result?.analysis.observationCorrelation.matches.map((match) =>
        dtcIdentity(match.relatedDtc)
      ) ?? [];
      const correlationStatusIsInvalid = normalizedObservations.length === 0
        ? result?.analysis.observationCorrelation.status !== "not_provided"
        : result?.analysis.observationCorrelation.status === "not_provided";
      const hasInvalidDtcReference = relatedIdentities.some((identity) => !inputDtcIdentities.has(identity))
        || new Set(relatedIdentities).size !== relatedIdentities.length
        || correlationIdentities.some((identity) => !inputDtcIdentities.has(identity))
        || new Set(correlationIdentities).size !== correlationIdentities.length;
      if (!result || hasInvalidDtcReference || correlationStatusIsInvalid) {
        setAnalysisState({ status: "error", message: AI_ERROR_MESSAGES.OPENAI_RESPONSE_INVALID });
        return;
      }

      setAnalysisState({
        status: "completed",
        analysis: result.analysis,
        submittedObservations: normalizedObservations,
      });
    } catch (error) {
      if (!isActiveAnalysis()) return;
      if (error instanceof DOMException && error.name === "AbortError") return;
      setAnalysisState({
        status: "error",
        message: error instanceof TypeError
          ? "No fue posible conectar con el servicio de orientación por IA."
          : "No fue posible obtener la orientación por IA.",
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
    const submittedObservations = analysisState.submittedObservations;
    if (
      pdfGenerationInProgressRef.current ||
      analysisState.status !== "completed" ||
      !analysis ||
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
        vehicle: {
          make: uploadResult.extraction.vehicle.make,
          model: uploadResult.extraction.vehicle.model,
          year: uploadResult.extraction.vehicle.year,
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

  const normalizedObservations = normalizeObservations(observations);
  const observationsChanged = analysisState.status === "completed"
    && analysisState.submittedObservations !== undefined
    && analysisState.submittedObservations !== normalizedObservations;
  const observationsDisabled = status === "uploading" || analysisState.status === "analyzing";

  return (
    <main className="app-shell">
      <header className="brand">
        <img ref={logoRef} className="brand-logo" src={autodiagLogoUrl} alt="AutoDiag IA" width="2172" height="724" />
      </header>

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
                  {uploadResult && <small>Referencia: {uploadResult.id}</small>}
                </div>
              </div>
            )}
          </div>

          <button className="submit-button" type="submit" disabled={!selectedFile || status === "uploading"}>
            {status === "uploading" ? <span className="spinner" aria-hidden="true" /> : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4m0 0L7 9m5-5 5 5M5 15v4h14v-4" /></svg>}
            {status === "uploading" ? "Enviando…" : "Enviar reporte"}
          </button>
        </form>

        {uploadResult && (
          <>
            <ExtractionResults
              extraction={uploadResult.extraction}
              counts={uploadResult.analysisPreparation.counts}
            />
            <AiAnalysisSection
              preparation={uploadResult.analysisPreparation}
              state={analysisState}
              onRequestConfirmation={requestAnalysisConfirmation}
              onCancelConfirmation={cancelAnalysisConfirmation}
              onConfirm={() => void confirmAnalysis()}
              observationsProvided={normalizedObservations.length > 0}
              observationsChanged={observationsChanged}
              pdfStatus={pdfStatus}
              pdfMessage={pdfMessage}
              onDownloadPdf={() => void handleDownloadPdf()}
            />
          </>
        )}

        {!uploadResult && analysisState.status === "cancelled" && (
          <div className="analysis-cancelled" role="status">{analysisState.message}</div>
        )}

        <div className="privacy-note">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 10V7a6 6 0 0 1 12 0v3M5 10h14v11H5z" /><path d="M12 14v3" /></svg>
          <p><strong>Tu archivo se procesa de forma temporal</strong><span>No lo almacenamos ni compartimos con servicios externos.</span></p>
        </div>
      </section>

      <footer>AutoDiag IA · Recepción segura de reportes</footer>
    </main>
  );
}
