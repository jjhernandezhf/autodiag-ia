// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LimitedReportReviewPanel } from "./LimitedReportReviewPanel";
import { ApiRequestError, type BrowserApiClient, type JsonRequestOptions } from "./api-client";
import type { ReviewableExtraction } from "./report-review-data";

afterEach(cleanup);
const why = "Revisado contra documento sintetico, no confirma integridad.";
const extraction: ReviewableExtraction = { status: "partial", requiresManualReview: true,
  vehicle: { make: null, model: null, year: null, engine: null, odometer: null },
  scanSummary: { declaredSystems: null, declaredDtcs: null, parsedSystems: 0, parsedDtcs: 0 }, systems: [], dtcs: [], warnings: [] };
async function complete() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Transcribir otra fila del PDF" }));
  for (const [name, value] of [["Código literal 1", "X?77"], ["Descripción técnica 1", "Descripcion literal sintetica"], ["Motivo técnico 1", why], ["Motivo general de orientación limitada", why]]) {
    fireEvent.change(screen.getByRole("textbox", { name }), { target: { value } });
  }
  await user.selectOptions(screen.getByRole("combobox", { name: "Tratamiento 1" }), "reviewed_uncertain");
  fireEvent.change(screen.getByRole("spinbutton", { name: "Página del PDF 1" }), { target: { value: "1" } });
  await user.click(screen.getByRole("button", { name: "Validar transcripción y limitaciones" }));
}
function mount(apiClient: BrowserApiClient) {
  const onReviewed = vi.fn(), onFailure = vi.fn();
  const component = render(<LimitedReportReviewPanel report={{ id: "synthetic-id", contentToken: "synthetic-content", extractionToken: "synthetic-proof", extraction }}
    apiClient={apiClient} parse={value => value} disabled={false} onReviewed={onReviewed} onFailure={onFailure} onEditing={vi.fn()} onCancel={vi.fn()} />);
  return { ...component, onReviewed, onFailure };
}
describe("ciclo de vida de transcripción limitada", () => {
  it("desmontar cancela y descarta una respuesta tardía incluso si el transporte ignora abort", async () => {
    let release!: () => void, signal: AbortSignal | undefined;
    const called = vi.fn();
    const requestJson = <T,>(_input: RequestInfo | URL, options: JsonRequestOptions<T>) => new Promise<T>(resolve => {
      called();
      signal = options.init?.signal ?? undefined; release = () => resolve(options.parse({ received: true })!);
    });
    const view = mount({ requestJson, checkHealth: vi.fn() });
    await complete(); expect(called).toHaveBeenCalledOnce(); view.unmount(); expect(signal?.aborted).toBe(true);
    await act(async () => { release(); await Promise.resolve(); });
    expect(view.onReviewed).not.toHaveBeenCalled(); expect(view.onFailure).not.toHaveBeenCalled();
  });
  it.each([
    ["timeout", new ApiRequestError("timeout", "synthetic", true), /este fallo no se resuelve reconociendo advertencias/],
    ["límite JSON", new ApiRequestError("validation", "synthetic", false, 413), /No se truncaron originales ni se autorizó IA/],
  ] as const)("distingue %s de impedimento documental y conserva datos", async (_scenario, error, expected) => {
    const requestJson = vi.fn(async () => { throw error; });
    const view = mount({ requestJson, checkHealth: vi.fn() });
    await complete(); await waitFor(() => expect(view.onFailure).toHaveBeenCalledOnce());
    expect(screen.getByText(expected)).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Código literal 1" }) as HTMLInputElement).value).toBe("X?77");
    expect(view.onReviewed).not.toHaveBeenCalled();
  });
});
