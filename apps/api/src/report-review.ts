import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { canonicalSerialize } from "./analysis-fingerprint.js";
import { diagnosticAnalysisInputSchema, MAX_ANALYSIS_OBSERVATIONS, type DiagnosticAnalysisInput } from "./ai-analysis-types.js";
import { prepareAiAnalysis } from "./ai-analysis-adapter.js";
import { historyExtractionInputSchema, type HistoryCaptureContext } from "./diagnostic-history.js";
import { reportReviewEvidenceSchema, type ReportReviewEvidence } from "./report-review-schema.js";
import type { AutelExtraction } from "./report-types.js";
import { classifyDtcStatus, normalizeDtcStatus } from "./text-normalization.js";
import { containsSensitiveValue } from "./sensitive-data.js";
import { isSupportedDtcCode, normalizeForMatch } from "../../../shared/technical-text.mjs";

const proofSchema = z.string().regex(/^review_v1_\d{13}\.[0-9a-f]{64}$/u);
const PROOF_TTL_MS = 60 * 60 * 1000;
export class ReportValidationCapacityError extends Error {
  constructor() { super("REPORT_VALIDATION_UNAVAILABLE"); }
}
// Only digests/nonces are retained, never report text or credentials. This
// process-local authority deliberately fails closed after restart/eviction.
export class ReportProofRegistry {
  private readonly entries = new Map<string, { token: string; nonce: string; expires: number }>();
  constructor(private readonly maxEntries = 1000) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 10000) throw new Error("Invalid proof capacity");
  }
  private key(userId: string, report: string, secret: string) {
    return createHmac("sha256", secret).update(canonicalSerialize(["report-authority-v1", userId, report])).digest("hex");
  }
  issue(extraction: AutelExtraction, userId: string, report: string, content: string, secret: string, expires: number, expected?: string) {
    for (const [key, entry] of this.entries) if (entry.expires <= Date.now()) this.entries.delete(key);
    const key = this.key(userId, report, secret);
    if (expected !== undefined && !sameProof(this.entries.get(key)?.token, expected)) return null;
    if (!this.entries.has(key) && this.entries.size >= this.maxEntries) throw new ReportValidationCapacityError();
    const nonce = randomBytes(16).toString("hex");
    const token = `review_v1_${expires}.${digest(extraction, userId, report, content, expires, secret, nonce).toString("hex")}`;
    this.entries.set(key, { token, nonce, expires });
    return token;
  }
  verify(token: string, extraction: AutelExtraction, userId: string, report: string, content: string, secret: string, expires: number) {
    const entry = this.entries.get(this.key(userId, report, secret));
    if (!entry || !sameProof(entry.token, token) || entry.expires !== expires || expires <= Date.now() || expires > Date.now() + PROOF_TTL_MS) return false;
    const expected = digest(extraction, userId, report, content, expires, secret, entry.nonce);
    const actual = Buffer.from(token.split(".")[1]!, "hex");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
}
function sameProof(left: string | undefined, right: string) {
  if (left === undefined) return false;
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
const currentProofs = new ReportProofRegistry();
function digest(extraction: AutelExtraction, userId: string, reportReference: string, contentToken: string, expires: number, secret: string, nonce: string) {
  const key = createHmac("sha256", secret).update("autodiag/report-review/proof/key/v1").digest();
  return createHmac("sha256", key).update(canonicalSerialize({ extraction, userId, reportReference, contentToken, expires, nonce })).digest();
}
export function createExtractionToken(extraction: AutelExtraction, userId: string, reportReference: string, contentToken: string, secret: string, expires = Date.now() + PROOF_TTL_MS) {
  return currentProofs.issue(extraction, userId, reportReference, contentToken, secret, expires)!;
}
export function verifyExtractionToken(token: unknown, extraction: AutelExtraction, userId: string, reportReference: string, contentToken: string, secret: string) {
  if (!proofSchema.safeParse(token).success) return null;
  const [head] = (token as string).split(".");
  const expires = Number(head!.slice("review_v1_".length));
  if (!Number.isSafeInteger(expires) || expires <= Date.now() || expires > Date.now() + PROOF_TTL_MS) return null;
  return currentProofs.verify(token as string, extraction, userId, reportReference, contentToken, secret, expires) ? expires : null;
}
const reason = z.string().trim().min(10).max(500);
const rowSchema = z.object({ sourceIndex: z.number().int().min(0).max(199).nullable(), moduleIndex: z.number().int().min(0).max(99),
  code: z.string().trim().min(3).max(32), description: z.string().trim().min(1).max(1000),
  state: z.enum(["as_reported", "reviewed_uncertain"]), statusLabel: z.string().trim().min(1).max(120).optional(), reason: reason.optional(), duplicateReason: reason.optional(),
}).strict();
const requestSchema = z.object({ reportReference: z.string().uuid(), contentToken: z.string().max(150), extractionToken: proofSchema,
  extraction: historyExtractionInputSchema, vehicle: diagnosticAnalysisInputSchema.shape.vehicle,
  rows: z.array(rowSchema).max(MAX_ANALYSIS_OBSERVATIONS), reason,
  countsDecision: z.object({ use: z.enum(["reported", "detail"]), reason }).strict().optional(),
  reviewedWarnings: z.array(z.object({ code: z.enum(["DTC_ROW_UNPARSED", "VEHICLE_IDENTITY_AMBIGUOUS"]), reason }).strict()).max(2).default([]),
}).strict();
function originalEvidence(extraction: AutelExtraction): ReportReviewEvidence["original"] {
  if (extraction.review) return structuredClone(extraction.review.original);
  const { vinMasked: _masked, vinPseudonym: _pseudonym, ...vehicle } = extraction.vehicle;
  void _masked; void _pseudonym;
  return { status: extraction.status, requiresManualReview: extraction.requiresManualReview, vehicle,
    scanSummary: structuredClone(extraction.scanSummary), systems: structuredClone(extraction.systems),
    dtcs: structuredClone(extraction.dtcs), warnings: structuredClone(extraction.warnings) };
}

export function reviewReport(raw: unknown, userId: string, secret: string) {
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) return null;
  const data = parsed.data;
  const expires = verifyExtractionToken(data.extractionToken, data.extraction, userId, data.reportReference, data.contentToken, secret);
  if (expires === null) return null;
  const original = originalEvidence(data.extraction);
  if (original.dtcs.length > 200 || original.systems.length > 100 || containsSensitiveValue(original, "source_text")) return null;
  const zeroConfirmed = original.status === "completed" && !original.requiresManualReview && original.scanSummary.declaredDtcs === 0 &&
    original.scanSummary.parsedDtcs === 0 && original.dtcs.length === 0 && original.scanSummary.declaredSystems === original.systems.length &&
    original.scanSummary.parsedSystems === original.systems.length && original.systems.every(s => s.dtcCount === 0);
  if (zeroConfirmed && data.rows.length > 0) return null;
  const decisions: ReportReviewEvidence["decisions"] = [];
  const add = (path: string, before: unknown, after: unknown, why: string) => {
    decisions.push({ path, before: before === null ? null : typeof before === "string" ? before : JSON.stringify(before),
      after: after === null ? null : typeof after === "string" ? after : JSON.stringify(after), reason: why });
  };
  for (const key of ["make", "model", "year"] as const) {
    if (data.vehicle[key] !== original.vehicle[key]) add(`vehicle.${key}`, original.vehicle[key], data.vehicle[key], data.reason);
  }
  const seen = new Set<number>();
  const dtcs: AutelExtraction["dtcs"] = [];
  for (const [index, row] of data.rows.entries()) {
    if (!isSupportedDtcCode(row.code) || !original.systems[row.moduleIndex]) return null;
    if (row.sourceIndex !== null && (seen.has(row.sourceIndex) || !original.dtcs[row.sourceIndex])) return null;
    if (row.sourceIndex !== null) seen.add(row.sourceIndex);
    // Keep source order; reordering rows must not change their evidential identity.
    if (row.sourceIndex !== null && row.sourceIndex !== index) return null;
    const source = row.sourceIndex === null ? undefined : original.dtcs[row.sourceIndex];
    if (source && row.statusLabel !== undefined && row.statusLabel !== source.statusOriginal) return null;
    const statusOriginal = source?.statusOriginal ?? row.statusLabel ?? null;
    const normalized = normalizeDtcStatus(statusOriginal);
    const status = row.state === "reviewed_uncertain" ? "reviewed_uncertain" as const : normalized;
    const system = original.systems[row.moduleIndex]!;
    const changes: Array<[string, unknown, unknown]> = [];
    if (!source || row.code !== source.code) changes.push(["code", source?.code ?? null, row.code]);
    if (!source || system.code !== source.moduleCode || system.name !== source.moduleName) changes.push(["module", source ? `${source.moduleCode ?? ""} · ${source.moduleName}` : null, `${system.code ?? ""} · ${system.name}`]);
    if (!source || row.description !== source.descriptionOriginal) changes.push(["description", source?.descriptionOriginal ?? null, row.description]);
    if (row.state === "reviewed_uncertain") changes.push(["status", statusOriginal, "Incertidumbre revisada; no confirma actividad ni historia"]);
    if (changes.length && !row.reason) return null;
    if (!source && dtcs.some(d => d.code === row.code && d.moduleCode === system.code && d.moduleName === system.name &&
      normalizeForMatch(d.descriptionOriginal) === normalizeForMatch(row.description) && d.status === status)) {
      if (!row.duplicateReason) return null;
      add("extraction", "La observación añadida coincide con otra fila", `Fila ${index + 1}: observación independiente confirmada por el usuario`, row.duplicateReason);
    }
    for (const [field, before, after] of changes) add(`rows.${index}.${field}`, before, after, row.reason!);
    dtcs.push({ code: row.code, moduleCode: system.code, moduleName: system.name, descriptionOriginal: row.description,
      status, statusOriginal, classification: classifyDtcStatus(status) });
  }
  if (seen.size !== original.dtcs.length) return null; // Never drop original observations.
  const systems = structuredClone(original.systems);
  const summary = structuredClone(original.scanSummary);
  summary.parsedSystems = systems.length; summary.parsedDtcs = dtcs.length;
  if (data.countsDecision?.use === "detail") {
    for (const system of systems) system.dtcCount = dtcs.filter(row => row.moduleCode === system.code && row.moduleName === system.name).length;
    summary.declaredSystems = systems.length; summary.declaredDtcs = dtcs.length;
    add("counts", { summary: original.scanSummary, modules: original.systems.map(s => s.dtcCount) },
      { summary, modules: systems.map(s => s.dtcCount) }, data.countsDecision.reason);
  }
  const resolved = new Set<string>();
  // The validated, explicitly supplied vehicle resolves an unreadable route,
  // not an absent/invalid document section. Its original nulls and the reason
  // remain recorded by the vehicle decisions above.
  if (original.warnings.some(w => w.code === "VEHICLE_IDENTITY_UNREADABLE")) resolved.add("VEHICLE_IDENTITY_UNREADABLE");
  if (dtcs.every(row => row.status !== "unknown")) resolved.add("UNKNOWN_DTC_STATUS");
  if (summary.declaredSystems === systems.length) resolved.add("SYSTEM_COUNT_MISMATCH");
  if (summary.declaredDtcs === dtcs.length) resolved.add("DTC_COUNT_MISMATCH");
  if (systems.every(system => system.dtcCount === dtcs.filter(row => row.moduleCode === system.code && row.moduleName === system.name).length)) resolved.add("MODULE_DTC_COUNT_MISMATCH");
  for (const warning of data.reviewedWarnings) {
    if (!original.warnings.some(w => w.code === warning.code)) return null;
    resolved.add(warning.code); add("extraction", warning.code, "Revisado contra evidencia por el usuario", warning.reason);
  }
  if (decisions.length === 0) return null;
  const optional = new Set(["VIN_NOT_PROVIDED", "ENGINE_NOT_PROVIDED", "ODOMETER_NOT_PROVIDED", "ODOMETER_UNIT_NOT_PROVIDED", "YEAR_NOT_PROVIDED", "VEHICLE_DATA_CONFIRMED_BY_USER"]);
  const remaining = original.warnings.filter(w => !optional.has(w.code) && !resolved.has(w.code));
  const unknown = dtcs.some(row => row.status === "unknown");
  const countsInvalid = summary.declaredSystems !== systems.length || summary.declaredDtcs !== dtcs.length || !resolved.has("MODULE_DTC_COUNT_MISMATCH");
  const partial = remaining.length > 0 || unknown || countsInvalid ||
    (original.status === "partial" && original.warnings.length === 0);
  const evidence = reportReviewEvidenceSchema.safeParse({ version: "report_review_v1", original, decisions, reason: data.reason });
  if (!evidence.success || containsSensitiveValue({ vehicle: data.vehicle, decisions, dtcs, reason: data.reason }, "source_text")) return null;
  const effective: AutelExtraction = { ...data.extraction, vehicle: { ...data.extraction.vehicle, ...data.vehicle },
    status: partial ? "partial" : "completed", requiresManualReview: partial, systems, dtcs, scanSummary: summary,
    review: evidence.data,
    warnings: [...original.warnings.filter(w => !resolved.has(w.code)).map(w => w.code === "YEAR_NOT_PROVIDED"
      ? { ...w, message: "Año ausente en el PDF; se usa el dato confirmado por el usuario." } : w),
      { code: "REPORT_REVIEWED_BY_USER", message: "Datos efectivos revisados por el usuario. La evidencia original permanece en el historial; esto no acredita una revisión profesional." }],
  };
  // Compare-and-swap is synchronous, with no await between validation and issue.
  const extractionToken = currentProofs.issue(effective, userId, data.reportReference, data.contentToken, secret, expires, data.extractionToken);
  if (extractionToken === null) return null;
  return { extraction: effective, analysisPreparation: prepareAiAnalysis(effective), extractionToken };
}

export function validatedReportMatchesInput(input: DiagnosticAnalysisInput, context: HistoryCaptureContext | undefined, userId: string, secret: string) {
  if (!context) return false;
  // A report-bound analysis must prove the complete effective extraction, even
  // if a client removes review flags or changes them to look like legacy data.
  if (!context.extractionToken || !context.contentToken || verifyExtractionToken(context.extractionToken, context.extraction, userId, context.reportReference, context.contentToken, secret) === null) return false;
  const preparation = prepareAiAnalysis(context.extraction);
  if (!preparation.available) return false;
  const withoutObservations = ({ observations: _observations, ...report }: DiagnosticAnalysisInput) => { void _observations; return report; };
  return canonicalSerialize(withoutObservations(preparation.input)) === canonicalSerialize(withoutObservations(input));
}
