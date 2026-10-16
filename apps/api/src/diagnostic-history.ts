import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { prepareAiAnalysis } from "./ai-analysis-adapter.js";
import {
  diagnosticAnalysisInputSchema,
  diagnosticAnalysisOutputSchema,
  type DiagnosticAnalysisInput,
  type DiagnosticAnalysisOutput,
} from "./ai-analysis-types.js";
import { ragMetadataSchema, type RagMetadata } from "./rag-types.js";
import {
  containsSensitiveText,
  containsSensitiveValue,
  normalizeSafeHttpsUrl,
} from "./sensitive-data.js";

export const HISTORY_SCHEMA_VERSION = 1;
export const DEFAULT_HISTORY_PAGE_SIZE = 20;
export const MAX_HISTORY_PAGE_SIZE = 50;

const nonBlank = (maximum: number) => z.string().trim().min(1).max(maximum);
const nullableNonBlank = (maximum: number) => nonBlank(maximum).nullable();
const dtcStatusSchema = z.enum([
  "current",
  "confirmed",
  "stored",
  "pending",
  "permanent",
  "intermittent",
  "history",
  "unknown",
]);

export const historyExtractionInputSchema = z.object({
  status: z.enum(["completed", "partial"]),
  format: z.literal("autel_vehicle_diagnostic_report"),
  requiresManualReview: z.boolean(),
  vehicle: z.object({
    year: z.number().int().min(1886).max(9_999).nullable(),
    make: nullableNonBlank(80),
    model: nullableNonBlank(120),
    engine: nullableNonBlank(160),
    odometer: z.object({
      value: z.number().finite().nonnegative().max(100_000_000),
      unit: z.enum(["km", "mi"]),
    }).strict().nullable(),
    vinMasked: z.string().regex(/^\*{13}[A-HJ-NPR-Z0-9]{4}$/u).nullable(),
    vinPseudonym: z.string().regex(/^vin_v1_[a-f0-9]{64}$/u).nullable(),
  }).strict().superRefine((vehicle, context) => {
    if ((vehicle.vinMasked === null) !== (vehicle.vinPseudonym === null)) {
      context.addIssue({ code: "custom", message: "La protección del VIN no es coherente." });
    }
  }),
  scanSummary: z.object({
    declaredSystems: z.number().int().nonnegative().max(10_000).nullable(),
    parsedSystems: z.number().int().nonnegative().max(10_000),
    declaredDtcs: z.number().int().nonnegative().max(100_000).nullable(),
    parsedDtcs: z.number().int().nonnegative().max(100_000),
  }).strict(),
  systems: z.array(z.object({
    code: nullableNonBlank(32),
    name: nonBlank(160),
    dtcCount: z.number().int().nonnegative().max(100_000),
  }).strict()).max(10_000),
  dtcs: z.array(z.object({
    code: nonBlank(32),
    moduleCode: nullableNonBlank(32),
    moduleName: nonBlank(160),
    status: dtcStatusSchema,
    statusOriginal: nullableNonBlank(120),
    classification: z.enum(["actionable", "historical", "unknown"]),
    descriptionOriginal: nonBlank(1_000),
  }).strict()).max(100_000),
  warnings: z.array(z.object({
    code: nonBlank(80),
    message: nonBlank(500),
  }).strict()).max(100),
}).strict();

export const historyCaptureContextSchema = z.object({
  reportReference: z.string().uuid(),
  contentToken: z.string().regex(/^pdf_v1_[0-9a-f]{64}\.[0-9a-f]{64}$/u).optional(),
  extraction: historyExtractionInputSchema,
}).strict();

const historyAnalysisEnvelopeSchema = z.object({
  input: diagnosticAnalysisInputSchema,
  historyContext: historyCaptureContextSchema,
}).strict();

export type HistoryCaptureContext = z.infer<typeof historyCaptureContextSchema>;

export function parseAnalysisRequest(value: unknown): {
  input: unknown;
  historyContext?: HistoryCaptureContext;
} {
  const envelope = historyAnalysisEnvelopeSchema.safeParse(value);
  if (envelope.success) return envelope.data;
  return { input: value };
}

const historyExtractionSnapshotSchema = historyExtractionInputSchema.extend({
  vehicle: z.object({
    year: z.number().int().min(1886).max(9_999).nullable(),
    make: nullableNonBlank(80),
    model: nullableNonBlank(120),
    engine: nullableNonBlank(160),
    odometer: z.object({
      value: z.number().finite().nonnegative().max(100_000_000),
      unit: z.enum(["km", "mi"]),
    }).strict().nullable(),
    vinMasked: z.string().regex(/^\*{13}[A-HJ-NPR-Z0-9]{4}$/u).nullable(),
    vinPseudonym: z.null(),
  }).strict(),
});

const historyAnalysisSnapshotSchema = z.object({
  input: diagnosticAnalysisInputSchema,
  counts: z.object({
    detected: z.number().int().nonnegative(),
    actionable: z.number().int().nonnegative(),
    historical: z.number().int().nonnegative(),
  }).strict(),
  output: diagnosticAnalysisOutputSchema,
  submittedObservations: z.string().max(1_000),
}).strict();

export const historyPublicSnapshotSchema = z.object({
  extraction: historyExtractionSnapshotSchema,
  analysis: historyAnalysisSnapshotSchema,
  rag: ragMetadataSchema,
}).strict();

export type HistoryPublicSnapshot = z.infer<typeof historyPublicSnapshotSchema>;

const historyListItemSchema = z.object({
  id: z.string().uuid(),
  createdAt: z.string().datetime({ offset: true }),
  reportReference: z.string().uuid().nullable(),
  vehicle: z.object({
    make: nonBlank(80),
    model: nonBlank(120),
    year: z.number().int().min(1886).max(9_999),
  }).strict(),
  odometer: z.object({
    value: z.number().finite().nonnegative(),
    unit: z.enum(["km", "mi"]),
  }).strict().nullable(),
  dtcCount: z.number().int().nonnegative(),
  ragStatus: ragMetadataSchema.shape.status,
}).strict();

export const historyDetailSchema = historyListItemSchema.extend({
  analysisModel: nonBlank(100),
  embeddingModel: nonBlank(100).nullable(),
  schemaVersion: z.literal(HISTORY_SCHEMA_VERSION),
  snapshot: historyPublicSnapshotSchema,
}).strict();

export type HistoryListItem = z.infer<typeof historyListItemSchema>;
export type HistoryDetail = z.infer<typeof historyDetailSchema>;

const storedListRowSchema = z.object({
  id: z.string().uuid(),
  created_at: z.string().datetime({ offset: true }),
  report_reference: z.string().uuid().nullable(),
  make: nonBlank(80),
  model: nonBlank(120),
  year: z.number().int().min(1886).max(9_999),
  odometer_value: z.number().finite().nonnegative().nullable(),
  odometer_unit: z.enum(["km", "mi"]).nullable(),
  dtc_count: z.number().int().nonnegative(),
  rag_status: ragMetadataSchema.shape.status,
}).strict().superRefine((row, context) => {
  if ((row.odometer_value === null) !== (row.odometer_unit === null)) {
    context.addIssue({ code: "custom", message: "El odómetro almacenado no es coherente." });
  }
});

const storedDetailRowSchema = storedListRowSchema.extend({
  extraction_snapshot: historyExtractionSnapshotSchema,
  analysis_snapshot: historyAnalysisSnapshotSchema,
  rag_snapshot: ragMetadataSchema,
  analysis_model: nonBlank(100),
  embedding_model: nonBlank(100).nullable(),
  schema_version: z.literal(HISTORY_SCHEMA_VERSION),
}).strict();

interface HistoryInsertRecord {
  reportReference: string;
  contentFingerprint: string | null;
  analysisFingerprint: string | null;
  make: string;
  model: string;
  year: number;
  odometer: { value: number; unit: "km" | "mi" } | null;
  vinHmac: string | null;
  vinLast4: string | null;
  dtcCodes: string[];
  ragStatus: RagMetadata["status"];
  extractionSnapshot: HistoryPublicSnapshot["extraction"];
  analysisSnapshot: HistoryPublicSnapshot["analysis"];
  ragSnapshot: RagMetadata;
  analysisModel: string;
  embeddingModel: string | null;
}

export interface HistorySaveInput {
  context: HistoryCaptureContext;
  contentFingerprint?: string;
  analysisFingerprint?: string;
  input: DiagnosticAnalysisInput;
  analysis: DiagnosticAnalysisOutput;
  rag: RagMetadata;
  analysisModel: string;
  embeddingModel: string | null;
}

interface StoredHistoryPage {
  rows: unknown[];
  hasMore: boolean;
}

export interface DiagnosticHistoryRepository {
  insert(userId: string, record: HistoryInsertRecord, signal?: AbortSignal): Promise<{ id: string; reused?: boolean }>;
  list(userId: string, limit: number, cursor?: HistoryCursor): Promise<StoredHistoryPage>;
  findById(userId: string, id: string, signal?: AbortSignal): Promise<unknown | null>;
  findIdByAnalysisFingerprint?(userId: string, analysisFingerprint: string, signal?: AbortSignal): Promise<unknown | null>;
}

interface HistoryCursor {
  createdAt: string;
  id: string;
}

const historyCursorSchema = z.object({
  createdAt: z.string().datetime({ offset: true }),
  id: z.string().uuid(),
}).strict();

export type DiagnosticHistoryErrorCode =
  | "HISTORY_REQUEST_INVALID"
  | "HISTORY_ID_INVALID"
  | "HISTORY_NOT_FOUND"
  | "HISTORY_DATA_INVALID"
  | "HISTORY_UNAVAILABLE";

export class DiagnosticHistoryError extends Error {
  constructor(public readonly code: DiagnosticHistoryErrorCode) {
    super(code);
    this.name = "DiagnosticHistoryError";
  }
}

function encodeCursor(cursor: HistoryCursor) {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string | undefined): HistoryCursor | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = historyCursorSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    if (encodeCursor(parsed) !== value) throw new Error("non-canonical cursor");
    return parsed;
  } catch {
    throw new DiagnosticHistoryError("HISTORY_REQUEST_INVALID");
  }
}

export function parseHistoryListQuery(value: unknown) {
  const parsed = z.object({
    limit: z.union([z.string(), z.number()]).optional(),
    cursor: z.string().min(1).max(512).optional(),
  }).strict().safeParse(value);
  if (!parsed.success) throw new DiagnosticHistoryError("HISTORY_REQUEST_INVALID");
  const limit = parsed.data.limit === undefined ? DEFAULT_HISTORY_PAGE_SIZE : Number(parsed.data.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_HISTORY_PAGE_SIZE) {
    throw new DiagnosticHistoryError("HISTORY_REQUEST_INVALID");
  }
  return { limit, cursor: decodeCursor(parsed.data.cursor) };
}

function sanitizeRagMetadata(value: RagMetadata): RagMetadata {
  const cleanSources = value.sources.flatMap((source) => {
    const safeUrl = source.url === undefined ? undefined : normalizeSafeHttpsUrl(source.url);
    if (
      (source.url !== undefined && safeUrl === undefined) ||
      containsSensitiveText(source.title, "source_text") ||
      containsSensitiveText(source.label, "source_text") ||
      containsSensitiveText(source.excerpt, "source_text")
    ) return [];
    return [{
      ...source,
      ...(safeUrl === undefined ? {} : { url: safeUrl }),
    }];
  });
  if (containsSensitiveText(value.querySummary, "source_text")) {
    throw new DiagnosticHistoryError("HISTORY_DATA_INVALID");
  }
  if (value.status === "used" && cleanSources.length === 0) {
    return ragMetadataSchema.parse({
      enabled: true,
      used: false,
      status: "unavailable",
      querySummary: "La evidencia recuperada no estuvo disponible para el historial.",
      sources: [],
    });
  }
  return ragMetadataSchema.parse({ ...value, sources: cleanSources });
}

function sameAnalysisReport(left: DiagnosticAnalysisInput, right: DiagnosticAnalysisInput) {
  const withoutObservations = ({ observations: _observations, ...report }: DiagnosticAnalysisInput) => {
    void _observations;
    return report;
  };
  return JSON.stringify(withoutObservations(left)) === JSON.stringify(withoutObservations(right));
}

function analysisOutputMatchesInput(
  input: DiagnosticAnalysisInput,
  output: DiagnosticAnalysisOutput,
) {
  const identity = (value: { code: string; moduleCode: string | null; moduleName: string }) =>
    JSON.stringify([value.moduleCode, value.moduleName, value.code]);
  const inputIdentities = new Set(input.modules.flatMap((module) =>
    module.dtcs.map((dtc) => identity({ code: dtc.code, moduleCode: module.code, moduleName: module.name })),
  ));
  const findingIdentities = output.findings.flatMap((finding) =>
    finding.relatedDtc === null ? [] : [identity(finding.relatedDtc)],
  );
  const correlationIdentities = output.observationCorrelation.matches.map((match) => identity(match.relatedDtc));
  const correlationStatusIsInvalid = input.observations === undefined
    ? output.observationCorrelation.status !== "not_provided"
    : output.observationCorrelation.status === "not_provided";
  return !correlationStatusIsInvalid
    && findingIdentities.every((value) => inputIdentities.has(value))
    && new Set(findingIdentities).size === findingIdentities.length
    && correlationIdentities.every((value) => inputIdentities.has(value))
    && new Set(correlationIdentities).size === correlationIdentities.length;
}

function countsMatch(
  left: { detected: number; actionable: number; historical: number },
  right: { detected: number; actionable: number; historical: number },
) {
  return left.detected === right.detected
    && left.actionable === right.actionable
    && left.historical === right.historical;
}

export function buildHistoryInsertRecord(raw: HistorySaveInput): HistoryInsertRecord {
  const context = historyCaptureContextSchema.safeParse(raw.context);
  const input = diagnosticAnalysisInputSchema.safeParse(raw.input);
  const analysis = diagnosticAnalysisOutputSchema.safeParse(raw.analysis);
  const analysisModel = nonBlank(100).safeParse(raw.analysisModel);
  const embeddingModel = raw.embeddingModel === null ? { success: true as const, data: null } : nonBlank(100).safeParse(raw.embeddingModel);
  const contentFingerprint = z.string().regex(/^pdf_v1_[0-9a-f]{64}$/u).nullable()
    .safeParse(raw.contentFingerprint ?? null);
  const analysisFingerprint = z.string().regex(/^analysis_v1_[0-9a-f]{64}$/u).nullable()
    .safeParse(raw.analysisFingerprint ?? null);
  if (
    !context.success || !input.success || !analysis.success || !analysisModel.success ||
    !embeddingModel.success || !contentFingerprint.success || !analysisFingerprint.success ||
    ((contentFingerprint.success && contentFingerprint.data === null) !==
      (analysisFingerprint.success && analysisFingerprint.data === null))
  ) {
    throw new DiagnosticHistoryError("HISTORY_DATA_INVALID");
  }
  const preparation = prepareAiAnalysis(context.data.extraction);
  if (!preparation.available || !sameAnalysisReport(preparation.input, input.data)) {
    throw new DiagnosticHistoryError("HISTORY_DATA_INVALID");
  }

  const rag = sanitizeRagMetadata(ragMetadataSchema.parse(raw.rag));
  if (
    !analysisOutputMatchesInput(input.data, analysis.data) ||
    containsSensitiveText(analysisModel.data, "structured_identifier") ||
    (embeddingModel.data !== null && containsSensitiveText(embeddingModel.data, "structured_identifier")) ||
    (rag.used && embeddingModel.data === null)
  ) {
    throw new DiagnosticHistoryError("HISTORY_DATA_INVALID");
  }
  const { vinMasked, vinPseudonym, ...vehicleWithoutVin } = context.data.extraction.vehicle;
  const extractionSnapshot = historyExtractionSnapshotSchema.parse({
    status: context.data.extraction.status,
    format: context.data.extraction.format,
    requiresManualReview: context.data.extraction.requiresManualReview,
    vehicle: { ...vehicleWithoutVin, vinMasked, vinPseudonym: null },
    scanSummary: { ...context.data.extraction.scanSummary },
    systems: context.data.extraction.systems.map((system) => ({ ...system })),
    dtcs: context.data.extraction.dtcs.map((dtc) => ({ ...dtc })),
    warnings: context.data.extraction.warnings.map((warning) => ({ ...warning })),
  });
  const submittedObservations = input.data.observations ?? "";
  const analysisSnapshot = historyAnalysisSnapshotSchema.parse({
    input: input.data,
    counts: preparation.counts,
    output: analysis.data,
    submittedObservations,
  });
  const scanCandidate = {
    extraction: {
      ...extractionSnapshot,
      vehicle: { ...extractionSnapshot.vehicle, vinMasked: null, vinPseudonym: null },
    },
    analysis: analysisSnapshot,
  };
  if (containsSensitiveValue(scanCandidate, "source_text")) {
    throw new DiagnosticHistoryError("HISTORY_DATA_INVALID");
  }

  const vinLast4 = vinMasked?.slice(-4) ?? null;
  return {
    reportReference: context.data.reportReference,
    contentFingerprint: contentFingerprint.data,
    analysisFingerprint: analysisFingerprint.data,
    make: input.data.vehicle.make,
    model: input.data.vehicle.model,
    year: input.data.vehicle.year,
    odometer: extractionSnapshot.vehicle.odometer,
    vinHmac: vinPseudonym,
    vinLast4,
    dtcCodes: context.data.extraction.dtcs.map((dtc) => dtc.code),
    ragStatus: rag.status,
    extractionSnapshot,
    analysisSnapshot,
    ragSnapshot: rag,
    analysisModel: analysisModel.data,
    embeddingModel: rag.used ? embeddingModel.data : null,
  };
}

function listItem(row: z.infer<typeof storedListRowSchema>): HistoryListItem {
  const item = historyListItemSchema.parse({
    id: row.id,
    createdAt: row.created_at,
    reportReference: row.report_reference,
    vehicle: { make: row.make, model: row.model, year: row.year },
    odometer: row.odometer_value === null ? null : { value: row.odometer_value, unit: row.odometer_unit },
    dtcCount: row.dtc_count,
    ragStatus: row.rag_status,
  });
  if (
    containsSensitiveText(item.vehicle.make, "structured_identifier") ||
    containsSensitiveText(item.vehicle.model, "structured_identifier")
  ) throw new DiagnosticHistoryError("HISTORY_DATA_INVALID");
  return item;
}

export class DiagnosticHistoryService {
  constructor(private readonly repository: DiagnosticHistoryRepository) {}

  async save(userId: string, input: HistorySaveInput, signal?: AbortSignal) {
    if (!z.string().uuid().safeParse(userId).success) throw new DiagnosticHistoryError("HISTORY_DATA_INVALID");
    const record = buildHistoryInsertRecord(input);
    try {
      const saved = z.object({ id: z.string().uuid(), reused: z.boolean().optional().default(false) }).strict().parse(
        await this.repository.insert(userId, record, signal),
      );
      return saved;
    } catch (error) {
      if (error instanceof DiagnosticHistoryError) throw error;
      throw new DiagnosticHistoryError("HISTORY_UNAVAILABLE");
    }
  }

  async findByAnalysisFingerprint(userId: string, analysisFingerprint: string, signal?: AbortSignal): Promise<HistoryDetail | null> {
    if (
      !z.string().uuid().safeParse(userId).success ||
      !z.string().regex(/^analysis_v1_[0-9a-f]{64}$/u).safeParse(analysisFingerprint).success
    ) throw new DiagnosticHistoryError("HISTORY_DATA_INVALID");
    if (!this.repository.findIdByAnalysisFingerprint) return null;
    let value: unknown | null;
    try {
      signal?.throwIfAborted();
      value = await this.repository.findIdByAnalysisFingerprint(userId, analysisFingerprint, signal);
      signal?.throwIfAborted();
    } catch {
      throw new DiagnosticHistoryError("HISTORY_UNAVAILABLE");
    }
    if (value === null) return null;
    const parsed = z.object({ id: z.string().uuid() }).strict().safeParse(value);
    if (!parsed.success) throw new DiagnosticHistoryError("HISTORY_DATA_INVALID");
    return this.get(userId, parsed.data.id, signal);
  }

  async list(userId: string, query: ReturnType<typeof parseHistoryListQuery>) {
    if (!z.string().uuid().safeParse(userId).success) throw new DiagnosticHistoryError("HISTORY_DATA_INVALID");
    let page: StoredHistoryPage;
    try {
      page = await this.repository.list(userId, query.limit, query.cursor);
    } catch {
      throw new DiagnosticHistoryError("HISTORY_UNAVAILABLE");
    }
    const parsedRows = z.array(storedListRowSchema).max(query.limit).safeParse(page.rows);
    if (!parsedRows.success) throw new DiagnosticHistoryError("HISTORY_DATA_INVALID");
    const items = parsedRows.data.map(listItem);
    const last = items.at(-1);
    return {
      items,
      nextCursor: page.hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
    };
  }

  async get(userId: string, id: string, signal?: AbortSignal): Promise<HistoryDetail> {
    if (!z.string().uuid().safeParse(userId).success) throw new DiagnosticHistoryError("HISTORY_DATA_INVALID");
    if (!z.string().uuid().safeParse(id).success) throw new DiagnosticHistoryError("HISTORY_ID_INVALID");
    let value: unknown | null;
    try {
      signal?.throwIfAborted();
      value = await this.repository.findById(userId, id, signal);
      signal?.throwIfAborted();
    } catch {
      throw new DiagnosticHistoryError("HISTORY_UNAVAILABLE");
    }
    if (value === null) throw new DiagnosticHistoryError("HISTORY_NOT_FOUND");
    const row = storedDetailRowSchema.safeParse(value);
    if (!row.success) throw new DiagnosticHistoryError("HISTORY_DATA_INVALID");
    const sanitizedRag = sanitizeRagMetadata(row.data.rag_snapshot);
    if (JSON.stringify(sanitizedRag) !== JSON.stringify(row.data.rag_snapshot)) {
      throw new DiagnosticHistoryError("HISTORY_DATA_INVALID");
    }
    const preparation = prepareAiAnalysis(row.data.extraction_snapshot);
    if (
      !preparation.available ||
      !sameAnalysisReport(preparation.input, row.data.analysis_snapshot.input) ||
      !countsMatch(preparation.counts, row.data.analysis_snapshot.counts) ||
      row.data.analysis_snapshot.submittedObservations !== (row.data.analysis_snapshot.input.observations ?? "") ||
      !analysisOutputMatchesInput(row.data.analysis_snapshot.input, row.data.analysis_snapshot.output) ||
      row.data.make !== row.data.analysis_snapshot.input.vehicle.make ||
      row.data.model !== row.data.analysis_snapshot.input.vehicle.model ||
      row.data.year !== row.data.analysis_snapshot.input.vehicle.year ||
      row.data.dtc_count !== row.data.extraction_snapshot.dtcs.length ||
      row.data.rag_status !== row.data.rag_snapshot.status ||
      (row.data.odometer_value === null
        ? row.data.extraction_snapshot.vehicle.odometer !== null
        : row.data.odometer_value !== row.data.extraction_snapshot.vehicle.odometer?.value ||
          row.data.odometer_unit !== row.data.extraction_snapshot.vehicle.odometer.unit) ||
      (row.data.rag_snapshot.used !== (row.data.embedding_model !== null)) ||
      containsSensitiveText(row.data.analysis_model, "structured_identifier") ||
      (row.data.embedding_model !== null && containsSensitiveText(row.data.embedding_model, "structured_identifier"))
    ) {
      throw new DiagnosticHistoryError("HISTORY_DATA_INVALID");
    }
    const detail = historyDetailSchema.safeParse({
      ...listItem(row.data),
      analysisModel: row.data.analysis_model,
      embeddingModel: row.data.embedding_model,
      schemaVersion: row.data.schema_version,
      snapshot: {
        extraction: row.data.extraction_snapshot,
        analysis: row.data.analysis_snapshot,
        rag: row.data.rag_snapshot,
      },
    });
    if (!detail.success || containsSensitiveValue({
      extraction: {
        ...row.data.extraction_snapshot,
        vehicle: { ...row.data.extraction_snapshot.vehicle, vinMasked: null, vinPseudonym: null },
      },
      analysis: row.data.analysis_snapshot,
    }, "source_text")) {
      throw new DiagnosticHistoryError("HISTORY_DATA_INVALID");
    }
    return detail.data;
  }
}

const LIST_COLUMNS = "id, created_at, report_reference, make, model, year, odometer_value, odometer_unit, dtc_count, rag_status";
const DETAIL_COLUMNS = `${LIST_COLUMNS}, extraction_snapshot, analysis_snapshot, rag_snapshot, analysis_model, embedding_model, schema_version`;

export class SupabaseDiagnosticHistoryRepository implements DiagnosticHistoryRepository {
  constructor(private readonly client: SupabaseClient) {}

  async insert(userId: string, record: HistoryInsertRecord, signal?: AbortSignal) {
    const safeUserId = z.string().uuid().parse(userId);
    let query = this.client.from("diagnostic_history").insert({
      user_id: safeUserId,
      report_reference: record.reportReference,
      content_fingerprint: record.contentFingerprint,
      analysis_fingerprint: record.analysisFingerprint,
      make: record.make,
      model: record.model,
      year: record.year,
      odometer_value: record.odometer?.value ?? null,
      odometer_unit: record.odometer?.unit ?? null,
      vin_hmac: record.vinHmac,
      vin_last4: record.vinLast4,
      dtc_codes: record.dtcCodes,
      dtc_count: record.dtcCodes.length,
      rag_status: record.ragStatus,
      extraction_snapshot: record.extractionSnapshot,
      analysis_snapshot: record.analysisSnapshot,
      rag_snapshot: record.ragSnapshot,
      analysis_model: record.analysisModel,
      embedding_model: record.embeddingModel,
      schema_version: HISTORY_SCHEMA_VERSION,
    }).select("id");
    if (signal) query = query.abortSignal(signal);
    const { data, error } = await query.single();
    if (error) {
      const errorCode = typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : "";
      if (errorCode === "23505" && record.analysisFingerprint !== null) {
        const winner = await this.findIdByAnalysisFingerprint(safeUserId, record.analysisFingerprint, signal);
        const parsedWinner = z.object({ id: z.string().uuid() }).strict().safeParse(winner);
        if (parsedWinner.success) return { id: parsedWinner.data.id, reused: true };
      }
      throw new Error("HISTORY_INSERT_FAILED");
    }
    return { ...data, reused: false };
  }

  async list(userId: string, limit: number, cursor?: HistoryCursor): Promise<StoredHistoryPage> {
    const safeUserId = z.string().uuid().parse(userId);
    const safeCursor = cursor === undefined ? undefined : historyCursorSchema.parse(cursor);
    let query = this.client.from("diagnostic_history")
      .select(LIST_COLUMNS)
      .eq("user_id", safeUserId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(limit + 1);
    if (safeCursor) {
      query = query.or(`created_at.lt.${safeCursor.createdAt},and(created_at.eq.${safeCursor.createdAt},id.lt.${safeCursor.id})`);
    }
    const { data, error } = await query;
    if (error || !Array.isArray(data)) throw new Error("HISTORY_LIST_FAILED");
    return { rows: data.slice(0, limit), hasMore: data.length > limit };
  }

  async findById(userId: string, id: string, signal?: AbortSignal) {
    const safeUserId = z.string().uuid().parse(userId);
    const safeId = z.string().uuid().parse(id);
    let query = this.client.from("diagnostic_history")
      .select(DETAIL_COLUMNS)
      .eq("user_id", safeUserId)
      .eq("id", safeId);
    if (signal) query = query.abortSignal(signal);
    const { data, error } = await query.maybeSingle();
    if (error) throw new Error("HISTORY_DETAIL_FAILED");
    return data;
  }

  async findIdByAnalysisFingerprint(userId: string, analysisFingerprint: string, signal?: AbortSignal) {
    const safeUserId = z.string().uuid().parse(userId);
    const safeFingerprint = z.string().regex(/^analysis_v1_[0-9a-f]{64}$/u).parse(analysisFingerprint);
    let query = this.client.from("diagnostic_history")
      .select("id")
      .eq("user_id", safeUserId)
      .eq("analysis_fingerprint", safeFingerprint);
    if (signal) query = query.abortSignal(signal);
    const { data, error } = await query.maybeSingle();
    if (error) throw new Error("HISTORY_LOOKUP_FAILED");
    return data;
  }
}
