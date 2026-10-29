// Trusted test-server fixture only. Never imported by production code. Valid
// endpoint regression inputs now need the same server authority as uploads.
import { createHash } from "node:crypto";
import { diagnosticAnalysisInputSchema } from "../src/ai-analysis-types.js";
import { canonicalSerialize, createPdfContentToken } from "../src/analysis-fingerprint.js";
import { createExtractionToken, verifyExtractionToken } from "../src/report-review.js";
import type { AutelExtraction } from "../src/report-types.js";

const proofs = new Map<string, string>();
export function stableExtractionToken(e: AutelExtraction, user: string, report: string, content: string, secret: string) {
  const key = canonicalSerialize([e, user, report, content, secret]);
  let token = proofs.get(key);
  if (!token || verifyExtractionToken(token, e, user, report, content, secret) === null) {
    token = createExtractionToken(e, user, report, content, secret); proofs.set(key, token);
  }
  return token;
}
export function validatedFixture(value: unknown, secret: string, user: string) {
  const parsed = diagnosticAnalysisInputSchema.safeParse(value);
  if (!parsed.success || parsed.data.reviewContext) return value;
  const { observations: _observations, ...technical } = parsed.data; void _observations;
  const serialized = canonicalSerialize(technical), hash = createHash("sha256").update(serialized).digest("hex");
  const reportReference = `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-8${hash.slice(17,20)}-${hash.slice(20,32)}`;
  const labels = { current: "Actual", confirmed: "Confirmed / Test Failed", stored: "Almacenado", pending: "Pendiente", permanent: "DTC permanente", intermittent: "Intermitente",
    on_demand: "ODDTCs", continuous_memory: "CMDTCs", provisional: "DTC provisional", reviewed_uncertain: "1 vez", history: "Histórico", unknown: "Desconocido" };
  const dtcs: AutelExtraction["dtcs"] = technical.modules.flatMap(m => m.dtcs.flatMap(d => {
    const rows = d.observations ?? [{ status: d.status as keyof typeof labels, description: d.description, statusOriginal: labels[d.status as keyof typeof labels] }];
    return [...rows, ...(d.alsoHistorical && !d.observations ? [{ description: d.description, status: "history" as const, statusOriginal: "Histórico" }] : [])].map(row => ({
      code: d.code, moduleCode: m.code, moduleName: m.name, descriptionOriginal: row.description, status: row.status,
      statusOriginal: row.statusOriginal, classification: row.status === "history" ? "historical" as const : row.status === "unknown" ? "unknown" as const : "actionable" as const,
    }));
  }));
  const extraction: AutelExtraction = { format: "autel_vehicle_diagnostic_report", status: "completed", requiresManualReview: false,
    vehicle: { ...technical.vehicle, engine: null, odometer: null, vinMasked: null, vinPseudonym: null },
    systems: technical.modules.map(m => ({ code: m.code, name: m.name, dtcCount: dtcs.filter(d => d.moduleCode === m.code && d.moduleName === m.name).length })),
    scanSummary: { declaredSystems: technical.modules.length, parsedSystems: technical.modules.length, declaredDtcs: dtcs.length, parsedDtcs: dtcs.length }, dtcs, warnings: [] };
  const contentToken = createPdfContentToken(Buffer.from(serialized), secret, user);
  return { input: value, historyContext: { reportReference, contentToken, extraction,
    extractionToken: stableExtractionToken(extraction, user, reportReference, contentToken, secret) } };
}
