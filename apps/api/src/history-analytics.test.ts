import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { ANALYTICS_LIMITS, csvRow, HistoryAnalyticsService, SupabaseHistoryAnalyticsRepository,
  type AnalyticsCursor, type HistoryAnalyticsRepository } from "./history-analytics.js";

const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";
const id = (n: number) => `33333333-3333-4333-8333-${n.toString(16).padStart(12, "0")}`;
const dtcs = [{ code: "P0300", moduleCode: "PCM", moduleName: "Motor", descriptionOriginal: "private-description", vin: "private-vin" },
  { code: "P0300", moduleCode: null, moduleName: "Segundo módulo", observations: "private-observation" }];
function row(n: number) { return { id: id(n), created_at: "2026-01-01T00:00:00.000Z", make: "Marca", model: "Modelo", year: 2025,
  dtc_count: 2, rag_status: "used" }; }
function repository(count = 1) {
  const rows = Array.from({ length: count }, (_, index) => row(count - index));
  const repo: HistoryAnalyticsRepository = {
    page: vi.fn(async (user, _cutoff, cursor) => user === A ? rows.filter(value => !cursor || value.id < cursor.id).slice(0, 26) : []),
    dtcs: vi.fn(async (user, ids) => user === A ? ids.map(id => ({ id, dtcs })) : []),
  };
  return { repo, rows };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("CSV analítico basado en historial persistido", () => {
  it("exporta dos conjuntos completos, identidad por módulo y cero campos privados", async () => {
    const { repo } = repository();
    const result = await new HistoryAnalyticsService(repo).export(A);
    expect(result.analysesCount).toBe(1); expect(result.dtcCount).toBe(2);
    const reference = result.analysesCsv.split("\r\n")[1]!.split(",")[0]!;
    expect(result.dtcsCsv.split("\r\n").slice(1, 3).every(line => line.startsWith(reference))).toBe(true);
    expect(result.dtcsCsv).toContain('"P0300","PCM","Motor"');
    expect(result.dtcsCsv).toContain('"P0300","","Segundo módulo"');
    for (const forbidden of [A, id(1), "private-", "vin", "observation", "description", "hash", "token"]) {
      expect(result.analysesCsv + result.dtcsCsv).not.toContain(forbidden);
    }
    expect(repo.page).toHaveBeenCalledOnce(); expect(repo.dtcs).toHaveBeenCalledOnce();
  });
  it("paginación keyset completa: 26 análisis/52 DTC, mismo corte y usuario", async () => {
    const { repo } = repository(26);
    const result = await new HistoryAnalyticsService(repo).export(A);
    expect(result.analysesCount).toBe(26); expect(result.dtcCount).toBe(52);
    expect(repo.page).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(repo.page).mock.calls;
    expect(calls.every(call => call[0] === A && call[1] === result.cutoff)).toBe(true);
    expect(calls[1]![2]).toEqual({ createdAt: row(2).created_at, id: id(2) });
    expect(vi.mocked(repo.dtcs).mock.calls.every(call => call[0] === A && call[1].length <= 25)).toBe(true);
  });
  it("historial vacío produce headers sin inventar registros", async () => {
    const { repo } = repository(0);
    const result = await new HistoryAnalyticsService(repo).export(A);
    expect(result.analysesCount).toBe(0); expect(result.dtcCount).toBe(0);
    expect(result.analysesCsv.split("\r\n")).toHaveLength(2);
    expect(repo.dtcs).not.toHaveBeenCalled();
  });
  it("preserva microsegundos PostgreSQL y no confunde orden temporal con orden UUID", async () => {
    const { repo } = repository(2);
    vi.mocked(repo.page).mockResolvedValueOnce([
      { ...row(1), created_at: "2026-01-01T01:00:00.000002+01:00" },
      { ...row(2), created_at: "2026-01-01T00:00:00.000001Z" },
    ]);
    const result = await new HistoryAnalyticsService(repo).export(A);
    expect(result.analysesCount).toBe(2);
    expect(result.analysesCsv).toContain("2026-01-01T00:00:00.000002Z");
    expect(result.analysesCsv).toContain("2026-01-01T00:00:00.000001Z");
  });
  it("superar el máximo no devuelve una selección parcial", async () => {
    const { repo } = repository(201);
    await expect(new HistoryAnalyticsService(repo).export(A)).rejects.toMatchObject({ code: "ANALYTICS_LIMIT" });
    expect(vi.mocked(repo.page).mock.calls.length).toBeLessThanOrEqual(8);
  });
  it("admite exactamente 200 análisis sin omitir la última página", async () => {
    const { repo } = repository(200);
    const result = await new HistoryAnalyticsService(repo).export(A);
    expect(result.analysesCount).toBe(200); expect(result.dtcCount).toBe(400);
    expect(repo.page).toHaveBeenCalledTimes(8);
  });
  it("exceso de DTC por análisis se rechaza antes de leer el JSON persistido", async () => {
    const { repo } = repository();
    vi.mocked(repo.page).mockResolvedValueOnce([{ ...row(1), dtc_count: 501 }]);
    await expect(new HistoryAnalyticsService(repo).export(A)).rejects.toMatchObject({ code: "ANALYTICS_LIMIT" });
    expect(repo.dtcs).not.toHaveBeenCalled();
  });
  it.each(["dtc-total", "utf8-bytes"])("rechaza completo al exceder %s", async mode => {
    const count = mode === "dtc-total" ? 21 : 12;
    const { repo } = repository(count);
    vi.mocked(repo.page).mockResolvedValueOnce(Array.from({ length: count }, (_, i) => ({ ...row(count - i), dtc_count: 500 })));
    const dtc = mode === "dtc-total" ? dtcs[0]! : { code: "測".repeat(32), moduleCode: "測".repeat(32), moduleName: "測".repeat(160) };
    vi.mocked(repo.dtcs).mockImplementation(async (_user, ids) => ids.map(id => ({ id, dtcs: Array(500).fill(dtc) })));
    await expect(new HistoryAnalyticsService(repo).export(A)).rejects.toMatchObject({ code: "ANALYTICS_LIMIT" });
  });
  it.each(["bad-page", "duplicate-page", "missing-detail", "wrong-detail", "count-mismatch", "later-error"])("falla cerrado: %s", async mode => {
    const { repo } = repository(mode === "later-error" ? 26 : 1);
    if (mode === "bad-page") vi.mocked(repo.page).mockResolvedValueOnce([{}]);
    if (mode === "duplicate-page") vi.mocked(repo.page).mockResolvedValueOnce([row(1), row(1)]);
    if (mode === "missing-detail") vi.mocked(repo.dtcs).mockResolvedValueOnce([]);
    if (mode === "wrong-detail") vi.mocked(repo.dtcs).mockResolvedValueOnce([{ id: id(99), dtcs }]);
    if (mode === "count-mismatch") vi.mocked(repo.dtcs).mockResolvedValueOnce([{ id: id(1), dtcs: [] }]);
    if (mode === "later-error") vi.mocked(repo.page).mockImplementationOnce(async () => Array.from({ length: 26 }, (_, i) => row(26 - i)))
      .mockRejectedValueOnce(new Error("private transport error"));
    await expect(new HistoryAnalyticsService(repo).export(A)).rejects.toHaveProperty("code");
  });
  it.each(["persona@example.test", "55551234", "reporte-cliente.pdf", "sk-proj-synthetic-private-key-123456"])("rechaza campo técnico contaminado sin omitir la fila: %s", async make => {
    const { repo } = repository();
    vi.mocked(repo.page).mockResolvedValueOnce([{ ...row(1), make }]);
    await expect(new HistoryAnalyticsService(repo).export(A)).rejects.toMatchObject({ code: "ANALYTICS_INVALID" });
    expect(repo.dtcs).not.toHaveBeenCalled();
  });
  it("CSV UTF-8 BOM, comillas, separadores y fórmulas quedan protegidos", async () => {
    expect(csvRow(['=HYPERLINK("x")', "+1", "-1", "@x", "  =1", 'a,"b"', null]))
      .toBe('"\'=HYPERLINK(""x"")","\'+1","\'-1","\'@x","\'  =1","a,""b""",""\r\n');
    const { repo } = repository(); vi.mocked(repo.page).mockResolvedValueOnce([{ ...row(1), model: "=1+1" }]);
    const result = await new HistoryAnalyticsService(repo).export(A);
    expect(result.analysesCsv.startsWith("\uFEFF")).toBe(true);
    expect(result.analysesCsv).toContain('"\'=1+1"');
  });
  it("timeout/cancelación conservan capacidad hasta finalizar transporte y observan rechazo tardío", async () => {
    vi.useFakeTimers();
    let reject!: (error: Error) => void;
    const pending = new Promise<unknown[]>((_resolve, fail) => { reject = fail; });
    const repo = { page: vi.fn(async () => pending), dtcs: vi.fn() };
    const service = new HistoryAnalyticsService(repo);
    const one = service.export(A), two = service.export(A);
    const assertions = Promise.all([expect(one).rejects.toMatchObject({ code: "ANALYTICS_UNAVAILABLE" }),
      expect(two).rejects.toMatchObject({ code: "ANALYTICS_UNAVAILABLE" })]);
    await vi.advanceTimersByTimeAsync(ANALYTICS_LIMITS.timeoutMs); await assertions;
    await expect(service.export(A)).rejects.toMatchObject({ code: "ANALYTICS_LIMIT" });
    reject(new Error("synthetic late failure"));
    for (let i = 0; i < 10; i++) await Promise.resolve();
    repo.page.mockResolvedValue([]);
    expect((await service.export(A)).analysesCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    const controller = new AbortController(); controller.abort();
    await expect(service.export(A, controller.signal)).rejects.toMatchObject({ code: "ANALYTICS_UNAVAILABLE" });
  });
});

describe("HTTP y consultas reales del adaptador (transporte simulado)", () => {
  it("autenticación y aislamiento A/B; query user_id rechazada; respuesta no cacheable", async () => {
    const { repo } = repository();
    const app = createApp({ vinHmacSecret: "synthetic-analytics-secret-at-least-32-bytes",
      historyAnalyticsService: new HistoryAnalyticsService(repo), authenticationService: {
        login: vi.fn(), authenticate: async token => ({ id: token === "B" ? B : A, username: "synthetic" }),
      } });
    expect((await request(app).get("/api/history/export")).status).toBe(401);
    expect(repo.page).not.toHaveBeenCalled();
    expect((await request(app).get(`/api/history/export?user_id=${B}`).set("Authorization", "Bearer A")).status).toBe(400);
    expect(repo.page).not.toHaveBeenCalled();
    expect((await request(app).get("/api/history/export").set("Authorization", "Bearer A").send({ user_id: B })).status).toBe(400);
    expect(repo.page).not.toHaveBeenCalled();
    const a = await request(app).get("/api/history/export").set("Authorization", "Bearer A");
    const b = await request(app).get("/api/history/export").set("Authorization", "Bearer B");
    expect(a.status).toBe(200); expect(a.body.analysesCount).toBe(1);
    expect(b.status).toBe(200); expect(b.body.analysesCount).toBe(0);
    expect(a.headers["cache-control"]).toBe("no-store");
    expect(vi.mocked(repo.page).mock.calls.map(call => call[0])).toEqual([A, B]);
    vi.mocked(repo.page).mockRejectedValueOnce(new Error("PRIVATE_MESSAGE"));
    const failed = await request(app).get("/api/history/export").set("Authorization", "Bearer A");
    expect(failed.status).toBe(502); expect(JSON.stringify(failed.body)).not.toContain("PRIVATE_MESSAGE");
    expect(failed.body).not.toHaveProperty("analysesCsv");
  });
  it("cada consulta usa user_id validado y proyección persistida, con límite/abort/cursor", async () => {
    const query = { select: vi.fn(), eq: vi.fn(), lte: vi.fn(), order: vi.fn(), limit: vi.fn(), or: vi.fn(), in: vi.fn(),
      abortSignal: vi.fn(async () => ({ data: [], error: null, count: 0 })) };
    for (const key of ["select", "eq", "lte", "order", "limit", "or", "in"] as const) query[key].mockReturnValue(query);
    const from = vi.fn(() => query);
    const repository = new SupabaseHistoryAnalyticsRepository({ from } as never);
    const signal = new AbortController().signal, cutoff = "2026-01-01T00:00:00.000Z";
    const cursor: AnalyticsCursor = { createdAt: cutoff, id: id(1) };
    await repository.page(A, cutoff, cursor, signal); await repository.dtcs(A, [id(1)], signal);
    expect(query.eq.mock.calls).toEqual([["user_id", A], ["user_id", A]]);
    expect(query.select.mock.calls).toEqual([["id,created_at,make,model,year,dtc_count,rag_status", { count: "exact" }], ["id,dtcs:extraction_snapshot->dtcs"]]);
    expect(query.limit).toHaveBeenCalledWith(26); expect(query.lte).toHaveBeenCalledWith("created_at", cutoff);
    expect(query.or).toHaveBeenCalledWith(`created_at.lt.${cutoff},and(created_at.eq.${cutoff},id.lt.${id(1)})`);
    expect(query.abortSignal).toHaveBeenCalledTimes(2);
    await expect(repository.dtcs("browser-injected", [id(1)], signal)).rejects.toThrow();
    expect(from).toHaveBeenCalledTimes(2);
  });
  it.each([null, 5, 100])("count exact ausente o truncamiento del servidor no se acepta como exportación completa: %s", async count => {
    const query = { select: vi.fn(), eq: vi.fn(), lte: vi.fn(), order: vi.fn(), limit: vi.fn(),
      abortSignal: vi.fn(async () => ({ data: [], error: null, count })) };
    for (const key of ["select", "eq", "lte", "order", "limit"] as const) query[key].mockReturnValue(query);
    const repo = new SupabaseHistoryAnalyticsRepository({ from: () => query } as never);
    await expect(repo.page(A, "2026-01-01T00:00:00.000Z", undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: "ANALYTICS_UNAVAILABLE" });
  });
});
