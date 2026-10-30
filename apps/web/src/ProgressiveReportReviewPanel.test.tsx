// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProgressiveReportReviewPanel } from "./ProgressiveReportReviewPanel";
import type { BrowserApiClient, JsonRequestOptions } from "./api-client";
import type { ReviewableExtraction } from "./report-review-data";

afterEach(cleanup);
function extraction(count = 10): ReviewableExtraction {
  return { status: "completed", requiresManualReview: false, vehicle: { make: "Marca", model: "Modelo", year: 2024, engine: null, odometer: null },
    scanSummary: { declaredSystems: 1, parsedSystems: 1, declaredDtcs: count, parsedDtcs: count }, systems: [{ code: "SYS", name: "Sistema", dtcCount: count }],
    dtcs: Array.from({ length: count }, (_, i) => ({ code: `P${String(i + 1).padStart(4, "0")}`, moduleCode: "SYS", moduleName: "Sistema", descriptionOriginal: `Descripción original ${i}`,
      status: "current", statusOriginal: "Corriente", classification: "actionable" })), warnings: [] };
}
function mount(e = extraction(), available = false, deferred = false) {
  const calls: Array<{ path: string; body: Record<string, unknown>; signal?: AbortSignal | null }> = [];
  let release!: () => void;
  const requestJson: BrowserApiClient["requestJson"] = <T,>(path: RequestInfo | URL, options: JsonRequestOptions<T>) => {
    calls.push({ path: String(path), body: JSON.parse(String(options.init?.body)), signal: options.init?.signal });
    return new Promise<T>(resolve => { release = () => resolve(options.parse({ received: true })!); if (!deferred) release(); });
  };
  const onReviewed = vi.fn(), onFailure = vi.fn();
  const view = render(<ProgressiveReportReviewPanel report={{ id: "synthetic", contentToken: "synthetic-content", extractionToken: "synthetic-proof", extraction: e }}
    available={available} disabled={false} apiClient={{ requestJson, checkHealth: vi.fn() }} parse={value => value} onReviewed={onReviewed} onFailure={onFailure} onEditing={vi.fn()} onCancel={vi.fn()} />);
  return { ...view, calls, onReviewed, onFailure, release: () => release() };
}
describe("revisión mínima y progresiva de cualquier reporte", () => {
  it.each(["año", "varios", "estado", "literal", "conteos", "parcial"])("solo pendientes, sin motivos obligatorios: %s", variant => {
    const e = extraction();
    if (["año", "varios"].includes(variant)) e.vehicle.year = null;
    if (variant === "varios") { e.vehicle.make = null; e.vehicle.model = null; }
    if (variant === "estado") Object.assign(e.dtcs[4]!, { status: "unknown", statusOriginal: "Estado Z", classification: "unknown" });
    if (variant === "literal") e.dtcs[4]!.code = "7?";
    if (variant === "conteos") { e.scanSummary.declaredDtcs = 15; e.warnings = [{ code: "DTC_COUNT_MISMATCH", message: "Conteos discrepantes: el conjunto puede estar incompleto" }]; }
    if (variant === "parcial") { e.status = "partial"; e.requiresManualReview = true; e.warnings = [{ code: "UNSEEN", message: "Estructura parcialmente aprovechable" }]; }
    mount(e);
    expect(screen.getByRole("button", { name: "Continuar con la información disponible" })).toBeTruthy();
    expect(screen.queryByLabelText(/Motivo|Página|Línea/)).toBeNull();
    expect(screen.queryByRole("textbox", { name: /Código literal, fila 1 / })).toBeNull();
    for (const field of document.querySelectorAll("input, textarea")) expect(field.hasAttribute("required")).toBe(false);
    if (variant === "año") { expect(screen.getAllByRole("spinbutton")).toHaveLength(1); expect(screen.queryByRole("textbox", { name: "Marca (opcional)" })).toBeNull(); }
  });
  it("una fila incompleta entre muchas: completa solo esa fila y no desaparece al escribir el primer carácter", async () => {
    const e = extraction(); e.dtcs[4]!.descriptionOriginal = ""; const view = mount(e), user = userEvent.setup();
    const field = screen.getByRole("textbox", { name: "Descripción, fila 5 (opcional)" });
    expect(screen.queryByRole("textbox", { name: "Descripción, fila 1 (opcional)" })).toBeNull();
    await user.type(field, "Descripción aportada completa");
    expect((field as HTMLTextAreaElement).value).toBe("Descripción aportada completa");
    await user.click(screen.getByRole("button", { name: "Continuar con la información disponible" }));
    await waitFor(() => expect(view.onReviewed).toHaveBeenCalledOnce());
    expect(view.calls[0]!.body).toMatchObject({ mode: "progressive_review_v1", actions: [{ sourceIndex: 4, description: "Descripción aportada completa" }] });
    expect(view.calls[0]!.body).not.toHaveProperty("reason"); expect(view.calls[0]!.body).not.toHaveProperty("rows");
  });
  it("continuar sin completar un dato opcional no retranscribe filas ni inventa valores", async () => {
    const e = extraction(); e.vehicle.year = null; const view = mount(e), user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Continuar con la información disponible" }));
    expect(view.calls).toHaveLength(1); expect(view.calls[0]!.path).toBe("/api/reports/review");
    expect(view.calls[0]!.body).toMatchObject({ actions: [], additionalRows: [], extraction: { vehicle: { year: null } } });
    expect(view.calls[0]!.body).not.toHaveProperty("vehicle"); expect(view.calls[0]!.body).not.toHaveProperty("acknowledgements");
  });
  it("completo sin advertencias: edición opcional contraída sin decisiones ni confirmación adicional", async () => {
    const view = mount(extraction(), true);
    const summary = screen.getByText("Editar datos extraídos (opcional)", { selector: "summary" });
    const editor = summary.closest("details") as HTMLDetailsElement;
    expect(editor.open).toBe(false);
    expect(screen.queryByRole("heading", { name: "Revisión mínima de datos pendientes" })).toBeNull();
    await userEvent.setup().click(summary);
    expect(editor.open).toBe(true);
    expect(screen.getByRole("heading", { name: "Edición opcional de datos extraídos" })).toBeTruthy();
    expect(screen.getByText(/No necesitas volver a confirmarlos/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Continuar con la información disponible" })).toBeNull();
    expect((screen.getByRole("textbox", { name: "Nota adicional (opcional)" }).closest("details") as HTMLDetailsElement).open).toBe(false);
    expect(screen.queryByRole("textbox", { name: /Descripción|Código literal/ })).toBeNull(); expect(view.calls).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Editar otro dato" })).toBeTruthy();
  });
  it("cero DTC completo no ofrece transcripción ni generación", () => {
    mount(extraction(0)); expect(screen.getByText(/Escaneo completo con cero DTC/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
  it("superar 50 identidades exige selección explícita, sin retranscripción ni truncamiento", async () => {
    const view = mount(extraction(51)), user = userEvent.setup();
    expect(screen.getByRole("alert").textContent).toContain("No se escogerán automáticamente");
    expect((screen.getByRole("button", { name: "Continuar con la información disponible" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("checkbox", { name: "Dejar la fila 51 fuera de la orientación (conservar original)" }));
    await user.click(screen.getByRole("button", { name: "Continuar con la información disponible" }));
    expect(view.calls[0]!.body.actions).toEqual([{ sourceIndex: 50, action: "omit" }]);
  });
  it("sin mínimos explica código/descripción y ofrece solo aportar lo que falta, sin páginas o motivos", async () => {
    const e = extraction(0); e.status = "partial"; e.requiresManualReview = true; e.scanSummary.declaredDtcs = null;
    const view = mount(e), user = userEvent.setup();
    expect(screen.getByRole("alert").textContent).toContain("código literal y descripción técnica");
    expect((screen.getByRole("button", { name: "Continuar con la información disponible" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByText("Aportar información no recuperada (opcional)"));
    await user.click(screen.getByRole("button", { name: "Añadir una fila no recuperada" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Código nuevo 1" }), { target: { value: "X?9" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Descripción nueva 1" }), { target: { value: "Descripción del reporte" } });
    await user.click(screen.getByRole("button", { name: "Continuar con la información disponible" }));
    expect(view.calls[0]!.body.additionalRows).toEqual([{ code: "X?9", description: "Descripción del reporte", moduleName: null, statusOriginal: null }]);
    expect(screen.queryByLabelText(/Página|Línea|Motivo/)).toBeNull();
  });
  it("desmontar por cambio de reporte/identidad cancela e impide aceptar la respuesta anterior", async () => {
    const e = extraction(); e.vehicle.year = null; const view = mount(e, false, true), user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Continuar con la información disponible" }));
    view.unmount(); expect(view.calls[0]!.signal?.aborted).toBe(true);
    await act(async () => { view.release(); await Promise.resolve(); });
    expect(view.onReviewed).not.toHaveBeenCalled(); expect(view.onFailure).not.toHaveBeenCalled();
  });
});
