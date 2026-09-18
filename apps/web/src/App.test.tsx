// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { downloadReportPdf } from "./report-pdf";
import { App } from "./App";

vi.mock("./report-pdf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./report-pdf")>();
  return { ...actual, downloadReportPdf: vi.fn() };
});

const downloadReportPdfMock = vi.mocked(downloadReportPdf);

function createPdf(name: string) {
  return new File(["%PDF-1.7\n%%EOF"], name, { type: "application/pdf" });
}

function createJsonResponse(ok: boolean, body: unknown) {
  return {
    ok,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });

  return { promise, resolve };
}

function getUploadElements(container: HTMLElement) {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  const dropZone = container.querySelector<HTMLElement>(".drop-zone");
  const form = container.querySelector<HTMLFormElement>("form");

  if (!input || !dropZone || !form) throw new Error("No se encontraron los controles de carga.");
  return { input, dropZone, form };
}

function successfulUpload(file: File) {
  return createJsonResponse(true, {
    id: "4e1a912c-4018-47cb-a37a-3f7f6c3bf0ac",
    originalName: file.name,
    size: file.size,
    sha256: "a".repeat(64),
    type: "application/pdf",
    status: "received",
    extraction: {
      status: "completed",
      format: "autel_vehicle_diagnostic_report",
      requiresManualReview: false,
      vehicle: {
        year: 2025,
        make: "Marca Sintética",
        model: "Modelo Sintético",
        engine: null,
        odometer: null,
        vinMasked: "*************6789",
        vinPseudonym: "vin_v1_synthetic",
      },
      scanSummary: { declaredSystems: 1, parsedSystems: 1, declaredDtcs: 0, parsedDtcs: 0 },
      systems: [{ code: "PCM", name: "Módulo sintético", dtcCount: 0 }],
      dtcs: [],
      warnings: [],
    },
    analysisPreparation: {
      available: false,
      reasons: [{ code: "NO_VALID_DTCS", message: "El reporte no contiene DTC válidos para analizar." }],
      warnings: [],
      counts: { detected: 0, actionable: 0, historical: 0 },
    },
  });
}

function extractedUpload(
  file: File,
  extraction: Record<string, unknown>,
  analysisPreparation: Record<string, unknown> = {
    available: false,
    reasons: [{ code: "NOT_READY", message: "El reporte no está preparado para orientación por IA." }],
    warnings: [],
  },
) {
  const scanSummary = extraction.scanSummary as { parsedDtcs?: number } | undefined;
  const availableInput = analysisPreparation.available
    ? analysisPreparation.input as { modules?: Array<{ dtcs?: unknown[] }> } | undefined
    : undefined;
  const actionable = availableInput?.modules?.reduce((total, module) => total + (module.dtcs?.length ?? 0), 0) ?? 0;
  return createJsonResponse(true, {
    id: "5f02d19b-5fd2-4128-aeb6-c5eef33554a0",
    originalName: file.name,
    size: file.size,
    sha256: "b".repeat(64),
    type: "application/pdf",
    status: "received",
    extraction,
    analysisPreparation: {
      counts: { detected: scanSummary?.parsedDtcs ?? 0, actionable, historical: 0 },
      ...analysisPreparation,
    },
  });
}

function readyAnalysisUpload(file: File) {
  return extractedUpload(
    file,
    {
      status: "completed",
      format: "autel_vehicle_diagnostic_report",
      requiresManualReview: false,
      vehicle: {
        year: 2024,
        make: "Marca Sintética",
        model: "Modelo Académico",
        engine: "Motor privado",
        odometer: { value: 45678, unit: "km" },
        vinMasked: "*************6789",
        vinPseudonym: "vin_v1_private",
      },
      scanSummary: { declaredSystems: 1, parsedSystems: 1, declaredDtcs: 1, parsedDtcs: 1 },
      systems: [{ code: "PCM", name: "Módulo motriz", dtcCount: 1 }],
      dtcs: [{
        code: "P0300",
        moduleCode: "PCM",
        moduleName: "Módulo motriz",
        status: "current",
        statusOriginal: "Corriente",
        classification: "actionable",
        descriptionOriginal: "Fallo de encendido sintético",
      }],
      warnings: [],
    },
    {
      available: true,
      input: {
        vehicle: { make: "Marca Sintética", model: "Modelo Académico", year: 2024 },
        modules: [{
          code: "PCM",
          name: "Módulo motriz",
          dtcs: [{
            code: "P0300",
            description: "Fallo de encendido sintético",
            status: "current",
            alsoHistorical: false,
          }],
        }],
      },
      reasons: [],
      warnings: [],
      counts: { detected: 1, actionable: 1, historical: 0 },
    },
  );
}

function successfulAnalysis(observationCorrelation: Record<string, unknown> = {
  status: "not_provided",
  summary: "No se proporcionaron observaciones del vehículo.",
  matches: [],
}) {
  return createJsonResponse(true, {
    status: "completed",
    analysis: {
      technicalSummary: "Orientación sintética sobre una falla de encendido que debe comprobarse.",
      findings: [{
        relatedDtc: { code: "P0300", moduleCode: "PCM", moduleName: "Módulo motriz" },
        priority: "high",
        simpleExplanation: "El código indica una posible combustión irregular en uno o más cilindros.",
        possibleCauses: ["Bujía desgastada", "Conexión eléctrica deficiente"],
        recommendedChecks: ["Inspeccionar bujías", "Comprobar conectores"],
        safetyWarnings: ["Trabajar con el motor frío cuando corresponda"],
        confidence: "medium",
      }],
      observationCorrelation,
      safetyWarnings: ["No sustituir piezas sin realizar comprobaciones"],
      confidence: "medium",
      requiresTechnicianConfirmation: true,
    },
  });
}

afterEach(() => {
  cleanup();
  downloadReportPdfMock.mockReset();
  vi.unstubAllGlobals();
});

describe("identidad visual", () => {
  it("renderiza el logo oficial como recurso local, accesible y con proporción reservada", () => {
    render(<App />);
    const logo = screen.getByRole("img", { name: "AutoDiag IA" }) as HTMLImageElement;

    expect(logo.getAttribute("src")).toMatch(/autodiag-ia-logo\.png$/u);
    expect(logo.getAttribute("src")).not.toMatch(/^https?:|^data:/iu);
    expect(logo.width / logo.height).toBe(3);
    expect(logo.className).toBe("brand-logo");
    expect(screen.getAllByRole("img", { name: "AutoDiag IA" })).toHaveLength(1);
    const styles = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");
    expect(styles).toMatch(/\.brand-logo\s*\{[^}]*width:\s*min\(100%,\s*340px\)[^}]*height:\s*auto[^}]*aspect-ratio:\s*3\s*\/\s*1[^}]*object-fit:\s*contain/isu);
    expect(styles).toMatch(/@media\s*\(max-width:\s*560px\)[\s\S]*\.brand-logo\s*\{[^}]*width:\s*min\(88vw,\s*285px\)/iu);
  });
});

describe("carga de reportes", () => {
  it("muestra observaciones opcionales con ayuda, contador y límite anticipado", () => {
    render(<App />);
    const textarea = screen.getByRole("textbox", { name: "Observaciones del vehículo (opcional)" }) as HTMLTextAreaElement;

    expect(textarea.maxLength).toBe(1_000);
    expect(screen.getByText(/No incluyas VIN, nombres, teléfonos, claves ni datos del cliente/)).toBeTruthy();
    expect(screen.getByText("0/1000")).toBeTruthy();

    fireEvent.change(textarea, { target: { value: "x".repeat(1_000) } });
    expect(textarea.value).toHaveLength(1_000);
    expect(screen.getByText("1000/1000")).toBeTruthy();

    fireEvent.change(textarea, { target: { value: "x".repeat(1_001) } });
    expect(textarea.value).toHaveLength(1_000);
    expect(screen.getByRole("alert").textContent).toContain("no pueden superar 1,000 caracteres");
  });

  it("aborta una carga al desmontar e ignora su respuesta tardía", async () => {
    const file = createPdf("desmontaje-carga.pdf");
    const pendingUpload = createDeferred<Response>();
    const fetchMock = vi.fn<typeof fetch>().mockReturnValue(pendingUpload.promise);
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const { container, unmount } = render(<App />);
    const { input } = getUploadElements(container);

    await user.upload(input, file);
    await user.click(screen.getByRole("button", { name: "Enviar reporte" }));
    const signal = fetchMock.mock.calls[0]?.[1]?.signal as AbortSignal;

    expect(signal.aborted).toBe(false);
    unmount();
    expect(signal.aborted).toBe(true);

    await act(async () => {
      pendingUpload.resolve(successfulUpload(file));
      await pendingUpload.promise;
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Reporte recibido correctamente.")).toBeNull();
  });

  it("ignora un drop durante una carga activa y realiza una sola solicitud", async () => {
    const firstFile = createPdf("reporte-a.pdf");
    const secondFile = createPdf("reporte-b.pdf");
    const pendingResponse = createDeferred<Response>();
    const fetchMock = vi.fn<typeof fetch>().mockReturnValue(pendingResponse.promise);
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const { container } = render(<App />);
    const { input, dropZone, form } = getUploadElements(container);

    await user.upload(input, firstFile);
    await user.click(screen.getByRole("button", { name: "Enviar reporte" }));
    fireEvent.drop(dropZone, { dataTransfer: { files: [secondFile] } });
    fireEvent.submit(form);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText(firstFile.name)).toBeTruthy();
    expect(screen.queryByText(secondFile.name)).toBeNull();

    await act(async () => {
      pendingResponse.resolve(successfulUpload(firstFile));
      await pendingResponse.promise;
    });
    expect(await screen.findByText("Reporte recibido correctamente.")).toBeTruthy();
  });

  it("mantiene el archivo seleccionado y deshabilita los controles durante el envío", async () => {
    const firstFile = createPdf("reporte-original.pdf");
    const replacementFile = createPdf("reporte-reemplazo.pdf");
    const pendingResponse = createDeferred<Response>();
    const fetchMock = vi.fn<typeof fetch>().mockReturnValue(pendingResponse.promise);
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const { container } = render(<App />);
    const { input } = getUploadElements(container);

    await user.upload(input, firstFile);
    await user.click(screen.getByRole("button", { name: "Enviar reporte" }));

    expect(input.disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Eliminar archivo seleccionado" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(input, { target: { files: [replacementFile] } });

    expect(screen.getByText(firstFile.name)).toBeTruthy();
    expect(screen.queryByText(replacementFile.name)).toBeNull();

    await act(async () => {
      pendingResponse.resolve(successfulUpload(firstFile));
      await pendingResponse.promise;
    });
  });

  it("limpia el selector después de un drop y permite volver al archivo anterior", async () => {
    const firstFile = createPdf("reporte-a.pdf");
    const secondFile = createPdf("reporte-b.pdf");
    const user = userEvent.setup();
    const { container } = render(<App />);
    const { input, dropZone } = getUploadElements(container);

    await user.upload(input, firstFile);
    Object.defineProperty(input, "value", {
      configurable: true,
      value: "C:\\fakepath\\reporte-a.pdf",
      writable: true,
    });
    expect(input.value).not.toBe("");

    fireEvent.drop(dropZone, { dataTransfer: { files: [secondFile] } });

    expect(input.value).toBe("");
    expect(screen.getByText(secondFile.name)).toBeTruthy();

    await user.upload(input, firstFile);

    expect(screen.getByText(firstFile.name)).toBeTruthy();
    expect(screen.queryByText(secondFile.name)).toBeNull();
  });

  it("no rechaza por tamaño y muestra el error devuelto por el backend", async () => {
    const largeFile = createPdf("reporte-grande.pdf");
    Object.defineProperty(largeFile, "size", { value: 25 * 1024 * 1024 });
    const backendMessage = "El archivo excede el límite permitido de 10485760 bytes.";
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      createJsonResponse(false, {
        error: { code: "FILE_TOO_LARGE", message: backendMessage },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const { container } = render(<App />);
    const { input } = getUploadElements(container);

    await user.upload(input, largeFile);

    expect(screen.getByText(largeFile.name)).toBeTruthy();
    expect(screen.queryByText(/supera el límite de 10 MiB/i)).toBeNull();

    await user.click(screen.getByRole("button", { name: "Enviar reporte" }));

    expect(await screen.findByText(backendMessage)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("muestra un resultado completo con vehículo, VIN protegido y tabla DTC", async () => {
    const file = createPdf("resultado-completo.pdf");
    const fullVin = "1ABCD23EFGH456789";
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      extractedUpload(file, {
        status: "completed",
        format: "autel_vehicle_diagnostic_report",
        requiresManualReview: false,
        vehicle: {
          year: 2025,
          make: "Marca Sintética",
          model: "Modelo Sintético",
          engine: "Motor Sintético",
          odometer: { value: 45678, unit: "km" },
          vinMasked: "*************6789",
          vinPseudonym: "vin_v1_synthetic",
        },
        scanSummary: { declaredSystems: 2, parsedSystems: 2, declaredDtcs: 1, parsedDtcs: 1 },
        systems: [],
        dtcs: [{
          code: "U1000:01-AB",
          moduleCode: "PCM",
          moduleName: "Módulo sintético",
          status: "current",
          statusOriginal: "Corriente",
          classification: "actionable",
          descriptionOriginal: "Descripción completamente sintética",
        }],
        warnings: [],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const { container } = render(<App />);
    const { input } = getUploadElements(container);

    await user.upload(input, file);
    await user.click(screen.getByRole("button", { name: "Enviar reporte" }));

    expect(await screen.findByRole("heading", { name: "Datos del reporte" })).toBeTruthy();
    expect(screen.getByText("2025 · Marca Sintética · Modelo Sintético")).toBeTruthy();
    expect(screen.getByText("*************6789")).toBeTruthy();
    expect(screen.getByRole("table")).toBeTruthy();
    expect(screen.getByText("U1000:01-AB")).toBeTruthy();
    expect(screen.queryByText(fullVin)).toBeNull();
    expect(screen.queryByText("vin_v1_synthetic")).toBeNull();
  });

  it("presenta advertencias y necesidad de revisión para resultados parciales", async () => {
    const file = createPdf("resultado-parcial.pdf");
    const warningMessage = "La cantidad de DTC no coincide con el total declarado.";
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      extractedUpload(
        file,
        {
          status: "partial",
          format: "autel_vehicle_diagnostic_report",
          requiresManualReview: true,
          vehicle: { year: null, make: null, model: null, engine: null, odometer: null, vinMasked: null, vinPseudonym: null },
          scanSummary: { declaredSystems: 1, parsedSystems: 1, declaredDtcs: 2, parsedDtcs: 1 },
          systems: [],
          dtcs: [],
          warnings: [{ code: "DTC_COUNT_MISMATCH", message: warningMessage }],
        },
        {
          available: false,
          reasons: [
            { code: "EXTRACTION_INCOMPLETE", message: "La extracción debe estar completa antes de solicitar orientación por IA." },
          ],
          warnings: [],
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const { container } = render(<App />);
    const { input } = getUploadElements(container);

    await user.upload(input, file);
    await user.click(screen.getByRole("button", { name: "Enviar reporte" }));

    expect(await screen.findByText("Revisión requerida")).toBeTruthy();
    expect(screen.getByText(/requieren revisión manual/i)).toBeTruthy();
    expect(screen.getByText(warningMessage)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Análisis no disponible" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Analizar DTC con IA" })).toBeNull();
  });

  it("aclara que un resultado con cero DTC no equivale a ausencia de fallas", async () => {
    const file = createPdf("sin-dtc.pdf");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(successfulUpload(file)));
    const user = userEvent.setup();
    const { container } = render(<App />);
    const { input } = getUploadElements(container);

    await user.upload(input, file);
    await user.click(screen.getByRole("button", { name: "Enviar reporte" }));

    expect(await screen.findByText("No se reportaron DTC en este escaneo")).toBeTruthy();
    expect(screen.queryByText(/libre de fallas/i)).toBeNull();
  });

  it.each([
    ["Toyota", { detected: 27, actionable: 14, historical: 13 }],
    ["BMW", { detected: 10, actionable: 10, historical: 0 }],
  ])("presenta los contadores documentales y accionables de %s", async (_case, counts) => {
    const file = createPdf(`conteos-${_case}.pdf`);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(extractedUpload(
      file,
      {
        status: "completed",
        format: "autel_vehicle_diagnostic_report",
        requiresManualReview: false,
        vehicle: { year: 2024, make: "Marca", model: "Modelo", engine: null, odometer: null, vinMasked: null, vinPseudonym: null },
        scanSummary: { declaredSystems: 1, parsedSystems: 1, declaredDtcs: counts.detected, parsedDtcs: counts.detected },
        systems: [{ code: "PCM", name: "Módulo", dtcCount: counts.detected }],
        dtcs: [],
        warnings: [],
      },
      {
        available: false,
        reasons: [{ code: "SYNTHETIC", message: "Razón activa sintética." }],
        warnings: [],
        counts,
      },
    )));
    const user = userEvent.setup();
    const { container } = render(<App />);
    const { input } = getUploadElements(container);

    await user.upload(input, file);
    await user.click(screen.getByRole("button", { name: "Enviar reporte" }));

    const detectedLabel = await screen.findByText("DTC detectados");
    const actionableLabel = screen.getByText("DTC para análisis");
    const historicalLabel = screen.getByText("Registros históricos");
    expect(detectedLabel.previousElementSibling?.textContent).toBe(String(counts.detected));
    expect(actionableLabel.previousElementSibling?.textContent).toBe(String(counts.actionable));
    expect(historicalLabel.previousElementSibling?.textContent).toBe(String(counts.historical));
    expect(screen.getByText("Razón activa sintética.")).toBeTruthy();
  });
});

describe("orientación asistida por IA", () => {
  it("envía observaciones normalizadas solo tras la confirmación explícita", async () => {
    const file = createPdf("observaciones.pdf");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(readyAnalysisUpload(file))
      .mockResolvedValueOnce(successfulAnalysis({
        status: "no_clear_match",
        summary: "No se encontró una relación clara.",
        matches: [],
      }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const { container } = render(<App />);
    const { input } = getUploadElements(container);

    await user.upload(input, file);
    await user.click(screen.getByRole("button", { name: "Enviar reporte" }));
    const textarea = screen.getByRole("textbox", { name: "Observaciones del vehículo (opcional)" });
    fireEvent.change(textarea, { target: { value: "  Vibración al acelerar\ncon motor caliente.  " } });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Analizar DTC con IA" }));
    expect(screen.getByText("Las observaciones del vehículo escritas en el formulario.")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Confirmar y analizar" }));
    expect(await screen.findByText("No se encontró una relación clara.")).toBeTruthy();
    const analysisCalls = fetchMock.mock.calls.filter(([url]) => url === "/api/reports/analyze");
    expect(analysisCalls).toHaveLength(1);
    const requestBody = JSON.parse(String((analysisCalls[0]?.[1] as RequestInit).body)) as Record<string, unknown>;
    expect(requestBody).toEqual({
      vehicle: { make: "Marca Sintética", model: "Modelo Académico", year: 2024 },
      modules: [{
        code: "PCM",
        name: "Módulo motriz",
        dtcs: [{
          code: "P0300",
          description: "Fallo de encendido sintético",
          status: "current",
          alsoHistorical: false,
        }],
      }],
      observations: "Vibración al acelerar\ncon motor caliente.",
    });
    expect(JSON.stringify(requestBody)).not.toMatch(/vin|odometer|pdf|sha256|originalName|cliente/iu);
  });

  it("deshabilita las observaciones durante cada solicitud activa", async () => {
    const file = createPdf("observaciones-bloqueadas.pdf");
    const pendingUpload = createDeferred<Response>();
    const pendingAnalysis = createDeferred<Response>();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockReturnValueOnce(pendingUpload.promise)
      .mockReturnValueOnce(pendingAnalysis.promise);
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const { container } = render(<App />);
    const { input } = getUploadElements(container);
    const textarea = screen.getByRole("textbox", { name: "Observaciones del vehículo (opcional)" }) as HTMLTextAreaElement;

    await user.upload(input, file);
    await user.click(screen.getByRole("button", { name: "Enviar reporte" }));
    expect(textarea.disabled).toBe(true);
    await act(async () => {
      pendingUpload.resolve(readyAnalysisUpload(file));
      await pendingUpload.promise;
    });
    await screen.findByRole("button", { name: "Analizar DTC con IA" });
    expect(textarea.disabled).toBe(false);

    await user.click(screen.getByRole("button", { name: "Analizar DTC con IA" }));
    await user.click(screen.getByRole("button", { name: "Confirmar y analizar" }));
    expect(textarea.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Descargar informe PDF" })).toBeNull();
    await act(async () => {
      pendingAnalysis.resolve(successfulAnalysis());
      await pendingAnalysis.promise;
    });
    await screen.findByText("Requiere confirmación del técnico");
    expect(textarea.disabled).toBe(false);
  });

  it("conserva el resultado hasta solicitar explícitamente un nuevo análisis de observaciones editadas", async () => {
    const file = createPdf("reanalisis-observaciones.pdf");
    const firstSummary = "La vibración podría relacionarse con el DTC.";
    const secondSummary = "No se encontró una relación clara con el ruido.";
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(readyAnalysisUpload(file))
      .mockResolvedValueOnce(successfulAnalysis({
        status: "matches_found",
        summary: firstSummary,
        matches: [{
          relatedDtc: { code: "P0300", moduleCode: "PCM", moduleName: "Módulo motriz" },
          observation: "Vibración al acelerar.",
          possibleRelation: "Podría guardar relación, pero requiere comprobación.",
          confidence: "low",
        }],
      }))
      .mockResolvedValueOnce(successfulAnalysis({ status: "no_clear_match", summary: secondSummary, matches: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const { container } = render(<App />);
    const { input } = getUploadElements(container);

    await user.upload(input, file);
    await user.click(screen.getByRole("button", { name: "Enviar reporte" }));
    const textarea = screen.getByRole("textbox", { name: "Observaciones del vehículo (opcional)" });
    await user.type(textarea, "Vibración al acelerar");
    await user.click(screen.getByRole("button", { name: "Analizar DTC con IA" }));
    await user.click(screen.getByRole("button", { name: "Confirmar y analizar" }));
    expect(await screen.findByText(firstSummary)).toBeTruthy();
    expect(container.querySelector(".observation-matches")?.textContent).toContain("P0300");
    expect(container.querySelector(".observation-matches")?.textContent).toContain("PCM · Módulo motriz");
    expect(screen.getByText("Observación relacionada:").parentElement?.textContent).toContain("Vibración al acelerar");
    expect(screen.getByText("Confianza de la relación: Baja")).toBeTruthy();
    expect(screen.getByText(/debe verificarse mediante comprobaciones profesionales/)).toBeTruthy();

    await user.clear(textarea);
    await user.type(textarea, "Ruido breve en frío");
    expect(screen.getByText(firstSummary)).toBeTruthy();
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/reports/analyze")).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Volver a analizar con las observaciones actuales" }));
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/reports/analyze")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Confirmar y analizar" }));
    expect(await screen.findByText(secondSummary)).toBeTruthy();
    expect(container.querySelector(".observation-matches")).toBeNull();
    expect(screen.getByRole("heading", { name: "Resumen técnico" })).toBeTruthy();
    expect(screen.getByText(/debe verificarse mediante comprobaciones profesionales/)).toBeTruthy();
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/reports/analyze")).toHaveLength(2);
  });
  it("gestiona el foco al abrir y cancelar la confirmación", async () => {
    const file = createPdf("foco-confirmacion.pdf");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValueOnce(readyAnalysisUpload(file)));
    const user = userEvent.setup();
    const { container } = render(<App />);
    const { input } = getUploadElements(container);

    await user.upload(input, file);
    await user.click(screen.getByRole("button", { name: "Enviar reporte" }));
    await user.click(await screen.findByRole("button", { name: "Analizar DTC con IA" }));

    const confirmationTitle = screen.getByRole("heading", { name: "Confirma los datos que se enviarán" });
    await waitFor(() => expect(document.activeElement).toBe(confirmationTitle));

    await user.click(screen.getByRole("button", { name: "Cancelar" }));
    const analysisButton = await screen.findByRole("button", { name: "Analizar DTC con IA" });
    await waitFor(() => expect(document.activeElement).toBe(analysisButton));
  });

  it("aborta un análisis al desmontar e ignora su respuesta tardía", async () => {
    const file = createPdf("desmontaje-analisis.pdf");
    const pendingAnalysis = createDeferred<Response>();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(readyAnalysisUpload(file))
      .mockReturnValueOnce(pendingAnalysis.promise);
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const { container, unmount } = render(<App />);
    const { input } = getUploadElements(container);

    await user.upload(input, file);
    await user.click(screen.getByRole("button", { name: "Enviar reporte" }));
    await user.click(await screen.findByRole("button", { name: "Analizar DTC con IA" }));
    await user.click(screen.getByRole("button", { name: "Confirmar y analizar" }));
    const signal = fetchMock.mock.calls[1]?.[1]?.signal as AbortSignal;

    expect(signal.aborted).toBe(false);
    unmount();
    expect(signal.aborted).toBe(true);

    await act(async () => {
      pendingAnalysis.resolve(successfulAnalysis());
      await pendingAnalysis.promise;
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Requiere confirmación del técnico")).toBeNull();
  });

  it("exige confirmación, no analiza automáticamente y envía una sola vez el DTO sanitizado", async () => {
    const file = createPdf("orientacion.pdf");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(readyAnalysisUpload(file))
      .mockResolvedValueOnce(successfulAnalysis());
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const { container } = render(<App />);
    const { input } = getUploadElements(container);

    await user.upload(input, file);
    await user.click(screen.getByRole("button", { name: "Enviar reporte" }));

    expect(await screen.findByRole("heading", { name: "Orientación asistida por IA" })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Analizar DTC con IA" }));

    expect(screen.getByRole("heading", { name: "Confirma los datos que se enviarán" })).toBeTruthy();
    expect(screen.getByText(/No se enviarán/i)).toBeTruthy();
    expect(screen.getByText(/VIN, PDF, odómetro ni datos del cliente/i)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Confirmar y analizar" }));

    expect(await screen.findByRole("heading", { name: "Resumen técnico" })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const analysisCalls = fetchMock.mock.calls.filter(([url]) => url === "/api/reports/analyze");
    expect(analysisCalls).toHaveLength(1);

    const requestBody = JSON.parse(String((analysisCalls[0]?.[1] as RequestInit | undefined)?.body)) as Record<string, unknown>;
    expect(requestBody).toEqual({
      vehicle: { make: "Marca Sintética", model: "Modelo Académico", year: 2024 },
      modules: [{
        code: "PCM",
        name: "Módulo motriz",
        dtcs: [{
          code: "P0300",
          description: "Fallo de encendido sintético",
          status: "current",
          alsoHistorical: false,
        }],
      }],
    });
    const serialized = JSON.stringify(requestBody).toLowerCase();
    for (const forbidden of ["vin", "pdf", "odometer", "originalname", "sha256", "customer", "cliente"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("impide el doble clic mientras existe una solicitud de análisis activa", async () => {
    const file = createPdf("doble-clic.pdf");
    const pendingAnalysis = createDeferred<Response>();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(readyAnalysisUpload(file))
      .mockReturnValueOnce(pendingAnalysis.promise);
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const { container } = render(<App />);
    const { input } = getUploadElements(container);

    await user.upload(input, file);
    await user.click(screen.getByRole("button", { name: "Enviar reporte" }));
    await user.click(await screen.findByRole("button", { name: "Analizar DTC con IA" }));
    const confirmButton = screen.getByRole("button", { name: "Confirmar y analizar" });

    fireEvent.click(confirmButton);
    fireEvent.click(confirmButton);

    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/reports/analyze")).toHaveLength(1);
    expect((screen.getByRole("button", { name: "Analizar DTC con IA" }) as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      pendingAnalysis.resolve(successfulAnalysis());
      await pendingAnalysis.promise;
    });
    expect(await screen.findByText("Requiere confirmación del técnico")).toBeTruthy();
  });

  it("presenta la orientación separada con prioridades, causas, comprobaciones, advertencias y confianza", async () => {
    const file = createPdf("resultado-ia.pdf");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(readyAnalysisUpload(file))
      .mockResolvedValueOnce(successfulAnalysis());
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const { container } = render(<App />);
    const { input } = getUploadElements(container);

    await user.upload(input, file);
    await user.click(screen.getByRole("button", { name: "Enviar reporte" }));
    await user.click(await screen.findByRole("button", { name: "Analizar DTC con IA" }));
    await user.click(screen.getByRole("button", { name: "Confirmar y analizar" }));

    expect(await screen.findByText("Orientación sintética sobre una falla de encendido que debe comprobarse.")).toBeTruthy();
    expect(screen.getByText("Prioridad Alta")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Posibles causas" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Comprobaciones recomendadas" })).toBeTruthy();
    expect(screen.getAllByText("Advertencias de seguridad").length).toBeGreaterThan(0);
    expect(screen.getByText("Confianza: Media")).toBeTruthy();
    expect(screen.getAllByText("PCM · Módulo motriz")).toHaveLength(2);
    expect(screen.getByText("Requiere confirmación del técnico")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Datos del reporte" })).toBeTruthy();
    const noObservationsMessage = "No se proporcionaron observaciones adicionales. El análisis se realizó únicamente con los DTC extraídos del reporte.";
    expect(screen.getAllByText(noObservationsMessage)).toHaveLength(1);
    expect(screen.queryByText("No se proporcionaron observaciones del vehículo.")).toBeNull();
    expect(screen.queryByText("No se incluyeron observaciones adicionales en esta solicitud.")).toBeNull();
    expect(screen.queryByText(/Una coincidencia es orientativa/)).toBeNull();
    expect(container.querySelector(".observation-matches")).toBeNull();
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/reports/analyze")).toHaveLength(1);
  });

  it("presenta de forma segura el rechazo de observaciones sin ocultar la extracción", async () => {
    const file = createPdf("observaciones-rechazadas.pdf");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(readyAnalysisUpload(file))
      .mockResolvedValueOnce(createJsonResponse(false, {
        error: { code: "OBSERVATIONS_SENSITIVE_CONTENT", message: "detalle interno" },
      }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const { container } = render(<App />);
    const { input } = getUploadElements(container);

    await user.upload(input, file);
    await user.click(screen.getByRole("button", { name: "Enviar reporte" }));
    await user.type(screen.getByRole("textbox", { name: "Observaciones del vehículo (opcional)" }), "Texto sintético");
    await user.click(screen.getByRole("button", { name: "Analizar DTC con IA" }));
    await user.click(screen.getByRole("button", { name: "Confirmar y analizar" }));

    expect(await screen.findByText(/parecen contener un VIN, una clave o un secreto/)).toBeTruthy();
    expect(screen.queryByText("detalle interno")).toBeNull();
    expect(screen.getByRole("heading", { name: "Datos del reporte" })).toBeTruthy();
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/reports/analyze")).toHaveLength(1);
  });

  it("traduce errores controlados y requiere una acción explícita para reintentar", async () => {
    const file = createPdf("error-ia.pdf");
    const rawMessage = "provider stack and internal prompt";
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(readyAnalysisUpload(file))
      .mockResolvedValueOnce(createJsonResponse(false, { error: { code: "OPENAI_TIMEOUT", message: rawMessage } }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const { container } = render(<App />);
    const { input } = getUploadElements(container);

    await user.upload(input, file);
    await user.click(screen.getByRole("button", { name: "Enviar reporte" }));
    await user.click(await screen.findByRole("button", { name: "Analizar DTC con IA" }));
    await user.click(screen.getByRole("button", { name: "Confirmar y analizar" }));

    expect(await screen.findByText("La solicitud de orientación agotó el tiempo disponible.")).toBeTruthy();
    expect(screen.queryByText(rawMessage)).toBeNull();
    expect(screen.getByRole("button", { name: "Intentar de nuevo" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Descargar informe PDF" })).toBeNull();
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/reports/analyze")).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "Datos del reporte" })).toBeTruthy();
    expect(screen.getByText("P0300")).toBeTruthy();
  });

  it("rechaza un hallazgo asociado a un DTC no accionable enviado por el proveedor", async () => {
    const file = createPdf("hallazgo-historico.pdf");
    const invalidAnalysis = successfulAnalysis();
    const body = await invalidAnalysis.json() as {
      analysis: { findings: Array<{ relatedDtc: { code: string; moduleCode: string | null; moduleName: string } }> };
    };
    body.analysis.findings[0]!.relatedDtc.code = "H0001";
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(readyAnalysisUpload(file))
      .mockResolvedValueOnce(createJsonResponse(true, body));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const { container } = render(<App />);
    const { input } = getUploadElements(container);

    await user.upload(input, file);
    await user.click(screen.getByRole("button", { name: "Enviar reporte" }));
    await user.click(await screen.findByRole("button", { name: "Analizar DTC con IA" }));
    await user.click(screen.getByRole("button", { name: "Confirmar y analizar" }));

    expect(await screen.findByText("El servicio devolvió una orientación que no pudo validarse.")).toBeTruthy();
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/reports/analyze")).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "Datos del reporte" })).toBeTruthy();
  });

  it("aborta la solicitud y limpia la orientación al cambiar de archivo", async () => {
    const firstFile = createPdf("reporte-anterior.pdf");
    const nextFile = createPdf("reporte-nuevo.pdf");
    const pendingAnalysis = createDeferred<Response>();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(readyAnalysisUpload(firstFile))
      .mockReturnValueOnce(pendingAnalysis.promise);
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const { container } = render(<App />);
    const { input } = getUploadElements(container);

    await user.upload(input, firstFile);
    await user.click(screen.getByRole("button", { name: "Enviar reporte" }));
    const textarea = screen.getByRole("textbox", { name: "Observaciones del vehículo (opcional)" }) as HTMLTextAreaElement;
    await user.type(textarea, "Vibración del reporte anterior");
    await user.click(await screen.findByRole("button", { name: "Analizar DTC con IA" }));
    await user.click(screen.getByRole("button", { name: "Confirmar y analizar" }));

    const requestOptions = fetchMock.mock.calls[1]?.[1] as RequestInit | undefined;
    const signal = requestOptions?.signal as AbortSignal;
    expect(signal.aborted).toBe(false);

    await user.upload(input, nextFile);

    expect(signal.aborted).toBe(true);
    expect(screen.getByText(nextFile.name)).toBeTruthy();
    expect(textarea.value).toBe("");
    expect(screen.getByText("La orientación anterior se canceló al cambiar de reporte.")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Orientación asistida por IA" })).toBeNull();

    await act(async () => {
      pendingAnalysis.resolve(successfulAnalysis());
      await pendingAnalysis.promise;
    });
    expect(screen.queryByText("Orientación sintética sobre una falla de encendido que debe comprobarse.")).toBeNull();
  });
});

describe("descarga local del informe PDF", () => {
  it("solo queda disponible después de un análisis completado y no realiza solicitudes adicionales", async () => {
    const file = createPdf("informe-local.pdf");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(readyAnalysisUpload(file))
      .mockResolvedValueOnce(successfulAnalysis());
    vi.stubGlobal("fetch", fetchMock);
    downloadReportPdfMock.mockResolvedValue("AutoDiagIA_Informe_2026-09-07_10-15.pdf");
    const user = userEvent.setup();
    const { container } = render(<App />);
    const { input } = getUploadElements(container);

    expect(screen.queryByRole("button", { name: "Descargar informe PDF" })).toBeNull();
    await user.upload(input, file);
    await user.click(screen.getByRole("button", { name: "Enviar reporte" }));
    expect(screen.queryByRole("button", { name: "Descargar informe PDF" })).toBeNull();
    await user.click(await screen.findByRole("button", { name: "Analizar DTC con IA" }));
    expect(screen.queryByRole("button", { name: "Descargar informe PDF" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Confirmar y analizar" }));

    const downloadButton = await screen.findByRole("button", { name: "Descargar informe PDF" });
    const requestsBeforeDownload = fetchMock.mock.calls.length;
    await user.click(downloadButton);

    expect(downloadReportPdfMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(requestsBeforeDownload);
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/reports/analyze")).toHaveLength(1);
    expect(await screen.findByText("Informe PDF descargado correctamente.")).toBeTruthy();
    const exported = downloadReportPdfMock.mock.calls[0]?.[0];
    expect(exported?.observations.used).toBeNull();
    expect(JSON.stringify(exported)).not.toMatch(/vin|odometer|Motor privado|originalName|sha256|vin_v1_private/iu);
  });

  it("usa un bloqueo síncrono para impedir dos descargas por doble clic", async () => {
    const file = createPdf("doble-descarga.pdf");
    const pendingDownload = createDeferred<string>();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(readyAnalysisUpload(file))
      .mockResolvedValueOnce(successfulAnalysis());
    vi.stubGlobal("fetch", fetchMock);
    downloadReportPdfMock.mockReturnValue(pendingDownload.promise);
    const user = userEvent.setup();
    const { container } = render(<App />);
    const { input } = getUploadElements(container);

    await user.upload(input, file);
    await user.click(screen.getByRole("button", { name: "Enviar reporte" }));
    await user.click(await screen.findByRole("button", { name: "Analizar DTC con IA" }));
    await user.click(screen.getByRole("button", { name: "Confirmar y analizar" }));
    const downloadButton = await screen.findByRole("button", { name: "Descargar informe PDF" });

    fireEvent.click(downloadButton);
    fireEvent.click(downloadButton);

    expect(downloadReportPdfMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Creando informe…" })).toHaveProperty("disabled", true);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      pendingDownload.resolve("AutoDiagIA_Informe_2026-09-07_10-15.pdf");
      await pendingDownload.promise;
    });
    expect(screen.getByRole("button", { name: "Descargar informe PDF" })).toHaveProperty("disabled", false);
  });

  it("conserva el análisis, muestra un error controlado y permite reintentar", async () => {
    const file = createPdf("reintento-pdf.pdf");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(readyAnalysisUpload(file))
      .mockResolvedValueOnce(successfulAnalysis());
    vi.stubGlobal("fetch", fetchMock);
    downloadReportPdfMock
      .mockRejectedValueOnce(new Error("traza-interna-privada"))
      .mockResolvedValueOnce("AutoDiagIA_Informe_2026-09-07_10-15.pdf");
    const user = userEvent.setup();
    const { container } = render(<App />);
    const { input } = getUploadElements(container);

    await user.upload(input, file);
    await user.click(screen.getByRole("button", { name: "Enviar reporte" }));
    await user.click(await screen.findByRole("button", { name: "Analizar DTC con IA" }));
    await user.click(screen.getByRole("button", { name: "Confirmar y analizar" }));
    const downloadButton = await screen.findByRole("button", { name: "Descargar informe PDF" });
    await user.click(downloadButton);

    expect(await screen.findByText("No fue posible crear el informe PDF. Puedes intentarlo de nuevo.")).toBeTruthy();
    expect(screen.queryByText("traza-interna-privada")).toBeNull();
    expect(screen.getByRole("heading", { name: "Resumen técnico" })).toBeTruthy();
    expect(downloadButton).toHaveProperty("disabled", false);

    await user.click(downloadButton);
    expect(downloadReportPdfMock).toHaveBeenCalledTimes(2);
    expect(await screen.findByText("Informe PDF descargado correctamente.")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("invalida el informe cuando cambian las observaciones y conserva la instantánea usada", async () => {
    const file = createPdf("instantanea-observaciones.pdf");
    const usedObservation = "Vibración al acelerar.";
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(readyAnalysisUpload(file))
      .mockResolvedValueOnce(successfulAnalysis({
        status: "matches_found",
        summary: "Existe una relación posible que debe comprobarse.",
        matches: [{
          relatedDtc: { code: "P0300", moduleCode: "PCM", moduleName: "Módulo motriz" },
          observation: usedObservation,
          possibleRelation: "La vibración podría corresponder a la combustión irregular.",
          confidence: "low",
        }],
      }));
    vi.stubGlobal("fetch", fetchMock);
    downloadReportPdfMock.mockResolvedValue("AutoDiagIA_Informe_2026-09-07_10-15.pdf");
    const user = userEvent.setup();
    const { container } = render(<App />);
    const { input } = getUploadElements(container);

    await user.upload(input, file);
    await user.click(screen.getByRole("button", { name: "Enviar reporte" }));
    const textarea = screen.getByRole("textbox", { name: "Observaciones del vehículo (opcional)" });
    await user.type(textarea, `  ${usedObservation}  `);
    await user.click(screen.getByRole("button", { name: "Analizar DTC con IA" }));
    await user.click(screen.getByRole("button", { name: "Confirmar y analizar" }));

    const downloadButton = await screen.findByRole("button", { name: "Descargar informe PDF" });
    await user.click(downloadButton);
    expect(downloadReportPdfMock.mock.calls[0]?.[0].observations.used).toBe(usedObservation);

    await user.clear(textarea);
    await user.type(textarea, "Ruido posterior que no fue analizado");
    expect(downloadButton).toHaveProperty("disabled", true);
    fireEvent.click(downloadButton);
    expect(downloadReportPdfMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Vuelve a analizar las observaciones actuales/iu)).toBeTruthy();
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/reports/analyze")).toHaveLength(1);
  });

  it("elimina el resultado descargable al reemplazar el reporte", async () => {
    const firstFile = createPdf("primero.pdf");
    const nextFile = createPdf("segundo.pdf");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(readyAnalysisUpload(firstFile))
      .mockResolvedValueOnce(successfulAnalysis());
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const { container } = render(<App />);
    const { input } = getUploadElements(container);

    await user.upload(input, firstFile);
    await user.click(screen.getByRole("button", { name: "Enviar reporte" }));
    await user.click(await screen.findByRole("button", { name: "Analizar DTC con IA" }));
    await user.click(screen.getByRole("button", { name: "Confirmar y analizar" }));
    expect(await screen.findByRole("button", { name: "Descargar informe PDF" })).toBeTruthy();

    await user.upload(input, nextFile);
    expect(screen.queryByRole("button", { name: "Descargar informe PDF" })).toBeNull();
    expect(downloadReportPdfMock).not.toHaveBeenCalled();
  });
});
