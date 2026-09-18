import { jsPDF } from "jspdf";

export type ReportPriority = "critical" | "high" | "medium" | "low";
export type ReportConfidence = "high" | "medium" | "low";
export type ReportCorrelationStatus = "not_provided" | "no_clear_match" | "matches_found";

export interface ReportDtcReference {
  code: string;
  moduleCode: string | null;
  moduleName: string;
}

export interface ReportExportSource {
  vehicle: { make: string | null; model: string | null; year: number | null };
  counts: { systems: number; detected: number; actionable: number; historical: number };
  actionableModules: Array<{
    code: string | null;
    name: string;
    dtcs: Array<{ code: string; description: string; status: string; alsoHistorical: boolean }>;
  }>;
  documentaryDtcs: Array<{
    code: string;
    moduleCode: string | null;
    moduleName: string;
    description: string;
    originalStatus: string | null;
    normalizedClassification: "actionable" | "historical" | "unknown";
  }>;
  analysis: {
    technicalSummary: string;
    findings: Array<{
      relatedDtc: ReportDtcReference | null;
      priority: ReportPriority;
      simpleExplanation: string;
      possibleCauses: string[];
      recommendedChecks: string[];
      safetyWarnings: string[];
      confidence: ReportConfidence;
    }>;
    observationCorrelation: {
      status: ReportCorrelationStatus;
      summary: string;
      matches: Array<{
        relatedDtc: ReportDtcReference;
        observation: string;
        possibleRelation: string;
        confidence: ReportConfidence;
      }>;
    };
    safetyWarnings: string[];
    confidence: ReportConfidence;
    requiresTechnicianConfirmation: true;
  };
  submittedObservations: string;
}

export interface ReportExportDtc extends ReportDtcReference {
  description: string;
  originalStatus: string | null;
  normalizedClassification: "actionable" | "historical";
  alsoHistorical: boolean;
}

export interface ReportExportModel {
  vehicle: { make: string | null; model: string | null; year: number | null };
  summary: {
    systemsScanned: number;
    detectedRows: number;
    actionableDtcs: number;
    historicalRows: number;
    findings: number;
  };
  actionableDtcs: ReportExportDtc[];
  historicalDtcs: ReportExportDtc[];
  analysis: {
    technicalSummary: string;
    findings: Array<{
      relatedDtc: ReportDtcReference | null;
      priority: ReportPriority;
      simpleExplanation: string;
      possibleCauses: string[];
      recommendedChecks: string[];
      safetyWarnings: string[];
      confidence: ReportConfidence;
    }>;
    safetyWarnings: string[];
    confidence: ReportConfidence;
    requiresTechnicianConfirmation: true;
  };
  observations: {
    used: string | null;
    status: ReportCorrelationStatus;
    summary: string;
    matches: Array<{
      relatedDtc: ReportDtcReference;
      observation: string;
      possibleRelation: string;
      confidence: ReportConfidence;
    }>;
  };
}

export class ReportPdfValidationError extends Error {
  constructor() {
    super("No fue posible generar el informe porque los datos no superaron la validación de privacidad.");
    this.name = "ReportPdfValidationError";
  }
}

const PRIORITIES = new Set<ReportPriority>(["critical", "high", "medium", "low"]);
const CONFIDENCES = new Set<ReportConfidence>(["high", "medium", "low"]);
const CORRELATION_STATUSES = new Set<ReportCorrelationStatus>([
  "not_provided",
  "no_clear_match",
  "matches_found",
]);
const SENSITIVE_PATTERNS = [
  /\b[A-HJ-NPR-Z0-9]{17}\b/iu,
  /\b[A-F0-9]{64}\b/iu,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/u,
  /\bsk-[A-Za-z0-9_-]{12,}\b/u,
  /(?:api[_ -]?key|secret|token|password|contraseña|clave)\s*[:=]\s*\S+/iu,
  /\b[A-Za-z]:\\[^\r\n]+/u,
  /\b[^\s/\\]+\.pdf\b/iu,
  /(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]){2,}\d{3,4}\b/u,
];

const NOT_PROVIDED_MESSAGE =
  "No se proporcionaron observaciones adicionales. El análisis se realizó únicamente con los DTC extraídos del reporte.";
const MATCH_CAUTION = "Una coincidencia es orientativa y debe verificarse mediante comprobaciones profesionales.";

function dtcIdentity(value: ReportDtcReference) {
  return JSON.stringify([value.moduleCode, value.moduleName, value.code]);
}

function cloneReference(value: ReportDtcReference): ReportDtcReference {
  return { code: value.code, moduleCode: value.moduleCode, moduleName: value.moduleName };
}

function assertSafeText(value: string | null) {
  if (value !== null && SENSITIVE_PATTERNS.some((pattern) => pattern.test(value))) {
    throw new ReportPdfValidationError();
  }
}

function assertOnlyKeys(value: object, allowed: readonly string[]) {
  const keys = Object.keys(value);
  if (keys.length !== allowed.length || keys.some((key) => !allowed.includes(key))) {
    throw new ReportPdfValidationError();
  }
}

function assertReference(value: ReportDtcReference) {
  assertOnlyKeys(value, ["code", "moduleCode", "moduleName"]);
  if (
    typeof value.code !== "string" || value.code.length === 0 ||
    (value.moduleCode !== null && (typeof value.moduleCode !== "string" || value.moduleCode.length === 0)) ||
    typeof value.moduleName !== "string" || value.moduleName.length === 0
  ) {
    throw new ReportPdfValidationError();
  }
}

function assertStringList(values: string[]) {
  if (!Array.isArray(values) || values.length === 0 || values.some((value) => typeof value !== "string" || value.length === 0)) {
    throw new ReportPdfValidationError();
  }
}

function walkSafeText(value: unknown): void {
  if (typeof value === "string") {
    assertSafeText(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(walkSafeText);
    return;
  }
  if (value !== null && typeof value === "object") Object.values(value).forEach(walkSafeText);
}

export function validateReportExportModel(model: ReportExportModel): void {
  assertOnlyKeys(model, ["vehicle", "summary", "actionableDtcs", "historicalDtcs", "analysis", "observations"]);
  assertOnlyKeys(model.vehicle, ["make", "model", "year"]);
  assertOnlyKeys(model.summary, ["systemsScanned", "detectedRows", "actionableDtcs", "historicalRows", "findings"]);
  assertOnlyKeys(model.analysis, [
    "technicalSummary",
    "findings",
    "safetyWarnings",
    "confidence",
    "requiresTechnicianConfirmation",
  ]);
  assertOnlyKeys(model.observations, ["used", "status", "summary", "matches"]);

  const counts = Object.values(model.summary);
  if (counts.some((count) => !Number.isSafeInteger(count) || count < 0)) throw new ReportPdfValidationError();
  if (model.summary.actionableDtcs !== model.actionableDtcs.length || model.summary.findings !== model.analysis.findings.length) {
    throw new ReportPdfValidationError();
  }
  if (
    (model.vehicle.make !== null && typeof model.vehicle.make !== "string") ||
    (model.vehicle.model !== null && typeof model.vehicle.model !== "string") ||
    (model.vehicle.year !== null && (!Number.isSafeInteger(model.vehicle.year) || model.vehicle.year < 1886))
  ) {
    throw new ReportPdfValidationError();
  }

  const allDtcs = [...model.actionableDtcs, ...model.historicalDtcs];
  allDtcs.forEach((dtc) => {
    assertOnlyKeys(dtc, [
      "code",
      "moduleCode",
      "moduleName",
      "description",
      "originalStatus",
      "normalizedClassification",
      "alsoHistorical",
    ]);
    assertReference({ code: dtc.code, moduleCode: dtc.moduleCode, moduleName: dtc.moduleName });
    if (
      typeof dtc.description !== "string" || dtc.description.length === 0 ||
      (dtc.originalStatus !== null && typeof dtc.originalStatus !== "string") ||
      !["actionable", "historical"].includes(dtc.normalizedClassification) ||
      typeof dtc.alsoHistorical !== "boolean"
    ) {
      throw new ReportPdfValidationError();
    }
  });
  if (
    model.actionableDtcs.some((dtc) => dtc.normalizedClassification !== "actionable") ||
    model.historicalDtcs.some((dtc) => dtc.normalizedClassification !== "historical" || dtc.alsoHistorical)
  ) {
    throw new ReportPdfValidationError();
  }
  const actionableDtcIdentities = model.actionableDtcs.map(dtcIdentity);
  if (new Set(actionableDtcIdentities).size !== actionableDtcIdentities.length) {
    throw new ReportPdfValidationError();
  }

  if (
    typeof model.analysis.technicalSummary !== "string" || model.analysis.technicalSummary.length === 0 ||
    !Array.isArray(model.analysis.findings) || model.analysis.findings.length === 0 ||
    !CONFIDENCES.has(model.analysis.confidence) ||
    model.analysis.requiresTechnicianConfirmation !== true
  ) {
    throw new ReportPdfValidationError();
  }
  assertStringList(model.analysis.safetyWarnings);
  const actionableIdentities = new Set(actionableDtcIdentities);
  const findingIdentities: string[] = [];
  model.analysis.findings.forEach((finding) => {
    assertOnlyKeys(finding, [
      "relatedDtc",
      "priority",
      "simpleExplanation",
      "possibleCauses",
      "recommendedChecks",
      "safetyWarnings",
      "confidence",
    ]);
    if (
      (finding.relatedDtc !== null && !actionableIdentities.has(dtcIdentity(finding.relatedDtc))) ||
      !PRIORITIES.has(finding.priority) ||
      typeof finding.simpleExplanation !== "string" || finding.simpleExplanation.length === 0 ||
      !CONFIDENCES.has(finding.confidence)
    ) {
      throw new ReportPdfValidationError();
    }
    if (finding.relatedDtc !== null) {
      assertReference(finding.relatedDtc);
      findingIdentities.push(dtcIdentity(finding.relatedDtc));
    }
    assertStringList(finding.possibleCauses);
    assertStringList(finding.recommendedChecks);
    assertStringList(finding.safetyWarnings);
  });
  if (new Set(findingIdentities).size !== findingIdentities.length) throw new ReportPdfValidationError();

  if (
    !CORRELATION_STATUSES.has(model.observations.status) ||
    typeof model.observations.summary !== "string" || model.observations.summary.length === 0 ||
    (model.observations.used !== null && (
      typeof model.observations.used !== "string" ||
      model.observations.used.length === 0 ||
      model.observations.used !== model.observations.used.trim()
    ))
  ) {
    throw new ReportPdfValidationError();
  }
  const hasObservations = model.observations.used !== null;
  if (
    (hasObservations && model.observations.status === "not_provided") ||
    (!hasObservations && model.observations.status !== "not_provided") ||
    (model.observations.status === "matches_found" ? model.observations.matches.length === 0 : model.observations.matches.length > 0)
  ) {
    throw new ReportPdfValidationError();
  }
  const matchIdentities: string[] = [];
  model.observations.matches.forEach((match) => {
    assertOnlyKeys(match, ["relatedDtc", "observation", "possibleRelation", "confidence"]);
    assertReference(match.relatedDtc);
    if (
      !actionableIdentities.has(dtcIdentity(match.relatedDtc)) ||
      typeof match.observation !== "string" || match.observation.length === 0 ||
      typeof match.possibleRelation !== "string" || match.possibleRelation.length === 0 ||
      !CONFIDENCES.has(match.confidence)
    ) {
      throw new ReportPdfValidationError();
    }
    matchIdentities.push(dtcIdentity(match.relatedDtc));
  });
  if (new Set(matchIdentities).size !== matchIdentities.length) throw new ReportPdfValidationError();
  walkSafeText(model);
}

export function buildReportExportModel(source: ReportExportSource): ReportExportModel {
  const submittedObservations = source.submittedObservations.trim();
  const actionableIdentities = new Set<string>();
  const actionableDtcs = source.actionableModules.flatMap((module) => module.dtcs.map((dtc) => {
    const reference = { code: dtc.code, moduleCode: module.code, moduleName: module.name };
    const identity = dtcIdentity(reference);
    actionableIdentities.add(identity);
    const documentary = source.documentaryDtcs.find((candidate) =>
      dtcIdentity({ code: candidate.code, moduleCode: candidate.moduleCode, moduleName: candidate.moduleName }) === identity &&
      candidate.normalizedClassification === "actionable"
    );
    if (!documentary || documentary.description !== dtc.description) throw new ReportPdfValidationError();
    return {
      ...reference,
      description: documentary.description,
      originalStatus: documentary.originalStatus,
      normalizedClassification: "actionable" as const,
      alsoHistorical: dtc.alsoHistorical,
    };
  }));

  const historicalDtcs = source.documentaryDtcs.flatMap((dtc) => {
    const reference = { code: dtc.code, moduleCode: dtc.moduleCode, moduleName: dtc.moduleName };
    if (dtc.normalizedClassification !== "historical" || actionableIdentities.has(dtcIdentity(reference))) return [];
    return [{
      ...reference,
      description: dtc.description,
      originalStatus: dtc.originalStatus,
      normalizedClassification: "historical" as const,
      alsoHistorical: false,
    }];
  });

  const model: ReportExportModel = {
    vehicle: {
      make: source.vehicle.make,
      model: source.vehicle.model,
      year: source.vehicle.year,
    },
    summary: {
      systemsScanned: source.counts.systems,
      detectedRows: source.counts.detected,
      actionableDtcs: source.counts.actionable,
      historicalRows: source.counts.historical,
      findings: source.analysis.findings.length,
    },
    actionableDtcs,
    historicalDtcs,
    analysis: {
      technicalSummary: source.analysis.technicalSummary,
      findings: source.analysis.findings.map((finding) => ({
        relatedDtc: finding.relatedDtc === null ? null : cloneReference(finding.relatedDtc),
        priority: finding.priority,
        simpleExplanation: finding.simpleExplanation,
        possibleCauses: [...finding.possibleCauses],
        recommendedChecks: [...finding.recommendedChecks],
        safetyWarnings: [...finding.safetyWarnings],
        confidence: finding.confidence,
      })),
      safetyWarnings: [...source.analysis.safetyWarnings],
      confidence: source.analysis.confidence,
      requiresTechnicianConfirmation: source.analysis.requiresTechnicianConfirmation,
    },
    observations: {
      used: submittedObservations.length === 0 ? null : submittedObservations,
      status: source.analysis.observationCorrelation.status,
      summary: source.analysis.observationCorrelation.status === "not_provided"
        ? NOT_PROVIDED_MESSAGE
        : source.analysis.observationCorrelation.summary,
      matches: source.analysis.observationCorrelation.matches.map((match) => ({
        relatedDtc: cloneReference(match.relatedDtc),
        observation: match.observation,
        possibleRelation: match.possibleRelation,
        confidence: match.confidence,
      })),
    },
  };
  validateReportExportModel(model);
  return model;
}

export function createReportFilename(generatedAt: Date) {
  if (Number.isNaN(generatedAt.getTime())) throw new ReportPdfValidationError();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `AutoDiagIA_Informe_${generatedAt.getFullYear()}-${pad(generatedAt.getMonth() + 1)}-${pad(generatedAt.getDate())}_${pad(generatedAt.getHours())}-${pad(generatedAt.getMinutes())}.pdf`;
}

type PdfLogoSource = HTMLCanvasElement | Uint8Array;
type DownloadLogoSource = HTMLImageElement | Uint8Array;

const PAGE_WIDTH = 210;
const MARGIN_X = 16;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_X * 2;
const CONTENT_BOTTOM = 278;
const COLORS = {
  navy: [14, 44, 82] as const,
  orange: [237, 91, 52] as const,
  cyan: [29, 183, 211] as const,
  gray: [82, 99, 116] as const,
  light: [240, 245, 248] as const,
  line: [216, 225, 232] as const,
};

function formatLocalDate(generatedAt: Date) {
  return new Intl.DateTimeFormat("es-GT", {
    dateStyle: "long",
    timeStyle: "short",
  }).format(generatedAt);
}

function confidenceLabel(confidence: ReportConfidence) {
  return ({ high: "Alta", medium: "Media", low: "Baja" })[confidence];
}

function priorityLabel(priority: ReportPriority) {
  return ({ critical: "Crítica", high: "Alta", medium: "Media", low: "Baja" })[priority];
}

function classificationLabel(classification: ReportExportDtc["normalizedClassification"]) {
  return classification === "actionable" ? "Accionable" : "Histórico";
}

export function renderReportPdf(model: ReportExportModel, generatedAt: Date, logo: PdfLogoSource): Uint8Array {
  validateReportExportModel(model);
  if (Number.isNaN(generatedAt.getTime())) throw new ReportPdfValidationError();
  if (logo instanceof Uint8Array && logo.length < 8) throw new ReportPdfValidationError();

  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4", compress: false });
  doc.setProperties({
    title: "Informe de orientación asistida por IA",
    author: "AutoDiag IA",
    subject: "Orientación técnica automotriz",
  });
  doc.setCreationDate(generatedAt);
  let y = 16;
  let continuationLabel: string | null = null;

  const drawContinuationHeader = () => {
    doc.addImage(logo, "PNG", MARGIN_X, 9, 38, 12.67, undefined, "FAST");
    doc.setDrawColor(...COLORS.line);
    doc.line(MARGIN_X, 26, PAGE_WIDTH - MARGIN_X, 26);
    y = 33;
    if (continuationLabel !== null) {
      doc.setFont("helvetica", "bold");
      doc.setFontSize(8);
      doc.setTextColor(...COLORS.orange);
      doc.text(continuationLabel, MARGIN_X, y);
      y += 7;
    }
  };

  const addPage = () => {
    doc.addPage();
    drawContinuationHeader();
  };

  const ensureSpace = (height: number) => {
    if (y + height > CONTENT_BOTTOM) addPage();
  };

  const writeLines = (
    lines: string[],
    options: { indent?: number; color?: readonly [number, number, number]; fontSize?: number; bold?: boolean } = {},
  ) => {
    const indent = options.indent ?? 0;
    const lineHeight = (options.fontSize ?? 9) * 0.42;
    for (const line of lines) {
      ensureSpace(lineHeight + 1);
      doc.setFont("helvetica", options.bold ? "bold" : "normal");
      doc.setFontSize(options.fontSize ?? 9);
      doc.setTextColor(...(options.color ?? COLORS.gray));
      doc.text(line, MARGIN_X + indent, y);
      y += lineHeight;
    }
  };

  const paragraph = (
    value: string,
    options: { indent?: number; width?: number; color?: readonly [number, number, number]; fontSize?: number; bold?: boolean } = {},
  ) => {
    const indent = options.indent ?? 0;
    const lines = doc.splitTextToSize(value, options.width ?? CONTENT_WIDTH - indent) as string[];
    writeLines(lines, { ...options, indent });
    y += 2;
  };

  const heading = (value: string, followingHeight = 8) => {
    ensureSpace(13 + followingHeight);
    if (y > 35) y += 3;
    doc.setFillColor(...COLORS.cyan);
    doc.rect(MARGIN_X, y - 4.2, 1.4, 6, "F");
    writeLines([value], { indent: 4, color: COLORS.navy, fontSize: 12, bold: true });
    y += 2;
  };

  const bulletList = (items: string[]) => {
    for (const item of items) paragraph(`- ${item}`, { indent: 4, width: CONTENT_WIDTH - 4 });
  };

  const labelValue = (label: string, value: string) => paragraph(`${label}: ${value}`);

  doc.addImage(logo, "PNG", MARGIN_X, y, 64, 21.33, undefined, "FAST");
  y += 29;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.setTextColor(...COLORS.navy);
  doc.text("Informe de orientación asistida por IA", MARGIN_X, y);
  y += 7;
  paragraph(`Generado localmente: ${formatLocalDate(generatedAt)}`, { color: COLORS.gray, fontSize: 8.5 });
  doc.setFillColor(255, 244, 238);
  doc.setDrawColor(...COLORS.orange);
  doc.roundedRect(MARGIN_X, y, CONTENT_WIDTH, 13, 2, 2, "FD");
  y += 8;
  writeLines(["Orientación técnica. No constituye un diagnóstico definitivo."], {
    indent: 4,
    color: COLORS.orange,
    fontSize: 9,
    bold: true,
  });
  y += 4;

  heading("Resumen del vehículo");
  labelValue("Marca", model.vehicle.make ?? "No identificado");
  labelValue("Modelo", model.vehicle.model ?? "No identificado");
  labelValue("Año", model.vehicle.year === null ? "No identificado" : String(model.vehicle.year));

  heading("Resumen del reporte");
  const summaryItems = [
    ["Sistemas escaneados", model.summary.systemsScanned],
    ["Filas DTC detectadas", model.summary.detectedRows],
    ["DTC accionables analizados", model.summary.actionableDtcs],
    ["Registros históricos", model.summary.historicalRows],
    ["Hallazgos generados", model.summary.findings],
  ] as const;
  for (const [label, value] of summaryItems) labelValue(label, String(value));

  heading("Observaciones del vehículo", 18);
  if (model.observations.status === "not_provided") {
    paragraph(NOT_PROVIDED_MESSAGE);
  } else {
    labelValue("Observación utilizada", model.observations.used ?? "No identificada");
    paragraph(model.observations.summary);
    if (model.observations.status === "no_clear_match") {
      paragraph("No se identificó una relación clara; esto no descarta una relación que requiera comprobación profesional.", {
        color: COLORS.gray,
      });
    } else {
      for (const match of model.observations.matches) {
        ensureSpace(25);
        paragraph(`${match.relatedDtc.code} · ${match.relatedDtc.moduleCode ?? "Sin código de módulo"} · ${match.relatedDtc.moduleName}`, {
          color: COLORS.navy,
          bold: true,
        });
        labelValue("Observación relacionada", match.observation);
        labelValue("Relación posible", match.possibleRelation);
        labelValue("Confianza de la relación", confidenceLabel(match.confidence));
      }
      paragraph(MATCH_CAUTION, { color: COLORS.orange, bold: true });
    }
  }

  heading("Resumen técnico", 15);
  paragraph(model.analysis.technicalSummary);
  labelValue("Confianza general", confidenceLabel(model.analysis.confidence));

  heading("DTC accionables", 28);
  for (const dtc of model.actionableDtcs) {
    ensureSpace(28);
    paragraph(`${dtc.code} · ${dtc.moduleCode ?? "Sin código de módulo"} · ${dtc.moduleName}`, {
      color: COLORS.navy,
      bold: true,
    });
    labelValue("Descripción documental", dtc.description);
    labelValue("Estado original", dtc.originalStatus ?? "No indicado");
    labelValue("Clasificación normalizada", classificationLabel(dtc.normalizedClassification));
    if (dtc.alsoHistorical) paragraph("También existe como antecedente histórico.", { color: COLORS.orange, bold: true });
    y += 1;
  }

  heading("Hallazgos priorizados", 32);
  model.analysis.findings.forEach((finding, index) => {
    ensureSpace(32);
    doc.setDrawColor(...COLORS.orange);
    doc.line(MARGIN_X, y - 2, MARGIN_X, Math.min(CONTENT_BOTTOM, y + 12));
    paragraph(`Hallazgo ${index + 1} · Prioridad ${priorityLabel(finding.priority)}`, {
      indent: 4,
      width: CONTENT_WIDTH - 4,
      color: COLORS.orange,
      bold: true,
    });
    if (finding.relatedDtc) {
      paragraph(`${finding.relatedDtc.code} · ${finding.relatedDtc.moduleCode ?? "Sin código de módulo"} · ${finding.relatedDtc.moduleName}`, {
        indent: 4,
        width: CONTENT_WIDTH - 4,
        color: COLORS.navy,
        bold: true,
      });
    } else {
      paragraph("Hallazgo general sin DTC específico", { indent: 4, color: COLORS.navy, bold: true });
    }
    continuationLabel = `Continuación del hallazgo ${index + 1}`;
    paragraph(finding.simpleExplanation, { indent: 4, width: CONTENT_WIDTH - 4 });
    paragraph("Posibles causas", { indent: 4, color: COLORS.navy, bold: true });
    bulletList(finding.possibleCauses);
    paragraph("Comprobaciones recomendadas", { indent: 4, color: COLORS.navy, bold: true });
    bulletList(finding.recommendedChecks);
    paragraph("Advertencias de seguridad", { indent: 4, color: COLORS.orange, bold: true });
    bulletList(finding.safetyWarnings);
    labelValue("Confianza", confidenceLabel(finding.confidence));
    y += 2;
    continuationLabel = null;
  });

  heading("Antecedentes históricos", 24);
  paragraph("Son antecedentes registrados. No equivalen necesariamente a una falla activa y no generan por sí solos un hallazgo completo.");
  if (model.historicalDtcs.length === 0) {
    paragraph("No se identificaron antecedentes exclusivamente históricos.");
  } else {
    for (const dtc of model.historicalDtcs) {
      ensureSpace(24);
      paragraph(`${dtc.code} · ${dtc.moduleCode ?? "Sin código de módulo"} · ${dtc.moduleName}`, {
        color: COLORS.navy,
        bold: true,
      });
      labelValue("Descripción documental", dtc.description);
      labelValue("Estado original", dtc.originalStatus ?? "No indicado");
      labelValue("Clasificación normalizada", classificationLabel(dtc.normalizedClassification));
      y += 1;
    }
  }

  heading("Advertencias generales", 15);
  bulletList(model.analysis.safetyWarnings);

  heading("Limitaciones y confirmación", 24);
  paragraph("Requiere confirmación del técnico.", { color: COLORS.orange, bold: true });
  bulletList([
    "Los DTC y síntomas no confirman por sí solos que una pieza esté dañada.",
    ...(model.observations.status === "not_provided" ? [] : ["Las coincidencias son orientativas."]),
    "Deben realizarse comprobaciones profesionales.",
    "Debe consultarse la documentación del fabricante.",
    "Deben respetarse los procedimientos de seguridad.",
  ]);

  const pageCount = doc.getNumberOfPages();
  for (let page = 1; page <= pageCount; page += 1) {
    doc.setPage(page);
    doc.setDrawColor(...COLORS.line);
    doc.line(MARGIN_X, 284, PAGE_WIDTH - MARGIN_X, 284);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(...COLORS.gray);
    doc.text("AutoDiag IA · Orientación técnica", MARGIN_X, 289);
    doc.text(`Página ${page} de ${pageCount}`, PAGE_WIDTH - MARGIN_X, 289, { align: "right" });
  }

  const bytes = new Uint8Array(doc.output("arraybuffer"));
  if (bytes.length < 5 || new TextDecoder("latin1").decode(bytes.slice(0, 5)) !== "%PDF-") {
    throw new Error("No fue posible crear un documento PDF válido.");
  }
  return bytes;
}

export async function downloadReportPdf(
  model: ReportExportModel,
  generatedAt: Date,
  logo: DownloadLogoSource,
): Promise<string> {
  let pdfLogo: PdfLogoSource;
  if (typeof HTMLImageElement !== "undefined" && logo instanceof HTMLImageElement) {
    if (!logo.complete || logo.naturalWidth === 0 || logo.naturalHeight === 0) throw new ReportPdfValidationError();
    const canvas = document.createElement("canvas");
    canvas.width = logo.naturalWidth;
    canvas.height = logo.naturalHeight;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("No fue posible preparar el logo del informe.");
    context.drawImage(logo, 0, 0, canvas.width, canvas.height);
    pdfLogo = canvas;
  } else {
    pdfLogo = logo as Uint8Array;
  }
  const bytes = renderReportPdf(model, generatedAt, pdfLogo);
  const blobBytes = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const blob = new Blob([blobBytes], { type: "application/pdf" });
  if (blob.size === 0) throw new Error("No fue posible crear el informe PDF.");
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const filename = createReportFilename(generatedAt);
  try {
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = "noopener";
    anchor.click();
  } finally {
    URL.revokeObjectURL(url);
  }
  return filename;
}

export const REPORT_PDF_TEXT = { NOT_PROVIDED_MESSAGE, MATCH_CAUTION } as const;
