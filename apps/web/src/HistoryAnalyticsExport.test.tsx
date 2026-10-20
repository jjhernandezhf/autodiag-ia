// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserApiClient, JsonRequestOptions } from "./api-client";
import { HistoryAnalyticsExport } from "./HistoryAnalyticsExport";

const result = { schemaVersion: 1, cutoff: "2026-01-01T00:00:00.000Z", analysesCount: 0, dtcCount: 0,
  analysesCsv: '\uFEFF"analysis_reference","created_at","make","model","year","dtc_count","rag_status"\r\n',
  dtcsCsv: '\uFEFF"analysis_reference","dtc_code","module_code","module_name"\r\n' };
function client(read: () => Promise<unknown> = async () => result) {
  const requestJson = vi.fn(async (_url: unknown, options: JsonRequestOptions<unknown>) => {
    const parsed = options.parse(await read());
    if (!parsed) throw new Error("invalid response");
    return parsed;
  });
  return { requestJson, checkHealth: vi.fn() } as unknown as BrowserApiClient;
}
beforeEach(() => {
  let n = 0;
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL = vi.fn(() => `blob:synthetic-${++n}`);
    static revokeObjectURL = vi.fn();
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("descarga explícita de dos CSV, solo sesión actual", () => {
  it("no exporta automáticamente; solicita una vez sin user_id y ofrece dos enlaces", async () => {
    const api = client(); const onFailure = vi.fn(() => false);
    const view = render(<HistoryAnalyticsExport apiClient={api} onFailure={onFailure} />);
    expect(api.requestJson).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Preparar CSV de mi historial" }));
    const analyses = await screen.findByRole("link", { name: "Descargar análisis CSV" });
    const dtcs = screen.getByRole("link", { name: "Descargar DTC CSV" });
    expect(analyses.getAttribute("download")).toBe("autodiag-analisis.csv");
    expect(dtcs.getAttribute("download")).toBe("autodiag-dtc.csv");
    expect(analyses.getAttribute("href")).toBe("blob:synthetic-1");
    expect(api.requestJson).toHaveBeenCalledOnce();
    expect(vi.mocked(api.requestJson).mock.calls[0]![0]).toBe("/api/history/export");
    expect(vi.mocked(api.requestJson).mock.calls[0]![1]).toMatchObject({ retry: "none", timeoutMs: 15000 });
    expect(vi.mocked(api.requestJson).mock.calls[0]![1].init).not.toHaveProperty("body");
    expect(screen.getByRole("status").textContent).toContain("0 análisis guardados y 0 DTC registrados");
    view.unmount(); expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
  });
  it("doble clic no duplica y desmontar cancela; respuesta tardía no crea archivos", async () => {
    let resolve!: (value: unknown) => void;
    const pending = new Promise(resolveValue => { resolve = resolveValue; });
    const api = client(async () => pending);
    const view = render(<HistoryAnalyticsExport apiClient={api} onFailure={() => false} />);
    const button = screen.getByRole("button");
    fireEvent.click(button); fireEvent.click(button);
    expect(api.requestJson).toHaveBeenCalledOnce(); expect((button as HTMLButtonElement).disabled).toBe(true);
    const signal = vi.mocked(api.requestJson).mock.calls[0]![1].init!.signal!;
    view.unmount(); expect(signal.aborted).toBe(true);
    await act(async () => { resolve(result); await pending; });
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
  it("fallo no ofrece archivos ni texto remoto; reintento solo explícito", async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error("PRIVATE_PROVIDER_MESSAGE")).mockResolvedValueOnce(result);
    const api = client(read); const onFailure = vi.fn(() => false);
    render(<HistoryAnalyticsExport apiClient={api} onFailure={onFailure} />);
    await userEvent.click(screen.getByRole("button"));
    expect((await screen.findByRole("alert")).textContent).toContain("No se ofrecen archivos parciales");
    expect(screen.queryByText("PRIVATE_PROVIDER_MESSAGE")).toBeNull(); expect(screen.queryByRole("link")).toBeNull();
    expect(api.requestJson).toHaveBeenCalledOnce(); expect(onFailure).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button"));
    await screen.findByRole("link", { name: "Descargar análisis CSV" });
    expect(api.requestJson).toHaveBeenCalledTimes(2);
  });
  it("rechaza respuesta malformada, sin descargas", async () => {
    render(<HistoryAnalyticsExport apiClient={client(async () => ({ ...result, user_id: "private" }))} onFailure={() => false} />);
    await userEvent.click(screen.getByRole("button"));
    await screen.findByRole("alert"); expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
  it("regenerar y abandonar historial revoca URLs anteriores", async () => {
    const view = render(<HistoryAnalyticsExport apiClient={client()} onFailure={() => false} />);
    await userEvent.click(screen.getByRole("button")); await screen.findByRole("link", { name: "Descargar análisis CSV" });
    await userEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(screen.getByRole("link", { name: "Descargar análisis CSV" }).getAttribute("href")).toBe("blob:synthetic-3"));
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
    view.unmount(); expect(URL.revokeObjectURL).toHaveBeenCalledTimes(4);
  });
});
