export const MAX_ANALYSIS_DTCS = 50;
export const MAX_ANALYSIS_OBSERVATIONS = 200;
export const REPORTED_STATUSES = ["current", "confirmed", "stored", "pending", "permanent", "intermittent", "on_demand", "continuous_memory", "provisional", "reviewed_uncertain", "history", "unknown"];
export type ReviewContext = { reason: string; correctedFields: string[] } & (
  { version: "review_context_v1" } | { version: "review_context_v2"; provenance: "user_review_unverified"; decisions: ReportReviewEvidence["decisions"]; limited?: LimitedGuidance }
);
export interface ReviewableExtraction {
  status: "completed" | "partial"; requiresManualReview: boolean;
  vehicle: { year: number | null; make: string | null; model: string | null; engine: string | null;
    odometer: { value: number; unit: "km" | "mi" } | null; odometerRaw?: string };
  scanSummary: { declaredSystems: number | null; parsedSystems: number; declaredDtcs: number | null; parsedDtcs: number };
  systems: Array<{ code: string | null; name: string; dtcCount: number }>;
  dtcs: Array<{ code: string; moduleCode: string | null; moduleName: string; descriptionOriginal: string;
    status: string; statusOriginal: string | null; classification: "actionable" | "historical" | "unknown" }>;
  warnings: Array<{ code: string; message: string }>;
  review?: ReportReviewEvidence;
}
export interface ReportReviewEvidence {
  limited?: LimitedGuidance;
  version: "report_review_v1"; reason: string;
  original: Omit<ReviewableExtraction, "review">;
  decisions: Array<{ path: string; before: string | null; after: string | null; reason: string }>;
}
export interface LimitedGuidance {
  mode: "limited_guidance_v1"; coverage: "reviewed_rows_only"; limitations: string[];
  positions: Array<{ rowIndex: number; page: number | null; line: number | null; provenance: "parser_row_reviewed" | "manual_transcription"; reason: string }>;
}
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every(k => allowed.includes(k));
const text = (v: unknown, max: number, blank = false): v is string => typeof v === "string" && v.length <= max && (blank || !!v.trim());
const nullableText = (v: unknown, max: number) => v === null || text(v, max);
const count = (v: unknown, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max;
export function isReviewEvidence(value: unknown, sensitive: (s: string) => boolean): value is ReportReviewEvidence {
  if (!record(value) || !keys(value, ["version", "reason", "original", "decisions", "limited"]) || !isLimitedGuidance(value.limited, sensitive) || value.version !== "report_review_v1" ||
    !text(value.reason, 500) || value.reason.trim().length < 10 || !record(value.original) || !Array.isArray(value.decisions) || !value.decisions.length || value.decisions.length > 1400) return false;
  const o = value.original;
  if (!keys(o, ["status", "requiresManualReview", "vehicle", "scanSummary", "systems", "dtcs", "warnings"]) ||
    !["completed", "partial"].includes(String(o.status)) || typeof o.requiresManualReview !== "boolean" || !record(o.vehicle) || !record(o.scanSummary) ||
    !Array.isArray(o.systems) || o.systems.length > 100 || !Array.isArray(o.dtcs) || o.dtcs.length > 200 || !Array.isArray(o.warnings) || o.warnings.length > 100) return false;
  const v = o.vehicle, s = o.scanSummary;
  if (!keys(v, ["year", "make", "model", "engine", "odometer", "odometerRaw"]) || !(v.year === null || (count(v.year, 9999) && v.year >= 1886)) ||
    !nullableText(v.make, 80) || !nullableText(v.model, 120) || !nullableText(v.engine, 160) ||
    (v.odometerRaw !== undefined && !text(v.odometerRaw, 80)) || !(v.odometer === null || (record(v.odometer) && keys(v.odometer, ["value", "unit"]) &&
      typeof v.odometer.value === "number" && Number.isFinite(v.odometer.value) && v.odometer.value >= 0 && v.odometer.value <= 100000000 && ["km", "mi"].includes(String(v.odometer.unit))))) return false;
  if (!keys(s, ["declaredSystems", "parsedSystems", "declaredDtcs", "parsedDtcs"]) || !(s.declaredSystems === null || count(s.declaredSystems, 10000)) ||
    !count(s.parsedSystems, 10000) || !(s.declaredDtcs === null || count(s.declaredDtcs, 100000)) || !count(s.parsedDtcs, 100000)) return false;
  if (!o.systems.every(row => record(row) && keys(row, ["code", "name", "dtcCount"]) && nullableText(row.code, 32) && text(row.name, 160) && count(row.dtcCount, 100000))) return false;
  if (!o.dtcs.every(row => record(row) && keys(row, ["code", "moduleCode", "moduleName", "descriptionOriginal", "status", "statusOriginal", "classification"]) &&
    text(row.code, 32, true) && nullableText(row.moduleCode, 32) && text(row.moduleName, 160) && text(row.descriptionOriginal, 1000, true) &&
    REPORTED_STATUSES.includes(String(row.status)) && nullableText(row.statusOriginal, 120) && ["actionable", "historical", "unknown"].includes(String(row.classification)))) return false;
  if (!o.warnings.every(w => record(w) && keys(w, ["code", "message"]) && text(w.code, 80) && text(w.message, 500))) return false;
  if (!value.decisions.every(d => record(d) && keys(d, ["path", "before", "after", "reason"]) && text(d.path, 120) &&
    /^(?:vehicle\.(?:make|model|year)|rows\.\d+\.(?:code|module|description|status)|counts|extraction)$/u.test(d.path) &&
    (d.before === null || text(d.before, 2000, true)) && (d.after === null || text(d.after, 2000, true)) && text(d.reason, 500) && d.reason.trim().length >= 10)) return false;
  function safe(v: unknown): boolean {
    if (typeof v === "string") return !sensitive(v);
    if (Array.isArray(v)) return v.every(safe);
    return !record(v) || Object.values(v).every(safe);
  }
  return JSON.stringify(value).length <= 500000 && safe(value);
}
export function isDtcObservations(value: unknown, sensitive: (s: string) => boolean = () => false): boolean {
  return value === undefined || (Array.isArray(value) && value.length > 0 && value.length <= MAX_ANALYSIS_OBSERVATIONS && value.every(row =>
    record(row) && keys(row, ["description", "status", "statusOriginal"]) && text(row.description, 1000) &&
    REPORTED_STATUSES.includes(String(row.status)) && nullableText(row.statusOriginal, 120) && !sensitive(String(row.description)) &&
    (row.statusOriginal === null || !sensitive(String(row.statusOriginal)))));
}
export function isReviewContext(value: unknown, sensitive: (s: string) => boolean = () => false): boolean {
  if (value === undefined) return true;
  if (!record(value)) return false;
  const v2 = value.version === "review_context_v2";
  const decisionValid = (d: unknown) => record(d) && keys(d, ["path", "before", "after", "reason"]) && text(d.path, 120) &&
    /^(?:vehicle\.(?:make|model|year)|rows\.\d+\.(?:code|module|description|status)|counts|extraction)$/u.test(d.path) &&
    (d.before === null || text(d.before, 2000, true)) && (d.after === null || text(d.after, 2000, true)) && text(d.reason, 500) && d.reason.trim().length >= 10 &&
    Object.values(d).every(v => v === null || (typeof v === "string" && !sensitive(v)));
  return keys(value, v2 ? ["version", "reason", "correctedFields", "provenance", "decisions", "limited"] : ["version", "reason", "correctedFields"]) && isLimitedGuidance(value.limited, sensitive) &&
    (v2 ? value.provenance === "user_review_unverified" && Array.isArray(value.decisions) && value.decisions.length > 0 && value.decisions.length <= 1400 && value.decisions.every(decisionValid) : value.version === "review_context_v1") &&
    text(value.reason, 500) && value.reason.trim().length >= 10 && Array.isArray(value.correctedFields) && value.correctedFields.length > 0 &&
    value.correctedFields.length <= 1400 && value.correctedFields.every(s => text(s, 120) && !sensitive(s)) && !sensitive(String(value.reason));
}
export function isLimitedGuidance(v: unknown, sensitive: (s: string) => boolean): v is LimitedGuidance | undefined {
  if (v === undefined) return true;
  return record(v) && keys(v, ["mode", "coverage", "limitations", "positions"]) && v.mode === "limited_guidance_v1" && v.coverage === "reviewed_rows_only" &&
    Array.isArray(v.limitations) && v.limitations.length > 0 && v.limitations.length <= 510 && v.limitations.every(s => text(s, 500) && !sensitive(s)) &&
    Array.isArray(v.positions) && v.positions.length > 0 && v.positions.length <= 200 && v.positions.every(p => record(p) && keys(p, ["rowIndex", "page", "line", "provenance", "reason"]) &&
      count(p.rowIndex, 199) && (p.page === null || (count(p.page, 1000) && p.page > 0)) && (p.line === null || (count(p.line, 100000) && p.line > 0)) &&
      ["parser_row_reviewed", "manual_transcription"].includes(String(p.provenance)) && text(p.reason, 500) && p.reason.trim().length >= 10 && !sensitive(p.reason));
}
export function hasConsistentObservedStates(dtc: { status: string; alsoHistorical: boolean; observations?: Array<{ status: string }> }) {
  if (!dtc.observations) return dtc.status !== "multiple_observed";
  const statuses = new Set(dtc.observations.filter(row => row.status !== "history").map(row => row.status));
  return !statuses.has("unknown") && dtc.status === (statuses.size > 1 ? "multiple_observed" : [...statuses][0]) &&
    dtc.alsoHistorical === dtc.observations.some(row => row.status === "history");
}
