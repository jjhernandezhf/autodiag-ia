// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
afterEach(cleanup);
describe("estadísticas sin proveedores ni polling", () => {
  it("reintento retenido usa selección vigente; respuestas y finally antiguos no afectan la nueva", async () => {
    const pending: { resolve: (value: unknown) => void; reject: (error: Error) => void }[] = [];
    const api = client(() => new Promise((resolve, reject) => pending.push({ resolve, reject })));
    let retry!: () => void;
    render(<HistoryStatistics apiClient={api} onFailure={(_error, callback) => { retry = callback; return false; }} onOpen={() => {}} />);
    const change = (value: string) => fireEvent.change(screen.getByLabelText("Marca exacta"), { target: { value } });
    change("Mazda"); fireEvent.click(screen.getByRole("button"));
    await act(async () => pending[0]!.reject(new Error("synthetic network")));
    change("Toyota"); act(() => retry());
    expect(vi.mocked(api.requestJson).mock.calls[1]![0]).toBe("/api/history/statistics?make=Toyota");
    change("Mazda"); act(() => retry());
    const mazdaSignal = vi.mocked(api.requestJson).mock.calls[2]![1].init!.signal!;
    change("Honda"); act(() => retry());
    expect(mazdaSignal.aborted).toBe(true);
    expect(vi.mocked(api.requestJson).mock.calls.map(call => call[0])).toEqual([
      "/api/history/statistics?make=Mazda", "/api/history/statistics?make=Toyota",
      "/api/history/statistics?make=Mazda", "/api/history/statistics?make=Honda",
    ]);
    await act(async () => { pending[1]!.resolve(result); pending[2]!.resolve(result); });
    expect(screen.queryByRole("table")).toBeNull();
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
    act(() => retry()); // Old finally must not clear Honda's active controller.
    expect(api.requestJson).toHaveBeenCalledTimes(4);
    const honda = { ...result, vehicles: [{ make: "Honda", model: "Modelo", count: 1 }],
      analyses: [{ ...result.analyses[0]!, make: "Honda" }] };
    await act(async () => pending[3]!.resolve(honda));
    expect(screen.getByRole("table").textContent).toContain("Honda");
    expect(screen.getByLabelText<HTMLInputElement>("Marca exacta").value).toBe("Honda");
  });
  it.each(["logout", "identity"])("callback de reintento pendiente no revive datos tras %s", async mode => {
    const api = client(async () => { throw new Error("synthetic"); });
    let retry!: () => void;
    const props = { apiClient: api, onFailure: (_e: unknown, callback: () => void) => { retry = callback; return false; }, onOpen: () => {} };
    const view = render(<HistoryStatistics key="A" {...props} />);
    fireEvent.click(screen.getByRole("button")); await screen.findByRole("alert");
    if (mode === "logout") view.unmount();
    else view.rerender(<HistoryStatistics key="B" {...props} />);
    await act(async () => retry());
    expect(api.requestJson).toHaveBeenCalledOnce();
    expect(screen.queryByRole("table")).toBeNull();
  });
  it("consulta explícita, filtros sin identidad, gráficas y tabla; abre detalle existente", async () => {
    const api = client(), open = vi.fn();
    render(<HistoryStatistics apiClient={api} onFailure={() => false} onOpen={open} />);
    expect(api.requestJson).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Marca exacta"), { target: { value: "Marca" } });
    fireEvent.click(screen.getByRole("button", { name: "Consultar estadísticas" }));
    const button = await screen.findByRole("button", { name: "Abrir diagnóstico" });
    expect(vi.mocked(api.requestJson).mock.calls[0]![0]).toBe("/api/history/statistics?make=Marca");
    expect(vi.mocked(api.requestJson).mock.calls[0]![1]).toMatchObject({ retry: "none" });
    expect(screen.getByText("sin código / Motor")).toBeTruthy();
    expect(screen.getByRole("table").textContent).toContain("Modelo");
    fireEvent.click(button); expect(open).toHaveBeenCalledWith(id);
    expect(api.requestJson).toHaveBeenCalledOnce();
    fireEvent.change(screen.getByLabelText("Modelo exacto"), { target: { value: "Otro" } });
    expect(screen.queryByRole("table")).toBeNull();
  });
  it("doble clic, cambio identidad, respuesta tardía y limpieza de datos preparados", async () => {
    let finish!: (value: unknown) => void;
    const api = client(() => new Promise(resolve => { finish = resolve; }));
    const view = render(<HistoryStatistics key="A" apiClient={api} onFailure={() => false} onOpen={() => {}} />);
    fireEvent.click(screen.getByRole("button")); fireEvent.click(screen.getByRole("button"));
    expect(api.requestJson).toHaveBeenCalledOnce();
    const signal = vi.mocked(api.requestJson).mock.calls[0]![1].init!.signal!;
    view.rerender(<HistoryStatistics key="B" apiClient={api} onFailure={() => false} onOpen={() => {}} />);
    expect(signal.aborted).toBe(true);
    await act(async () => { finish(result); });
    expect(screen.queryByRole("table")).toBeNull();
    fireEvent.click(screen.getByRole("button"));
    await act(async () => { finish(result); });
    expect(screen.getByRole("table")).toBeTruthy();
    view.unmount(); expect(screen.queryByRole("table")).toBeNull();
  });
  it("errores locales y reintento explícito, sin mostrar texto remoto", async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error("PRIVATE")).mockResolvedValueOnce(result);
    const api = client(read);
    render(<HistoryStatistics apiClient={api} onFailure={() => false} onOpen={() => {}} />);
    fireEvent.click(screen.getByRole("button"));
    expect((await screen.findByRole("alert")).textContent).not.toContain("PRIVATE");
    expect(api.requestJson).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button")); await screen.findByRole("table");
    expect(api.requestJson).toHaveBeenCalledTimes(2);
  });
  it("respuesta inconsistente no muestra gráficas parciales", async () => {
    render(<HistoryStatistics apiClient={client(async () => ({ ...result, dtcRecords: 99 }))}
      onFailure={() => false} onOpen={() => {}} />);
    fireEvent.click(screen.getByRole("button")); await screen.findByRole("alert");
    expect(screen.queryByRole("table")).toBeNull();
  });
});
