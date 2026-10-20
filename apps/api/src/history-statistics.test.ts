import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { createApp } from "./app.js";
import { HistoryAnalyticsService, type AnalyticsRecord, type HistoryAnalyticsRepository } from "./history-analytics.js";
import { aggregateStatistics, guatemalaDay, statisticsFilters } from "./history-statistics.js";

const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";
const dtc = { code: "P0300", moduleCode: "PCM", moduleName: "Motor" };
const row: AnalyticsRecord = { id: A, created_at: "2026-01-02T05:59:59Z", make: "Marca", model: "Modelo",
  year: 2025, dtc_count: 3, rag_status: "used", dtcs: [dtc, dtc, { ...dtc, moduleCode: null }] };
const second: AnalyticsRecord = { ...row, id: B, created_at: "2026-01-02T06:00:00Z", make: "Otra",
  dtc_count: 1, dtcs: [{ ...dtc, code: "P0171" }] };
const aggregate = (filters = {}) => aggregateStatistics([second, row], "2026-02-01T00:00:00Z", filters);
describe("estadísticas agregadas del historial autenticado", () => {
  it("deduplica por análisis, mantiene identidad completa de módulos y conteos de registros", () => {
    const result = aggregate();
    expect(result).toMatchObject({ totalAnalyses: 2, dtcRecords: 4, distinctCodes: 2 });
    expect(result.codes).toEqual([{ code: "P0171", count: 1 }, { code: "P0300", count: 1 }]);
    expect(result.modules).toContainEqual({ moduleCode: "PCM", moduleName: "Motor", count: 2 });
    expect(result.modules).toContainEqual({ moduleCode: null, moduleName: "Motor", count: 1 });
    expect(result.analyses.reduce((sum, r) => sum + r.dtcCount, 0)).toBe(result.dtcRecords);
    expect(result.dates.reduce((sum, r) => sum + r.count, 0)).toBe(result.totalAnalyses);
    expect(result.vehicles.reduce((sum, r) => sum + r.count, 0)).toBe(result.totalAnalyses);
  });
  it("mismo código con nombre distinto conserva módulos independientes", () => {
    const result = aggregateStatistics([{ ...row, dtcs: [dtc, { ...dtc, moduleName: "Otro" }] }], row.created_at, {});
    expect(result.modules).toHaveLength(2); expect(result.codes).toEqual([{ code: "P0300", count: 1 }]);
  });
  it("corte de fecha Guatemala y extremos inclusivos", () => {
    expect(guatemalaDay(row.created_at)).toBe("2026-01-01");
    expect(guatemalaDay(second.created_at)).toBe("2026-01-02");
    expect(aggregate({ from: "2026-01-01", to: "2026-01-01" }).analyses.map(r => r.id)).toEqual([A]);
    expect(aggregate({ from: "2026-01-02" }).totalAnalyses).toBe(1);
  });
  it("filtros combinados exactos y selección vacía", () => {
    expect(aggregate({ make: "Marca", model: "Modelo" }).totalAnalyses).toBe(1);
    expect(aggregate({ make: "Marca", model: "Otro" })).toMatchObject({ totalAnalyses: 0, dtcRecords: 0, distinctCodes: 0 });
  });
  it.each([{ user_id: A }, { from: "2026-02-30" }, { from: ["2026-01-01"] },
    { from: "2026-02-01", to: "2026-01-01" }, { model: "x".repeat(121) }])("rechaza filtro %j", filter => {
    expect(statisticsFilters.safeParse(filter).success).toBe(false);
  });
  it("ruta real autentica, rechaza identidad del navegador, no llama proveedores y solo devuelve DTO", async () => {
    const repo: HistoryAnalyticsRepository = {
      page: vi.fn(async user => user === A ? [{ ...row, dtcs: undefined }].map(({ dtcs: _dtcs, ...r }) => { void _dtcs; return r; }) : []),
      dtcs: vi.fn(async (user, ids) => user === A ? ids.map(id => ({ id, dtcs: row.dtcs.map(d => ({ ...d, descriptionOriginal: "PRIVATE" })) })) : []),
    };
    const analyze = vi.fn(), retrieve = vi.fn();
    const app = createApp({
      vinHmacSecret: "synthetic-statistics-secret-at-least-32-bytes",
      authenticationService: { authenticate: vi.fn(async (token: string) => ({ id: token === "A" ? A : B })) } as never,
      historyAnalyticsService: new HistoryAnalyticsService(repo),
      analysisService: { analyze } as never, ragService: { retrieve } as never,
    });
    expect((await request(app).get("/api/history/statistics")).status).toBe(401);
    expect((await request(app).get(`/api/history/statistics?user_id=${B}`).set("Authorization", "Bearer A")).status).toBe(400);
    const a = await request(app).get("/api/history/statistics").set("Authorization", "Bearer A");
    const b = await request(app).get("/api/history/statistics").set("Authorization", "Bearer B");
    expect(a.status).toBe(200); expect(a.body.totalAnalyses).toBe(1); expect(b.body.totalAnalyses).toBe(0);
    expect(a.headers["cache-control"]).toBe("no-store");
    expect(JSON.stringify(a.body)).not.toMatch(/PRIVATE|user_id|vin|observations|snapshot|hash|dtcsCsv/u);
    expect(repo.page).toHaveBeenCalledTimes(2); expect(repo.dtcs).toHaveBeenCalledWith(A, [A], expect.any(AbortSignal));
    expect(analyze).not.toHaveBeenCalled(); expect(retrieve).not.toHaveBeenCalled();
  });
  it("records conserva protecciones CSV: detalle faltante se rechaza sin resultado parcial", async () => {
    const { dtcs: _dtcs, ...metadata } = row; void _dtcs;
    const service = new HistoryAnalyticsService({ page: async () => [metadata], dtcs: async () => [] });
    await expect(service.records(A)).rejects.toMatchObject({ code: "ANALYTICS_INVALID" });
  });
  it.each([26, 201])("lectura de estadísticas completa o rechazo por límite: %i", async count => {
    const { dtcs: _dtcs, ...metadata } = row; void _dtcs;
    const rows = Array.from({ length: count }, (_, i) => ({ ...metadata,
      id: `33333333-3333-4333-8333-${(count - i).toString(16).padStart(12, "0")}` }));
    const repo: HistoryAnalyticsRepository = {
      page: vi.fn(async (_user, _cutoff, cursor) => rows.filter(r => !cursor || r.id < cursor.id).slice(0, 26)),
      dtcs: vi.fn(async (_user, ids) => ids.map(id => ({ id, dtcs: row.dtcs }))),
    };
    const service = new HistoryAnalyticsService(repo);
    if (count === 201) await expect(service.records(A)).rejects.toMatchObject({ code: "ANALYTICS_LIMIT" });
    else {
      const value = await service.records(A);
      expect(value.records).toHaveLength(26);
      expect(aggregateStatistics(value.records, value.cutoff, {}).dtcRecords).toBe(78);
      expect(repo.page).toHaveBeenCalledTimes(2);
    }
  });
});
