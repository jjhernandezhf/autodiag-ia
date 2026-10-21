import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { containsSensitiveText } from "./sensitive-data.js";
import { getSupabaseAdminClient } from "./supabase-admin-client.js";

export const ANALYTICS_LIMITS = { analyses: 200, dtcsPerAnalysis: 500, dtcs: 10_000,
  page: 25, bytes: 4 * 1024 * 1024, timeoutMs: 10_000, concurrent: 2 } as const;
const text = (max: number) => z.string().trim().min(1).max(max).refine(value =>
  [...value].every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127) &&
  !containsSensitiveText(value, "structured_identifier"));
const metadataSchema = z.object({ id: z.string().uuid(), created_at: z.string().max(40).datetime({ offset: true }),
  make: text(80), model: text(120), year: z.number().int().min(1886).max(9999),
  dtc_count: z.number().int().min(0).max(100_000),
  rag_status: z.enum(["used", "disabled", "not_configured", "no_matches", "unavailable"]) }).strict();
const dtcSchema = z.object({ code: text(32), moduleCode: text(32).nullable(), moduleName: text(160) });
const statisticsDtcSchema = dtcSchema.extend({
  descriptionOriginal: z.string().trim().max(1_000).refine(value =>
    [...value].every(c => (c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127) || c === "\n" || c === "\r" || c === "\t") &&
    !containsSensitiveText(value, "free_text")).nullable().optional(),
});
type Metadata = z.infer<typeof metadataSchema>;
export type AnalyticsRecord = Metadata & { dtcs: z.infer<typeof statisticsDtcSchema>[] };
// PostgreSQL timestamps preserve microseconds; Date.parse alone collapses distinct
// instants within one millisecond and can incorrectly reject keyset order.
function timestamp(value: string) {
  const fraction = /\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/u.exec(value)?.[1] ?? "";
  if (fraction.length > 6) throw new HistoryAnalyticsError("ANALYTICS_INVALID");
  const milliseconds = Date.parse(value);
  const microseconds = fraction.padEnd(6, "0");
  return { key: BigInt(Math.floor(milliseconds / 1000)) * 1_000_000n + BigInt(microseconds),
    utc: `${new Date(milliseconds).toISOString().slice(0, 19)}.${microseconds}Z` };
}
export interface AnalyticsCursor { createdAt: string; id: string }
export interface HistoryAnalyticsRepository {
  page(userId: string, cutoff: string, cursor: AnalyticsCursor | undefined, signal: AbortSignal): Promise<unknown[]>;
  dtcs(userId: string, ids: string[], signal: AbortSignal): Promise<unknown[]>;
}
export class HistoryAnalyticsError extends Error {
  constructor(public readonly code: "ANALYTICS_INVALID" | "ANALYTICS_LIMIT" | "ANALYTICS_UNAVAILABLE") { super(code); }
}
export function csvRow(values: (string | number | null)[]) {
  return values.map(value => {
    const raw = value === null ? "" : String(value);
    const safe = /^[\s\uFEFF]*[=+\-@]/u.test(raw) || /^[\t\r\n]/u.test(raw) ? `'${raw}` : raw;
    return `"${safe.replace(/"/gu, '""')}"`;
  }).join(",") + "\r\n";
}
export class SupabaseHistoryAnalyticsRepository implements HistoryAnalyticsRepository {
  constructor(private readonly client: SupabaseClient) {}
  async page(userId: string, cutoff: string, cursor: AnalyticsCursor | undefined, signal: AbortSignal) {
    const id = z.string().uuid().parse(userId);
    z.string().datetime({ offset: true }).parse(cutoff);
    let query = this.client.from("diagnostic_history")
      .select("id,created_at,make,model,year,dtc_count,rag_status", { count: "exact" }).eq("user_id", id)
      .lte("created_at", cutoff).order("created_at", { ascending: false }).order("id", { ascending: false })
      .limit(ANALYTICS_LIMITS.page + 1);
    if (cursor) {
      z.object({ createdAt: z.string().datetime({ offset: true }), id: z.string().uuid() }).strict().parse(cursor);
      query = query.or(`created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`);
    }
    const { data, error, count } = await query.abortSignal(signal);
    // A lower PostgREST server row cap must not masquerade as the last page.
    if (error || !Array.isArray(data) || typeof count !== "number" || !Number.isSafeInteger(count) || count < 0 ||
      data.length !== Math.min(count, ANALYTICS_LIMITS.page + 1)) throw new HistoryAnalyticsError("ANALYTICS_UNAVAILABLE");
    return data;
  }
  async dtcs(userId: string, ids: string[], signal: AbortSignal) {
    const id = z.string().uuid().parse(userId);
    z.array(z.string().uuid()).min(1).max(ANALYTICS_LIMITS.page).parse(ids);
    // Real persisted JSON path. No VIN/observations/analysis output columns selected.
    const { data, error } = await this.client.from("diagnostic_history")
      .select("id,dtcs:extraction_snapshot->dtcs").eq("user_id", id).in("id", ids).abortSignal(signal);
    if (error || !Array.isArray(data)) throw new HistoryAnalyticsError("ANALYTICS_UNAVAILABLE");
    return data;
  }
}
export class HistoryAnalyticsService {
  private active = 0;
  constructor(private readonly repository: HistoryAnalyticsRepository) {}
  async export(userId: string, parentSignal?: AbortSignal) {
    return this.run(userId, parentSignal);
  }
  async records(userId: string, parentSignal?: AbortSignal) {
    const records: AnalyticsRecord[] = [];
    const result = await this.run(userId, parentSignal, record => records.push(record));
    return { cutoff: result.cutoff, records };
  }
  private async run(userId: string, parentSignal?: AbortSignal, consume?: (record: AnalyticsRecord) => void) {
    z.string().uuid().parse(userId);
    if (parentSignal?.aborted) throw new HistoryAnalyticsError("ANALYTICS_UNAVAILABLE");
    if (this.active >= ANALYTICS_LIMITS.concurrent) throw new HistoryAnalyticsError("ANALYTICS_LIMIT");
    this.active++;
    const controller = new AbortController();
    let stop!: () => void;
    const stopped = new Promise<never>((_resolve, reject) => {
      stop = () => { controller.abort(); reject(new HistoryAnalyticsError("ANALYTICS_UNAVAILABLE")); };
    });
    const timer = setTimeout(stop, ANALYTICS_LIMITS.timeoutMs);
    parentSignal?.addEventListener("abort", stop, { once: true });
    const job = this.collect(userId, new Date().toISOString(), controller.signal, consume)
      .finally(() => { this.active--; }); // Capacity stays held if a transport ignores abort.
    try { return await Promise.race([job, stopped]); }
    catch (error) {
      if (error instanceof HistoryAnalyticsError) throw error;
      throw new HistoryAnalyticsError("ANALYTICS_INVALID");
    } finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", stop);
    }
  }
  private async collect(userId: string, cutoff: string, signal: AbortSignal, consume?: (record: AnalyticsRecord) => void) {
    let analysesCsv = "\uFEFF" + csvRow(["analysis_reference", "created_at", "make", "model", "year", "dtc_count", "rag_status"]);
    let dtcsCsv = "\uFEFF" + csvRow(["analysis_reference", "dtc_code", "module_code", "module_name"]);
    let bytes = Buffer.byteLength(analysesCsv + dtcsCsv);
    let analysesCount = 0, dtcCount = 0;
    let cursor: AnalyticsCursor | undefined;
    const seen = new Set<string>();
    for (;;) {
      signal.throwIfAborted();
      const raw = await this.repository.page(userId, cutoff, cursor, signal);
      signal.throwIfAborted();
      if (!Array.isArray(raw) || raw.length > ANALYTICS_LIMITS.page + 1) throw new HistoryAnalyticsError("ANALYTICS_INVALID");
      const parsed = raw.map(row => metadataSchema.parse(row));
      if (parsed.some(row => row.dtc_count > ANALYTICS_LIMITS.dtcsPerAnalysis)) throw new HistoryAnalyticsError("ANALYTICS_LIMIT");
      const hasMore = parsed.length > ANALYTICS_LIMITS.page;
      const page = parsed.slice(0, ANALYTICS_LIMITS.page);
      if (analysesCount + page.length > ANALYTICS_LIMITS.analyses ||
        (hasMore && analysesCount + page.length === ANALYTICS_LIMITS.analyses)) throw new HistoryAnalyticsError("ANALYTICS_LIMIT");
      let previous = cursor;
      for (const row of page) {
        const instant = timestamp(row.created_at).key;
        if (instant > timestamp(cutoff).key || seen.has(row.id) || (previous &&
          (instant > timestamp(previous.createdAt).key || (instant === timestamp(previous.createdAt).key && row.id >= previous.id)))) {
          throw new HistoryAnalyticsError("ANALYTICS_INVALID");
        }
        seen.add(row.id);
        previous = { createdAt: row.created_at, id: row.id };
      }
      if (page.length) {
        const details = await this.repository.dtcs(userId, page.map(row => row.id), signal);
        signal.throwIfAborted();
        if (!Array.isArray(details) || details.length !== page.length) throw new HistoryAnalyticsError("ANALYTICS_INVALID");
        const byId = new Map<string, unknown[]>();
        for (const detail of details) {
          const value = z.object({ id: z.string().uuid(), dtcs: z.array(z.unknown()).max(ANALYTICS_LIMITS.dtcsPerAnalysis) }).strict().parse(detail);
          if (byId.has(value.id) || !page.some(row => row.id === value.id)) throw new HistoryAnalyticsError("ANALYTICS_INVALID");
          byId.set(value.id, value.dtcs);
        }
        for (const row of page) {
          const dtcs = byId.get(row.id)!.map(value => consume ? statisticsDtcSchema.parse(value) : dtcSchema.parse(value));
          if (dtcs.length !== row.dtc_count) throw new HistoryAnalyticsError("ANALYTICS_INVALID");
          if (dtcCount + dtcs.length > ANALYTICS_LIMITS.dtcs) throw new HistoryAnalyticsError("ANALYTICS_LIMIT");
          const reference = consume ? "" : randomUUID(); // CSV-scoped surrogate.
          const analysisLine = consume ? "" : this.analysisLine(reference, row);
          const dtcLines = consume ? "" : dtcs.map(dtc => csvRow([reference, dtc.code, dtc.moduleCode, dtc.moduleName])).join("");
          bytes += Buffer.byteLength(consume ? JSON.stringify({ ...row, dtcs }) : analysisLine + dtcLines);
          if (bytes > ANALYTICS_LIMITS.bytes) throw new HistoryAnalyticsError("ANALYTICS_LIMIT");
          if (consume) consume({ ...row, dtcs });
          else { analysesCsv += analysisLine; dtcsCsv += dtcLines; }
          analysesCount++;
          dtcCount += dtcs.length;
        }
      }
      if (!hasMore) return { schemaVersion: 1 as const, cutoff, analysesCount, dtcCount, analysesCsv, dtcsCsv };
      cursor = previous;
    }
  }
  private analysisLine(reference: string, row: Metadata) {
    return csvRow([reference, timestamp(row.created_at).utc, row.make, row.model, row.year, row.dtc_count, row.rag_status]);
  }
}
export function createConfiguredHistoryAnalyticsService() {
  try { return new HistoryAnalyticsService(new SupabaseHistoryAnalyticsRepository(getSupabaseAdminClient())); }
  catch { return undefined; }
}
