import { z } from "zod";

import { diagnosticAnalysisOutputSchema } from "./ai-analysis-types.js";
import { containsSensitiveValue } from "./sensitive-data.js";

const text = z.string().trim().min(1).max(1_000);
const id = z.string().regex(/^[a-z][a-z0-9-]{0,79}$/u);
const reference = z.object({ code: text, moduleCode: text.nullable(), moduleName: text }).strict();
const row = reference.extend({
  status: z.enum(["current", "confirmed", "stored", "pending", "permanent", "intermittent", "on_demand", "continuous_memory", "provisional", "reviewed_uncertain", "multiple_observed", "history", "unknown"]),
}).strict();
const vehicle = z.object({ make: text.nullable(), model: text.nullable(), year: z.number().int().nullable() }).strict();
const versions = z.object({
  parser: text.nullable(), corpus: text.nullable(), prompt: text.nullable(), outputSchema: text.nullable(),
  analysisModel: text.nullable(), embeddingModel: text.nullable(), reasoningEffort: text.nullable(),
  ragEnabled: z.boolean().nullable(), matchCount: z.number().int().positive().nullable(),
  matchThreshold: z.number().min(0).max(1).nullable(), contextCharacters: z.number().int().positive().nullable(),
  attemptTimeoutMs: z.number().int().positive().nullable(), totalTimeoutMs: z.number().int().positive().nullable(),
}).strict();

const evaluationCase = z.object({
  id, split: z.enum(["development", "holdout"]),
  origin: z.object({ kind: z.enum(["synthetic", "authorized_sanitized"]), usePermission: text, reference: text }).strict(),
  scenario: text,
  observations: text.nullable(),
  expected: z.object({
    vehicle: vehicle.nullable(), dtcs: z.array(row).max(100).nullable(),
    // Explicitly labeled actionable references; history is never silently removed here.
    actionableDtcs: z.array(reference).max(100).nullable(),
    extractionDisposition: z.enum(["completed", "partial", "unsupported"]).nullable(),
    sources: z.array(z.object({ id, relevance: z.enum(["relevant", "partial", "irrelevant"]), justification: text }).strict()).nullable(),
    sourceLabelsExhaustive: z.boolean(),
    withoutEvidence: z.enum(["acknowledge_limits", "do_not_analyze", "not_applicable"]),
  }).strict(),
  humanReview: z.enum(["pending", "reviewed"]),
  versions: versions.nullable(),
}).strict();

export const evaluationCasesSchema = z.object({
  schemaVersion: z.literal("quality_cases_v1"), cases: z.array(evaluationCase).min(1).max(1_000),
}).strict().superRefine((value, context) => {
  if (new Set(value.cases.map((item) => item.id)).size !== value.cases.length) {
    context.addIssue({ code: "custom", message: "Duplicate case ID" });
  }
  for (const item of value.cases) {
    const labels = item.expected.sources;
    if (labels && new Set(labels.map((source) => source.id)).size !== labels.length) {
      context.addIssue({ code: "custom", message: "Duplicate source label" });
    }
  }
});

const review = z.object({
  status: z.enum(["pending", "completed"]), role: z.literal("qualified_technician"), rationale: text,
  supportedClaims: z.object({ supported: z.number().int().nonnegative(), total: z.number().int().positive() }).strict().nullable(),
  appropriateAbstention: z.boolean().nullable(),
  usefulAndSafe: z.boolean().nullable(),
}).strict().superRefine((value, context) => {
  if (value.supportedClaims && value.supportedClaims.supported > value.supportedClaims.total) {
    context.addIssue({ code: "custom", message: "Supported claims exceed total" });
  }
});

export const evaluationResultsSchema = z.object({
  schemaVersion: z.literal("quality_results_v1"),
  runs: z.array(z.object({
    id, caseId: id,
    origin: z.enum(["fixture", "recorded"]),
    versions,
    responseOrigin: z.enum(["new_generation", "memory_reuse", "history_reuse", "unknown"]),
    responseOriginEvidence: text.nullable(),
    httpStatus: z.number().int().min(100).max(599).nullable(),
    errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/u).nullable(),
    durationMs: z.number().finite().nonnegative().nullable(),
    extraction: z.object({ disposition: z.enum(["completed", "partial", "unsupported"]), vehicle, dtcs: z.array(row).max(100) }).strict().nullable(),
    analysisAvailable: z.boolean().nullable(),
    analysisInputDtcs: z.array(reference).max(100).nullable().default(null),
    // Copy only IDs actually in final evidence, not unfiltered RPC candidates.
    retrievedSources: z.array(id).max(10).nullable(),
    ragStatus: z.enum(["used", "disabled", "not_configured", "no_matches", "unavailable"]).nullable(),
    analysis: z.unknown().optional(),
    human: review.nullable(),
  }).strict()).max(10_000),
}).strict().superRefine((value, context) => {
  if (new Set(value.runs.map((item) => item.id)).size !== value.runs.length) {
    context.addIssue({ code: "custom", message: "Duplicate run ID" });
  }
  for (const run of value.runs) {
    if (run.ragStatus !== null && run.retrievedSources !== null
      && ((run.ragStatus === "used" && run.retrievedSources.length === 0)
        || (run.ragStatus !== "used" && run.retrievedSources.length > 0))) {
      context.addIssue({ code: "custom", message: "RAG status and sources disagree" });
    }
  }
});

export type EvaluationCase = z.infer<typeof evaluationCase>;
export type EvaluationRun = z.infer<typeof evaluationResultsSchema>["runs"][number];
export type Metric = { status: "measured"; value: number; numerator?: number; denominator?: number }
  | { status: "not_evaluable"; reason: string };
const unavailable = (reason: string): Metric => ({ status: "not_evaluable", reason });
const measured = (value: number): Metric => ({ status: "measured", value });
function ratio(numerator: number, denominator: number): Metric {
  return denominator === 0 ? unavailable("empty_denominator") : { status: "measured", value: numerator / denominator, numerator, denominator };
}
function key(value: z.infer<typeof reference>) {
  return JSON.stringify([value.moduleCode, value.moduleName, value.code]);
}
function rowKey(value: z.infer<typeof row>) { return JSON.stringify([key(value), value.status]); }
function overlap(expected: string[], actual: string[]) {
  const remaining = [...actual];
  return expected.reduce((count, item) => {
    const index = remaining.indexOf(item);
    if (index < 0) return count;
    remaining.splice(index, 1);
    return count + 1;
  }, 0);
}

function hasPrivateField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasPrivateField);
  return value !== null && typeof value === "object" && Object.entries(value).some(([field, child]) =>
    /^(?:vin|vinMasked|vinPseudonym|odometer|originalName|filename|sha256|contentToken|user_id|access_token|refresh_token)$/iu.test(field)
    || hasPrivateField(child));
}

/** Pure evaluator: no provider, environment, corpus, persistence or server imports. */
export function evaluateQuality(casesInput: unknown, resultsInput: unknown) {
  const cases = evaluationCasesSchema.parse(casesInput).cases;
  const runs = evaluationResultsSchema.parse(resultsInput).runs;
  // Reject rather than echo sensitive inputs. This is defense in depth, not anonymization.
  if (hasPrivateField([cases, runs]) || containsSensitiveValue([cases, runs], "free_text")) {
    throw new Error("EVALUATION_SENSITIVE_INPUT");
  }
  return runs.map((run) => {
    const item = cases.find((candidate) => candidate.id === run.caseId);
    if (!item) throw new Error("EVALUATION_UNKNOWN_CASE");
    if (item.origin.kind === "synthetic" && run.origin !== "fixture") throw new Error("EVALUATION_SYNTHETIC_REQUIRES_FIXTURE");
    const expectedRows = item.expected.dtcs;
    const extraction = run.extraction;
    const matches = expectedRows && extraction ? overlap(expectedRows.map(rowKey), extraction.dtcs.map(rowKey)) : null;
    const parsed = run.analysis === undefined ? null : diagnosticAnalysisOutputSchema.safeParse(run.analysis);
    const output = parsed?.success ? parsed.data : null;
    const expectedRefs = item.expected.actionableDtcs;
    const references = output ? [...output.findings.flatMap((finding) => finding.relatedDtc ? [finding.relatedDtc] : []),
      ...output.observationCorrelation.matches.map((match) => match.relatedDtc)] : null;
    const uniqueExpected = expectedRefs ? [...new Set(expectedRefs.map(key))] : null;
    const sentReferences = run.analysisInputDtcs?.map(key) ?? null;
    const covered = output && uniqueExpected && sentReferences !== null
      ? uniqueExpected.filter((ref) => sentReferences.includes(ref)
        && output.findings.some((finding) => finding.relatedDtc && key(finding.relatedDtc) === ref)).length
      : null;
    const knownVehicle = item.expected.vehicle ? Object.entries(item.expected.vehicle).filter(([, value]) => value !== null) : [];
    const sourceIds = run.retrievedSources === null ? null : [...new Set(run.retrievedSources)];
    const labels = item.expected.sources;
    const retrievalReady = item.humanReview === "reviewed" && labels !== null && sourceIds !== null
      && (run.ragStatus === "used" || run.ragStatus === "no_matches");
    const allRetrievedLabeled = sourceIds?.every((source) => labels?.some((label) => label.id === source));
    const relevant = labels?.filter((source) => source.relevance === "relevant").map((source) => source.id) ?? [];
    const human = run.human?.status === "completed" ? run.human : null;
    const recordedGeneration = run.responseOrigin === "new_generation" && run.responseOriginEvidence !== null
      && run.httpStatus === 200 && output !== null && run.errorCode === null;
    return {
      caseId: item.id, runId: run.id, split: item.split,
      evidenceScope: run.origin === "fixture" ? "evaluator_fixture_only" : "recorded_observation_not_diagnostic_accuracy",
      responseOrigin: run.responseOrigin, errorCode: run.errorCode,
      // Retain configurations for comparison; never group different policies implicitly.
      versions: run.versions,
      configurationMatchesCase: item.versions === null || Object.values(item.versions).some((value) => value === null)
        || Object.values(run.versions).some((value) => value === null)
        ? unavailable("configuration_not_fully_recorded")
        : measured(Number(JSON.stringify(item.versions) === JSON.stringify(run.versions))),
      automatic: {
        extractionDisposition: extraction && item.expected.extractionDisposition
          ? measured(Number(extraction.disposition === item.expected.extractionDisposition)) : unavailable("missing_extraction_or_label"),
        vehicleFields: extraction ? ratio(knownVehicle.filter(([field, value]) => extraction.vehicle[field as keyof typeof extraction.vehicle] === value).length, knownVehicle.length) : unavailable("missing_extraction"),
        dtcRowRecall: matches === null ? unavailable("missing_extraction_or_labels") : ratio(matches, expectedRows!.length),
        dtcRowPrecision: matches === null ? unavailable("missing_extraction_or_labels") : ratio(matches, extraction!.dtcs.length),
        outputSchema: parsed === null ? unavailable("missing_analysis") : measured(Number(parsed.success)),
        analysisBlockedWhenRequired: item.expected.withoutEvidence === "do_not_analyze" && run.analysisAvailable !== null
          ? measured(Number(!run.analysisAvailable && run.analysis === undefined)) : unavailable("not_applicable_or_missing_availability"),
        dtcCoverage: sentReferences === null ? unavailable("missing_sent_input")
          : covered === null ? unavailable("missing_valid_output_or_labels") : ratio(covered, uniqueExpected!.length),
        validDtcReferences: references && sentReferences ? ratio(references.filter((ref) => sentReferences.includes(key(ref))).length, references.length) : unavailable("missing_valid_output_or_sent_input"),
        retrievalPrecision: retrievalReady && allRetrievedLabeled
          ? ratio(sourceIds!.filter((source) => relevant.includes(source)).length, sourceIds!.length) : unavailable("missing_reviewed_source_labels"),
        retrievalRecall: retrievalReady && allRetrievedLabeled && item.expected.sourceLabelsExhaustive
          ? ratio(relevant.filter((source) => sourceIds!.includes(source)).length, relevant.length) : unavailable("source_labels_not_exhaustive_or_unreviewed"),
        retrievalPartialShare: retrievalReady && allRetrievedLabeled
          ? ratio(sourceIds!.filter((source) => labels!.some((label) => label.id === source && label.relevance === "partial")).length, sourceIds!.length) : unavailable("missing_reviewed_source_labels"),
        emptyRetrievalWhenExpected: retrievalReady && item.expected.sourceLabelsExhaustive && labels!.length === 0
          ? measured(Number(sourceIds!.length === 0)) : unavailable("no_reviewed_empty_pool_expectation"),
        httpSuccess: run.httpStatus === null ? unavailable("missing_http_measurement") : measured(Number(run.httpStatus >= 200 && run.httpStatus < 300)),
        totalLatencyMs: run.durationMs === null ? unavailable("missing_timing") : measured(run.durationMs),
        newGenerationLatencyMs: run.durationMs === null || !recordedGeneration
          ? unavailable("not_verified_new_generation") : measured(run.durationMs),
      },
      human: {
        supportedClaims: output && human?.supportedClaims ? ratio(human.supportedClaims.supported, human.supportedClaims.total) : unavailable("requires_valid_output_and_claim_by_claim_technical_review"),
        appropriateAbstention: human?.appropriateAbstention == null ? unavailable("requires_technical_review") : measured(Number(human.appropriateAbstention)),
        usefulAndSafe: human?.usefulAndSafe == null ? unavailable("requires_technical_review") : measured(Number(human.usefulAndSafe)),
      },
    };
  });
}
