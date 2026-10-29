// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReportReviewPanel } from "./ReportReviewPanel";
import type { BrowserApiClient, JsonRequestOptions } from "./api-client";
import type { ReviewableExtraction } from "./report-review-data";

const why = "Confirmado contra el documento sintetico autorizado.";
function report() {
  const extraction: ReviewableExtraction = { status: "partial", requiresManualReview: true,
    vehicle: { make: null, model: null, year: null, engine: null, odometer: null },
    scanSummary: { declaredSystems: 1, parsedSystems: 1, declaredDtcs: 1, parsedDtcs: 1 }, systems: [{ code: "PCM", name: "Modulo", dtcCount: 1 }],
    dtcs: [{ code: "12?45", moduleCode: null, moduleName: "Modulo no identificado", descriptionOriginal: "", status: "unknown", statusOriginal: "1 vez", classification: "unknown" }],
    warnings: [{ code: "DTC_ROW_UNPARSED", message: "Fila no interpretada" }] };
  return { id: "11111111-1111-4111-8111-111111111111", contentToken: "synthetic", extractionToken: "synthetic-browser-fixture-only", extraction };
}
function mount(r = report()) {
  const calls: Array<{ path: string; body: unknown }> = [];
  const requestCalls = vi.fn();
  const requestJson = async <T,>(path: RequestInfo | URL, options: JsonRequestOptions<T>): Promise<T> => {
    requestCalls();
    calls.push({ path: String(path), body: JSON.parse(String(options.init?.body)) });
    const parsed = options.parse({ received: true }); if (parsed === null) throw Error("Synthetic response"); return parsed;
  };
  const onReviewed = vi.fn();
  render(<ReportReviewPanel report={r} disabled={false} apiClient={{ requestJson, checkHealth: vi.fn(async () => undefined) } satisfies BrowserApiClient}
    parse={value => value as { received: boolean }} onReviewed={onReviewed} onEditing={vi.fn()} onCancel={vi.fn()} onFailure={vi.fn()} />);
  return { calls, requestJson: requestCalls, onReviewed };
}
const change = (name: string | RegExp, value: string) => fireEvent.change(screen.getByRole("textbox", { name }), { target: { value } });
afterEach(() => cleanup());

describe("acciones manuales accesibles del reporte", () => {
  it("ofrece contingencia ante una combinación nueva, mantiene ausencias y no solicita análisis", async () => {
    const r = report(); r.extraction.dtcs = []; r.extraction.systems = [];
    r.extraction.warnings = [{ code: "NEW_LAYOUT", message: "Variante documental nueva" }];
    const { calls, onReviewed } = mount(r), user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Completar manualmente y continuar con limitaciones" }));
    expect(screen.getByText(/El conjunto puede estar incompleto/)).toBeTruthy();
    await user.click(screen.getByRole("checkbox", { name: "Reconozco esta limitación: NEW_LAYOUT" }));
    change("Motivo y alcance para NEW_LAYOUT", why);
    await user.click(screen.getByRole("button", { name: "Transcribir otra fila del PDF" }));
    change("Código literal 1", "X?77"); change("Descripción técnica 1", "Descripcion tecnica del reporte");
    await user.selectOptions(screen.getByRole("combobox", { name: "Tratamiento 1" }), "reviewed_uncertain");
    fireEvent.change(screen.getByRole("spinbutton", { name: "Página del PDF 1" }), { target: { value: "2" } });
    change("Motivo técnico 1", why); change("Motivo general de orientación limitada", why);
    expect(calls).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Validar transcripción y limitaciones" }));
    await waitFor(() => expect(onReviewed).toHaveBeenCalledOnce());
    expect(calls).toHaveLength(1); expect(calls[0]!.path).toBe("/api/reports/review");
    expect(calls[0]!.body).toMatchObject({ mode: "limited_guidance_v1", vehicle: { make: null, model: null, year: null },
      acknowledgements: [{ code: "NEW_LAYOUT", reason: why }], rows: [{ code: "X?77", moduleName: null, moduleIndex: null, sourceIndex: null, page: 2, state: "reviewed_uncertain" }] });
  });
  it("resuelve desde el panel vehículo, código, descripción, módulo y estado incierto, sin añadir copia ni solicitar IA", async () => {
    const { calls, requestJson, onReviewed } = mount(), user = userEvent.setup();
    expect(screen.getByRole("region", { name: "Bloqueos y acciones disponibles" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Fila 1: corrige el código no reconocido/ }).getAttribute("href")).toBe("#review-row-0");
    expect(screen.getByText(/Descripción original: No interpretada/)).toBeTruthy();
    expect(screen.getByText(/12\?45.*Modulo no identificado.*1 vez/)).toBeTruthy();
    change("Marca confirmada", "Marca"); change("Modelo confirmado", "Modelo");
    fireEvent.change(screen.getByRole("spinbutton", { name: "Año confirmado" }), { target: { value: "2020" } });
    change("Código efectivo, fila 1", "P0300"); change("Descripción efectiva, fila 1", "Descripcion documentada");
    await user.selectOptions(screen.getByRole("combobox", { name: "Módulo efectivo, fila 1" }), "0");
    await user.selectOptions(screen.getByRole("combobox", { name: "Tratamiento del estado, fila 1" }), "reviewed_uncertain");
    change("Motivo/evidencia de la corrección, fila 1", why);
    expect(screen.getByRole("textbox", { name: "Motivo/evidencia de la corrección, fila 1" }).closest("details")?.open).toBe(true);
    await user.click(screen.getByRole("checkbox", { name: /Verifiqué y resolví/ }));
    change("Evidencia para DTC_ROW_UNPARSED", why); change("Motivo general y evidencia consultada", why);
    expect(requestJson).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Validar revisión del reporte" }));
    await waitFor(() => expect(onReviewed).toHaveBeenCalledOnce());
    expect(calls).toHaveLength(1); expect(calls[0]!.path).toBe("/api/reports/review");
    expect(calls[0]!.body).toMatchObject({ vehicle: { make: "Marca", model: "Modelo", year: 2020 },
      extraction: { dtcs: [{ code: "12?45", descriptionOriginal: "", statusOriginal: "1 vez" }] },
      rows: [{ sourceIndex: 0, moduleIndex: 0, code: "P0300", description: "Descripcion documentada", state: "reviewed_uncertain", reason: why }],
      reviewedWarnings: [{ code: "DTC_ROW_UNPARSED", reason: why }], reason: why });
    expect((calls[0]!.body as { rows: unknown[] }).rows).toHaveLength(1);
  });
  it("reasignar módulo abre reconciliación, muestra ambos detalles y exige motivo explícito", async () => {
    const r = report(); r.extraction.vehicle = { make: "Marca", model: "Modelo", year: 2020, engine: null, odometer: null };
    r.extraction.systems.push({ code: "BCM", name: "Carroceria", dtcCount: 0 });
    r.extraction.scanSummary.declaredSystems = r.extraction.scanSummary.parsedSystems = 2;
    r.extraction.dtcs[0] = { ...r.extraction.dtcs[0]!, code: "P0300", moduleCode: "PCM", moduleName: "Modulo", descriptionOriginal: "Descripcion", status: "current", statusOriginal: "Actual", classification: "actionable" };
    r.extraction.warnings = [];
    const { calls, onReviewed } = mount(r), user = userEvent.setup();
    await user.selectOptions(screen.getByRole("combobox", { name: "Módulo efectivo, fila 1" }), "1");
    expect(screen.getByText("Carroceria: resumen 0; detalle original 0; detalle revisado 1")).toBeTruthy();
    await user.selectOptions(screen.getByRole("combobox", { name: "Versión de conteos utilizada" }), "detail");
    change("Motivo de reconciliación", why); change("Motivo/evidencia de la corrección, fila 1", why); change("Motivo general y evidencia consultada", why);
    await user.click(screen.getByRole("button", { name: "Validar revisión del reporte" }));
    await waitFor(() => expect(onReviewed).toHaveBeenCalledOnce());
    expect(calls[0]!.body).toMatchObject({ rows: [{ sourceIndex: 0, moduleIndex: 1, reason: why }], countsDecision: { use: "detail", reason: why } });
  });
  it("añade solo una fila realmente ausente, admite estado no indicado como incierto y permite retirar un borrador accidental", async () => {
    const r = report(); r.extraction.vehicle = { make: "Marca", model: "Modelo", year: 2020, engine: null, odometer: null };
    r.extraction.dtcs = []; r.extraction.scanSummary.parsedDtcs = 0;
    const { calls, onReviewed } = mount(r), user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Añadir fila omitida según el PDF" }));
    expect(screen.getByRole("button", { name: "Eliminar fila añadida 1" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Eliminar fila añadida 1" }));
    expect(screen.queryByRole("textbox", { name: "Código efectivo, fila 1" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Añadir fila omitida según el PDF" }));
    change("Código efectivo, fila 1", "P0300"); change("Descripción efectiva, fila 1", "Descripcion del PDF");
    await user.selectOptions(screen.getByRole("combobox", { name: "Módulo efectivo, fila 1" }), "0");
    await user.selectOptions(screen.getByRole("combobox", { name: "Tratamiento del estado, fila 1" }), "reviewed_uncertain");
    change("Motivo/evidencia de la corrección, fila 1", why); change("Motivo general y evidencia consultada", why);
    await user.click(screen.getByRole("checkbox", { name: /Verifiqué y resolví/ })); change("Evidencia para DTC_ROW_UNPARSED", why);
    await user.click(screen.getByRole("button", { name: "Validar revisión del reporte" })); await waitFor(() => expect(onReviewed).toHaveBeenCalledOnce());
    expect(calls[0]!.body).toMatchObject({ rows: [{ sourceIndex: null, moduleIndex: 0, code: "P0300", state: "reviewed_uncertain", reason: why }] });
    expect((calls[0]!.body as { rows: object[] }).rows[0]).not.toHaveProperty("statusLabel");
  });
});
