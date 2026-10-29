import { DIAGNOSTIC_ANALYSIS_JSON_SCHEMA, diagnosticAnalysisOutputSchema, type DiagnosticAnalysisInput } from "./ai-analysis-types.js";

export const REFERENCE_INSTRUCTIONS = "Each actionable DTC has a server-assigned referenceId. In relatedDtc return only that exact referenceId (or null for an unassociated finding). Never reconstruct codes or module names in relatedDtc, invent IDs, or use knowledge-source IDs as DTC references. The server restores original reference data. Do not duplicate a reference within findings or observation matches.";
export class AnalysisReferenceError extends Error {
  constructor(public readonly reason: "JSON_INVALID" | "SCHEMA_INVALID" | "UNKNOWN_REFERENCE") { super(reason); }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AnalysisReferenceError("SCHEMA_INVALID");
  return value as Record<string, unknown>;
}

// IDs are deterministic within the validated input order, not report/user identifiers.
export function prepareAnalysisReferences(report: Omit<DiagnosticAnalysisInput, "observations">) {
  const references = new Map<string, { code: string; moduleCode: string | null; moduleName: string }>();
  const modelReport = { vehicle: report.vehicle, ...(report.reviewContext ? { reviewContext: report.reviewContext } : {}), modules: report.modules.map(module => ({
    ...module, dtcs: module.dtcs.map(dtc => {
      const referenceId = `D${String(references.size + 1).padStart(3, "0")}`;
      references.set(referenceId, { code: dtc.code, moduleCode: module.code, moduleName: module.name });
      return { ...dtc, referenceId };
    }),
  })) };
  const reference = { type: "string", enum: [...references.keys()] };
  const base = DIAGNOSTIC_ANALYSIS_JSON_SCHEMA.properties;
  const schema = { ...DIAGNOSTIC_ANALYSIS_JSON_SCHEMA, properties: { ...base,
    findings: { ...base.findings, items: { ...base.findings.items, properties: {
      ...base.findings.items.properties, relatedDtc: { anyOf: [reference, { type: "null" }] },
    } } },
    observationCorrelation: { ...base.observationCorrelation, properties: { ...base.observationCorrelation.properties,
      matches: { ...base.observationCorrelation.properties.matches, items: {
        ...base.observationCorrelation.properties.matches.items, properties: {
          ...base.observationCorrelation.properties.matches.items.properties, relatedDtc: reference,
        },
      } },
    } },
  } };
  function restore(raw: string) {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new AnalysisReferenceError("JSON_INVALID"); }
    const value = object(parsed), correlation = object(value.observationCorrelation);
    if (!Array.isArray(value.findings) || !Array.isArray(correlation.matches)) throw new AnalysisReferenceError("SCHEMA_INVALID");
    const resolve = (entry: unknown, nullable: boolean) => {
      const item = object(entry);
      if (nullable && item.relatedDtc === null) return item;
      if (typeof item.relatedDtc !== "string") throw new AnalysisReferenceError("SCHEMA_INVALID");
      const original = references.get(item.relatedDtc);
      if (!original) throw new AnalysisReferenceError("UNKNOWN_REFERENCE");
      return { ...item, relatedDtc: { ...original } };
    };
    const restored = diagnosticAnalysisOutputSchema.safeParse({ ...value,
      findings: value.findings.map(entry => resolve(entry, true)),
      observationCorrelation: { ...correlation, matches: correlation.matches.map(entry => resolve(entry, false)) },
    });
    if (!restored.success) throw new AnalysisReferenceError("SCHEMA_INVALID");
    return JSON.stringify(restored.data);
  }
  return { report: modelReport, schema, restore };
}
