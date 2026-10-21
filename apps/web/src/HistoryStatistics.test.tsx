// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HistoryStatistics } from "./HistoryStatistics";
import type { BrowserApiClient, JsonRequestOptions } from "./api-client";
const id = "11111111-1111-4111-8111-111111111111";
const result = { schemaVersion: 1, cutoff: "2026-01-02T00:00:00Z", timeZone: "America/Guatemala",
  totalAnalyses: 1, dtcRecords: 2, distinctCodes: 1,
  dates: [{ date: "2026-01-01", count: 1 }], vehicles: [{ make: "Marca", model: "Modelo", count: 1 }],
  codes: [{ code: "P0300", count: 1 }], modules: [{ moduleCode: null, moduleName: "Motor", count: 1 }],
  analyses: [{ id, date: "2026-01-01", make: "Marca", model: "Modelo", year: 2025, dtcCount: 2 }] };
function client(read = async (): Promise<unknown> => result) {
  return { requestJson: vi.fn(async (_url: string, options: JsonRequestOptions<unknown>) => {
    const value = options.parse(await read()); if (!value) throw new Error("invalid"); return value;
  }) } as unknown as BrowserApiClient;
}
const change = (value: string) => fireEvent.change(screen.getByLabelText("Marca exacta"), { target: { value } });
afterEach(cleanup);
describe("tablero automático y selección vigente", () => {
  it("explica coincidencia exacta y envía ambos filtros al backend sin cambiar su presentación", async () => {
    const api = client();
    render(<HistoryStatistics apiClient={api} onFailure={() => false} onOpen={() => {}} />);
    await screen.findByRole("button", { name: "Abrir diagnóstico" });
    fireEvent.click(screen.getByText("Filtrar historial"));
    expect(screen.getByText(/nombre completo, sin distinguir mayúsculas/)).toBeTruthy();
    change(" bmw ");
    fireEvent.change(screen.getByLabelText("Modelo exacto"), { target: { value: " rav4 " } });
    fireEvent.click(screen.getByRole("button", { name: "Aplicar filtros" }));
    await screen.findByRole("button", { name: "Abrir diagnóstico" });
    const url = new URL(String(vi.mocked(api.requestJson).mock.calls[1]![0]), "http://localhost");
    expect(url.searchParams.get("make")).toBe(" bmw "); expect(url.searchParams.get("model")).toBe(" rav4 ");
    expect(screen.getByLabelText<HTMLInputElement>("Marca exacta").value).toBe(" bmw ");
  });
  it("carga sin filtros, restablece automáticamente, abre detalle y no hace polling", async () => {
    const api = client(), open = vi.fn();
    render(<HistoryStatistics apiClient={api} onFailure={() => false} onOpen={open} />);
    await screen.findByRole("button", { name: "Abrir diagnóstico" });
    expect(vi.mocked(api.requestJson).mock.calls[0]![0]).toBe("/api/history/statistics?");
    fireEvent.click(screen.getByText("Filtrar historial"));
    change("Marca"); fireEvent.click(screen.getByRole("button", { name: "Aplicar filtros" }));
    await screen.findByRole("button", { name: "Abrir diagnóstico" });
    expect(vi.mocked(api.requestJson).mock.calls[1]![0]).toBe("/api/history/statistics?make=Marca");
    fireEvent.click(screen.getByRole("button", { name: "Restablecer filtros" }));
    await screen.findByRole("button", { name: "Abrir diagnóstico" });
    expect(vi.mocked(api.requestJson).mock.calls[2]![0]).toBe("/api/history/statistics?");
    expect(screen.getByLabelText<HTMLInputElement>("Marca exacta").value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Abrir diagnóstico" })); expect(open).toHaveBeenCalledWith(id);
    expect(api.requestJson).toHaveBeenCalledTimes(3);
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain("Análisis por fecha");
  });
  it("reintento retenido lee filtros actuales; respuestas y finally antiguos no afectan nueva operación", async () => {
    const pending: { resolve: (v: unknown) => void; reject: (e: Error) => void }[] = [];
    const api = client(() => new Promise((resolve, reject) => pending.push({ resolve, reject })));
    let retry!: () => void;
    render(<HistoryStatistics apiClient={api} onFailure={(_e, cb) => { retry = cb; return false; }} onOpen={() => {}} />);
    await waitFor(() => expect(pending).toHaveLength(1));
    await act(async () => pending[0]!.reject(new Error("network")));
    fireEvent.click(screen.getByText("Filtrar historial"));
    change("Mazda"); act(() => retry());
    change("Toyota"); act(() => retry());
    expect(vi.mocked(api.requestJson).mock.calls[2]![0]).toContain("make=Toyota");
    expect(vi.mocked(api.requestJson).mock.calls[1]![1].init!.signal!.aborted).toBe(true);
    await act(async () => pending[1]!.resolve(result));
    expect(screen.queryByRole("button", { name: "Abrir diagnóstico" })).toBeNull();
    act(() => retry()); expect(api.requestJson).toHaveBeenCalledTimes(3);
    const toyota = { ...result, vehicles: [{ make: "Toyota", model: "Modelo", count: 1 }],
      analyses: [{ ...result.analyses[0]!, make: "Toyota" }] };
    await act(async () => pending[2]!.resolve(toyota));
    expect(screen.getByRole("table", { name: "Análisis de la selección" }).textContent).toContain("Toyota");
  });
  it.each(["logout", "identity"])("limpia y descarta respuestas/callbacks de %s", async mode => {
    let resolve!: (v: unknown) => void, retry!: () => void;
    const api = client(vi.fn().mockRejectedValueOnce(new Error("network")).mockImplementation(() => new Promise(r => { resolve = r; })));
    const props = { apiClient: api, onFailure: (_e: unknown, cb: () => void) => { retry = cb; return false; }, onOpen: () => {} };
    const view = render(<HistoryStatistics key="A" {...props} />);
    await screen.findByRole("alert"); act(() => retry());
    const oldResolve = resolve;
    const signal = vi.mocked(api.requestJson).mock.calls[1]![1].init!.signal!;
    if (mode === "logout") view.unmount(); else view.rerender(<HistoryStatistics key="B" {...props} />);
    await act(async () => { oldResolve(result); retry(); });
    expect(signal.aborted).toBe(true);
    expect(screen.queryByRole("button", { name: "Abrir diagnóstico" })).toBeNull();
    expect(api.requestJson).toHaveBeenCalledTimes(mode === "logout" ? 2 : 3);
  });
  it("descripciones ausentes y distintas con contexto sin alterar frecuencia", async () => {
    const descriptions = ["Circuito abierto", "Señal intermitente", null].map((description, i) => ({
      make: "Marca", model: `Modelo ${i}`, year: 2025, moduleCode: null, moduleName: "Motor", description, analysisIds: [id],
    }));
    render(<HistoryStatistics apiClient={client(async () => ({ ...result, codes: [{ code: "P0300", count: 1, descriptions }] }))}
      onFailure={() => false} onOpen={() => {}} />);
    await screen.findByText("La descripción varía según el contexto del reporte.");
    fireEvent.click(screen.getByText("Leer texto completo y contexto (3)"));
    expect(screen.getByText("Circuito abierto")).toBeTruthy(); expect(screen.getByText("Señal intermitente")).toBeTruthy();
    expect(screen.getByText("Descripción no disponible")).toBeTruthy(); expect(screen.getByText("1 análisis")).toBeTruthy();
  });
  it("error local recuperable sin texto del proveedor", async () => {
    const api = client(vi.fn().mockRejectedValueOnce(new Error("PRIVATE")).mockResolvedValueOnce(result));
    render(<HistoryStatistics apiClient={api} onFailure={() => false} onOpen={() => {}} />);
    expect((await screen.findByRole("alert")).textContent).not.toContain("PRIVATE");
    fireEvent.click(screen.getByRole("button", { name: "Actualizar" }));
    await screen.findByRole("button", { name: "Abrir diagnóstico" });
    expect(api.requestJson).toHaveBeenCalledTimes(2);
  });
  it("top explícito expandible con todos los códigos, sin descripción inventada", async () => {
    const codes = Array.from({ length: 8 }, (_, i) => ({ code: `P030${i}`, count: 1 }));
    render(<HistoryStatistics apiClient={client(async () => ({ ...result, distinctCodes: 8, codes }))}
      onFailure={() => false} onOpen={() => {}} />);
    const more = await screen.findByRole("button", { name: "Ver todos (8)" });
    expect(screen.queryByText("P0307")).toBeNull();
    expect(screen.getAllByText("Descripción no disponible")).toHaveLength(6);
    fireEvent.click(more);
    expect(screen.getByText("P0307")).toBeTruthy();
    expect(screen.getAllByText("Descripción no disponible")).toHaveLength(8);
  });
  it("respuesta inconsistente no presenta datos parciales", async () => {
    render(<HistoryStatistics apiClient={client(async () => ({ ...result, dtcRecords: 99 }))}
      onFailure={() => false} onOpen={() => {}} />);
    await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: "Abrir diagnóstico" })).toBeNull();
  });
});
