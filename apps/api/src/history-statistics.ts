import { z } from "zod";
import type { AnalyticsRecord } from "./history-analytics.js";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).refine(value =>
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value);
// Comparison only: persisted names and aggregation keys retain their original spelling.
export function normalizeStatisticsName(value: string | undefined) {
  return (value ?? "").trim().toLowerCase();
}
export const statisticsFilters = z.object({
  from: day.optional(), to: day.optional(),
  make: z.string().max(80).optional(), model: z.string().max(120).optional(),
}).strict().refine(value => !value.from || !value.to || value.from <= value.to);
export function guatemalaDay(instant: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Guatemala",
    year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(instant));
}
export function aggregateStatistics(records: AnalyticsRecord[], cutoff: string, filters: z.infer<typeof statisticsFilters>) {
  const make = normalizeStatisticsName(filters.make), model = normalizeStatisticsName(filters.model);
  const selected = records.filter(row => {
    const date = guatemalaDay(row.created_at);
    return (!filters.from || date >= filters.from) && (!filters.to || date <= filters.to) &&
      (!make || normalizeStatisticsName(row.make) === make) && (!model || normalizeStatisticsName(row.model) === model);
  });
  const dates = new Map<string, number>(), vehicles = new Map<string, number>();
  const codes = new Map<string, number>(), modules = new Map<string, number>();
  const descriptions = new Map<string, Map<string, Set<string>>>();
  const add = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);
  for (const row of selected) {
    add(dates, guatemalaDay(row.created_at));
    add(vehicles, JSON.stringify([row.make, row.model]));
    for (const code of new Set(row.dtcs.map(dtc => dtc.code))) add(codes, code);
    for (const dtc of row.dtcs) {
      const variants = descriptions.get(dtc.code) ?? new Map<string, Set<string>>();
      const context = JSON.stringify([row.make, row.model, row.year, dtc.moduleCode, dtc.moduleName, dtc.descriptionOriginal || null]);
      const ids = variants.get(context) ?? new Set<string>();
      ids.add(row.id); variants.set(context, ids); descriptions.set(dtc.code, variants);
    }
    for (const module of new Set(row.dtcs.map(dtc => JSON.stringify([dtc.moduleCode, dtc.moduleName])))) add(modules, module);
  }
  const ranked = (map: Map<string, number>) => [...map].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return {
    schemaVersion: 1, cutoff, timeZone: "America/Guatemala", totalAnalyses: selected.length,
    dtcRecords: selected.reduce((sum, row) => sum + row.dtc_count, 0), distinctCodes: codes.size,
    dates: [...dates].sort(([a], [b]) => a.localeCompare(b)).map(([date, count]) => ({ date, count })),
    vehicles: ranked(vehicles).map(([key, count]) => { const [make, model] = JSON.parse(key) as string[]; return { make, model, count }; }),
    codes: ranked(codes).map(([code, count]) => ({ code, count,
      descriptions: [...(descriptions.get(code) ?? [])].map(([key, ids]) => {
        const [make, model, year, moduleCode, moduleName, description] = JSON.parse(key) as [string, string, number, string | null, string, string | null];
        return { make, model, year, moduleCode, moduleName, description, analysisIds: [...ids] };
      }),
    })),
    modules: ranked(modules).map(([key, count]) => {
      const [moduleCode, moduleName] = JSON.parse(key) as [string | null, string];
      return { moduleCode, moduleName, count };
    }),
    // Existing public history identifier, only for this authenticated user's detail route.
    analyses: selected.map(row => ({ id: row.id, date: guatemalaDay(row.created_at),
      make: row.make, model: row.model, year: row.year, dtcCount: row.dtc_count })),
  };
}
