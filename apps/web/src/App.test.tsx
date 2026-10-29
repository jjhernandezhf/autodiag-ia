// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { downloadReportPdf } from "./report-pdf";
import { App } from "./App";
import {
  BrowserAuthenticationError,
  type BrowserAuthenticationService,
  type SupportedAuthEvent,
} from "./auth-service";

vi.mock("./report-pdf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./report-pdf")>();
  return { ...actual, downloadReportPdf: vi.fn() };
});

const downloadReportPdfMock = vi.mocked(downloadReportPdf);
const TEST_IDENTITY = { id: "6a103df0-8e4d-4c51-89f5-7030c5443d89", username: "usuario.sintetico" };
const TEST_VIN_PSEUDONYM = `vin_v1_${"a".repeat(64)}`;
const TEST_CONTENT_TOKEN = `pdf_v1_${"c".repeat(64)}.${"d".repeat(64)}`;

function createTestAuthService(
  overrides: Partial<BrowserAuthenticationService> = {},
): BrowserAuthenticationService {
  return {
    initialize: overrides.initialize ?? (async () => TEST_IDENTITY),
    login: overrides.login ?? (async () => TEST_IDENTITY),
    validateCurrentSession: overrides.validateCurrentSession ?? (async () => TEST_IDENTITY),
    authenticatedFetch: overrides.authenticatedFetch ?? (async (input, init = {}) => {
      const headers = { ...(init.headers as Record<string, string> | undefined), Authorization: "Bearer synthetic-access-token" };
      return fetch(input, { ...init, headers });
    }),
    subscribe: overrides.subscribe ?? (() => () => undefined),
    signOutLocal: overrides.signOutLocal ?? (async () => undefined),
  };
}

async function renderAuthenticatedApp(authService = createTestAuthService()) {
  const rendered = render(<App authService={authService} />);
  await screen.findByRole("heading", { name: "Carga tu reporte Autel" });
  return rendered;
}

function createPdf(name: string) {
  return new File(["%PDF-1.7\n%%EOF"], name, { type: "application/pdf" });
}

function createJsonResponse(ok: boolean, body: unknown, status = ok ? 200 : 400) {
  return {
    ok,
    status,
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
    contentToken: TEST_CONTENT_TOKEN,
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
        vinPseudonym: TEST_VIN_PSEUDONYM,
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
    reasons: [{ code: "NO_VALID_DTCS", message: "El reporte no está preparado para orientación por IA." }],
    warnings: [],
  },
  reportId = "5f02d19b-5fd2-4128-aeb6-c5eef33554a0",
) {
  const scanSummary = extraction.scanSummary as { parsedDtcs?: number } | undefined;
  const availableInput = analysisPreparation.available
    ? analysisPreparation.input as { modules?: Array<{ dtcs?: unknown[] }> } | undefined
    : undefined;
  const actionable = availableInput?.modules?.reduce((total, module) => total + (module.dtcs?.length ?? 0), 0) ?? 0;
  return createJsonResponse(true, {
    id: reportId,
    originalName: file.name,
    size: file.size,
    sha256: "b".repeat(64),
    contentToken: TEST_CONTENT_TOKEN,
    type: "application/pdf",
    status: "received",
    extraction,
    analysisPreparation: {
      counts: { detected: scanSummary?.parsedDtcs ?? 0, actionable, historical: 0 },
      ...analysisPreparation,
    },
  });
}

function readyAnalysisUpload(file: File, reportId?: string) {
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
        vinPseudonym: TEST_VIN_PSEUDONYM,
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
    reportId,
  );
}

const DISABLED_RAG = {
  enabled: false,
  used: false,
  status: "disabled",
  querySummary: "RAG disabled for this synthetic response.",
  sources: [],
};

function successfulAnalysis(observationCorrelation: Record<string, unknown> = {
  status: "not_provided",
  summary: "No se proporcionaron observaciones del vehículo.",
  matches: [],
}, rag: Record<string, unknown> = DISABLED_RAG, reused = false) {
  return createJsonResponse(true, {
    status: "completed",
    reused,
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
    rag,
  });
}

const HISTORY_ID = "77777777-7777-4777-8777-777777777777";

function historyListResponse() {
  return createJsonResponse(true, {
    items: [{
      id: HISTORY_ID,
      createdAt: "2026-10-04T12:00:00.000Z",
      reportReference: "5f02d19b-5fd2-4128-aeb6-c5eef33554a0",
      vehicle: { make: "Marca Histórica", model: "Modelo Seguro", year: 2024 },
      odometer: { value: 45678, unit: "km" },
      dtcCount: 1,
      ragStatus: "used",
    }],
    nextCursor: null,
  });
}

function historyDetailResponse() {
  return createJsonResponse(true, {
    history: {
      id: HISTORY_ID,
      createdAt: "2026-10-04T12:00:00.000Z",
      reportReference: "5f02d19b-5fd2-4128-aeb6-c5eef33554a0",
      vehicle: { make: "Marca Histórica", model: "Modelo Seguro", year: 2024 },
      odometer: { value: 45678, unit: "km" },
      dtcCount: 1,
      ragStatus: "used",
      analysisModel: "synthetic-analysis-model",
      embeddingModel: "text-embedding-3-small",
      schemaVersion: 1,
      snapshot: {
        extraction: {
          status: "completed",
          format: "autel_vehicle_diagnostic_report",
          requiresManualReview: false,
          vehicle: {
            year: 2024,
            make: "Marca Histórica",
            model: "Modelo Seguro",
            engine: "Motor técnico",
            odometer: { value: 45678, unit: "km" },
            vinMasked: "*************6789",
            vinPseudonym: null,
          },
          scanSummary: { declaredSystems: 1, parsedSystems: 1, declaredDtcs: 1, parsedDtcs: 1 },
          systems: [{ code: "PCM", name: "Módulo motriz", dtcCount: 1 }],
          dtcs: [{
            code: "P0300",
            moduleCode: "PCM",
            moduleName: "Módulo motriz",
            status: "current",
            statusOriginal: "Actual",
            classification: "actionable",
            descriptionOriginal: "Fallo de encendido sintético",
          }],
          warnings: [],
        },
        analysis: {
          input: {
            vehicle: { make: "Marca Histórica", model: "Modelo Seguro", year: 2024 },
            modules: [{
              code: "PCM",
              name: "Módulo motriz",
              dtcs: [{ code: "P0300", description: "Fallo de encendido sintético", status: "current", alsoHistorical: false }],
            }],
          },
          counts: { detected: 1, actionable: 1, historical: 0 },
          output: {
            technicalSummary: "Orientación histórica validada.",
            findings: [{
              relatedDtc: { code: "P0300", moduleCode: "PCM", moduleName: "Módulo motriz" },
              priority: "high",
              simpleExplanation: "El DTC requiere comprobaciones profesionales.",
              possibleCauses: ["Conexión eléctrica deficiente"],
              recommendedChecks: ["Comprobar alimentación y señal"],
              safetyWarnings: ["Trabajar con el vehículo inmovilizado"],
              confidence: "medium",
            }],
            observationCorrelation: {
              status: "not_provided",
              summary: "No se proporcionaron observaciones adicionales.",
              matches: [],
            },
            safetyWarnings: ["Confirmar antes de sustituir componentes"],
            confidence: "medium",
            requiresTechnicianConfirmation: true,
          },
          submittedObservations: "",
        },
        rag: {
          enabled: true,
          used: true,
          status: "used",
          querySummary: "Se recuperó evidencia histórica sintética.",
          sources: [{
            id: "99999999-9999-4999-8999-999999999999",
            title: "Comprobación técnica histórica",
            label: "Fuente sintética",
            url: "https://example.com/manual",
            similarity: 0.84,
            excerpt: "Verificar alimentación y señal antes de sustituir componentes.",
          }],
        },
      },
    },
  });
}

afterEach(() => {
  cleanup();
  downloadReportPdfMock.mockReset();
  vi.unstubAllGlobals();
});

describe("confirmación de vehículo y estados Autel", () => {
  async function missingYearUpload(file: File) {
    const body = await readyAnalysisUpload(file).json();
    body.extraction.vehicle.year = null;
    body.extraction.dtcs[0].status = "continuous_memory";
    body.extraction.dtcs[0].statusOriginal = "CMDTCs";
    body.analysisPreparation = { available: false, counts: { detected: 1, actionable: 1, historical: 0 }, warnings: [],
      reasons: [{ code: "VEHICLE_DATA_MISSING", message: "Falta confirmar el año." }] };
    return body;
  }
  function confirmedResponse(upload: Awaited<ReturnType<typeof missingYearUpload>>, year: number) {
    return { extraction: { ...upload.extraction, vehicle: { ...upload.extraction.vehicle, year }, warnings: [{
      code: "VEHICLE_DATA_CONFIRMED_BY_USER", message: "Año confirmado por el usuario, no extraído del PDF.",
    }] }, analysisPreparation: { available: true, reasons: [], warnings: [], counts: { detected: 1, actionable: 1, historical: 0 }, input: {
      vehicle: { make: upload.extraction.vehicle.make, model: upload.extraction.vehicle.model, year },
      modules: [{ code: "PCM", name: "Módulo motriz", dtcs: [{ code: "P0300", description: "Fallo de encendido sintético", status: "continuous_memory", alsoHistorical: false }] }],
    } } };
  }
  it("no inventa año, confirma en backend y mantiene CMDTC en análisis y PDF", async () => {
    const file = createPdf("synthetic.pdf"); const upload = await missingYearUpload(file);
    const confirmed = confirmedResponse(upload, 2014);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(createJsonResponse(true, upload))
      .mockResolvedValueOnce(createJsonResponse(true, confirmed)).mockResolvedValueOnce(successfulAnalysis());
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup(); const { container } = await renderAuthenticatedApp();
    await user.upload(getUploadElements(container).input, file);
    await user.click(screen.getByRole("button", { name: "Enviar reporte" }));
    expect(screen.queryByRole("button", { name: "Analizar DTC con IA" })).toBeNull();
    expect(screen.getByRole("spinbutton", { name: "Año confirmado" })).toHaveProperty("value", "");
    expect(screen.getByText(/Memoria continua.*no confirma falla activa/)).toBeTruthy();
    fireEvent.change(screen.getByRole("spinbutton", { name: "Año confirmado" }), { target: { value: "2014" } });
    await user.click(screen.getByRole("button", { name: "Confirmar datos del vehículo" }));
    const [url, init] = fetchMock.mock.calls[1]!;
    expect(url).toBe("/api/reports/confirm-vehicle");
    expect(JSON.parse(String(init?.body))).toMatchObject({ extraction: { vehicle: { year: null } }, vehicle: { year: 2014 } });
    expect(screen.getByText("Año confirmado por el usuario, no extraído del PDF.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Analizar DTC con IA" }));
    await user.click(screen.getByRole("button", { name: "Confirmar y analizar" }));
    await screen.findByRole("button", { name: /Descargar.*PDF/i });
    const body = JSON.parse(String(fetchMock.mock.calls[2]![1]?.body));
    expect(body.input.vehicle.year).toBe(2014);
    expect(body.input.modules[0].dtcs[0].status).toBe("continuous_memory");
    expect(body.historyContext.extraction.dtcs[0].statusOriginal).toBe("CMDTCs");
    await user.click(screen.getByRole("button", { name: /Descargar.*PDF/i }));
    await waitFor(() => expect(downloadReportPdfMock).toHaveBeenCalledOnce());
    expect(downloadReportPdfMock.mock.calls[0]![0].actionableDtcs[0]!.originalStatus).toBe("CMDTCs");
  });
  it.each(["nuevo archivo", "logout"])("aborta confirmación y descarta la respuesta tardía tras %s", async change => {
    const file = createPdf("synthetic.pdf"); const upload = await missingYearUpload(file);
    const pending = createDeferred<Response>();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(createJsonResponse(true, upload)).mockReturnValueOnce(pending.promise);
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup(); const { container } = await renderAuthenticatedApp();
    await user.upload(getUploadElements(container).input, file);
    await user.click(screen.getByRole("button", { name: "Enviar reporte" }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "Año confirmado" }), { target: { value: "2014" } });
    await user.click(screen.getByRole("button", { name: "Confirmar datos del vehículo" }));
    const signal = fetchMock.mock.calls[1]![1]!.signal!;
    if (change === "nuevo archivo") await user.upload(getUploadElements(container).input, createPdf("other-synthetic.pdf"));
    else await user.click(screen.getByRole("button", { name: "Cerrar sesión" }));
    expect(signal.aborted).toBe(true);
    await act(async () => { pending.resolve(createJsonResponse(true, confirmedResponse(upload, 2014))); await pending.promise; });
    expect(screen.queryByRole("button", { name: "Analizar DTC con IA" })).toBeNull();
    expect(screen.queryByText("Año confirmado por el usuario, no extraído del PDF.")).toBeNull();
  });
});

describe("revisión consolidada firmada y cero legítimo", () => {
  const why = "Confirmado contra documentacion sintetica del vehiculo.";
  async function signedUpload(file: File, missingYear = true) {
    const body = await readyAnalysisUpload(file).json();
    body.extractionToken = `review_v1_${Date.now() + 3600000}.${"a".repeat(64)}`; // Browser fixture only, not a server signature.
    if (missingYear) {
      body.extraction.vehicle.year = null;
      body.analysisPreparation = { available: false, reasons: [{ code: "VEHICLE_DATA_MISSING", message: "Falta el año." }],
        warnings: [], counts: { detected: 1, actionable: 1, historical: 0 } };
    }
    return body;
  }
  function reviewedResponse(upload: Awaited<ReturnType<typeof signedUpload>>) {
    const { format: _format, ...original } = structuredClone(upload.extraction); void _format;
    const { vinMasked: _masked, vinPseudonym: _pseudonym, ...vehicle } = original.vehicle; void _masked; void _pseudonym;
    original.vehicle = vehicle;
    const review = { version: "report_review_v1", original, reason: why,
      decisions: [{ path: "vehicle.year", before: null, after: "2014", reason: why }] };
    return { extractionToken: `review_v1_${Date.now() + 3600000}.${"b".repeat(64)}`,
      extraction: { ...upload.extraction, vehicle: { ...upload.extraction.vehicle, year: 2014 }, review },
      analysisPreparation: { available: true, reasons: [], warnings: [], counts: { detected: 1, actionable: 1, historical: 0 },
        input: { vehicle: { make: upload.extraction.vehicle.make, model: upload.extraction.vehicle.model, year: 2014 },
          modules: [{ code: "PCM", name: "Módulo motriz", dtcs: [{ code: "P0300", description: "Fallo de encendido sintético", status: "current", alsoHistorical: false }] }],
          reviewContext: { version: "review_context_v2", provenance: "user_review_unverified", reason: why, correctedFields: ["vehicle.year"], decisions: review.decisions } } },
    };
  }
  async function startReview(user: ReturnType<typeof userEvent.setup>, container: HTMLElement, file: File) {
    await user.upload(getUploadElements(container).input, file);
    await user.click(screen.getByRole("button", { name: "Enviar reporte" }));
    fireEvent.change(await screen.findByRole("spinbutton", { name: "Año confirmado" }), { target: { value: "2014" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Motivo general y evidencia consultada" }), { target: { value: why } });
    await user.click(screen.getByRole("button", { name: "Validar revisión del reporte" }));
  }
  it("envía revisión firmada, conserva originales y solo analiza mediante confirmación explícita", async () => {
    const file = createPdf("synthetic.pdf"), upload = await signedUpload(file), reviewed = reviewedResponse(upload);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(createJsonResponse(true, upload))
      .mockResolvedValueOnce(createJsonResponse(true, reviewed)).mockResolvedValueOnce(successfulAnalysis());
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup(), { container } = await renderAuthenticatedApp();
    await startReview(user, container, file);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]![0]).toBe("/api/reports/review");
    const sent = JSON.parse(String(fetchMock.mock.calls[1]![1]!.body));
    expect(sent).toMatchObject({ reportReference: upload.id, extractionToken: upload.extractionToken, vehicle: { year: 2014 }, reason: why });
    expect(sent.extraction.vehicle.year).toBeNull();
    expect(screen.getByText("Originales y correcciones confirmadas por el usuario")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Analizar DTC con IA" }));
    await user.click(screen.getByRole("button", { name: "Confirmar y analizar" }));
    await screen.findByRole("button", { name: /Descargar.*PDF/i });
    const analyzed = JSON.parse(String(fetchMock.mock.calls[2]![1]!.body));
    expect(analyzed.historyContext.extractionToken).toBe(reviewed.extractionToken);
    expect(analyzed.input.reviewContext.reason).toBe(why);
    expect(analyzed.input.reviewContext).toMatchObject({ version: "review_context_v2", provenance: "user_review_unverified",
      decisions: [{ path: "vehicle.year", before: null, after: "2014", reason: why }] });
    expect(analyzed.historyContext.extraction.review.original.vehicle.year).toBeNull();
    await user.click(screen.getByRole("button", { name: /Descargar.*PDF/i }));
    await waitFor(() => expect(downloadReportPdfMock).toHaveBeenCalledOnce());
    expect(downloadReportPdfMock.mock.calls[0]![0].review).toMatchObject({ reason: why, decisions: [{ path: "vehicle.year", before: null, after: "2014" }] });
  });
  it("tras confirmar el año muestra la acción del estado que sigue bloqueado, sin solicitar IA", async () => {
    const file = createPdf("synthetic-review.pdf"), upload = await signedUpload(file);
    Object.assign(upload.extraction, { status: "partial", requiresManualReview: true, warnings: [{ code: "UNKNOWN_DTC_STATUS", message: "Estado sin interpretar" }] });
    Object.assign(upload.extraction.dtcs[0], { status: "unknown", statusOriginal: "1 vez", classification: "unknown" });
    const reviewed = { ...reviewedResponse(upload), analysisPreparation: { available: false,
      reasons: [{ code: "UNKNOWN_DTC_STATUS", message: "Revisa el estado incierto antes de analizar." }],
      warnings: [], counts: { detected: 1, actionable: 0, historical: 0 } } };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(createJsonResponse(true, upload)).mockResolvedValueOnce(createJsonResponse(true, reviewed));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup(), { container } = await renderAuthenticatedApp();
    await startReview(user, container, file);
    expect(await screen.findByText("Originales y correcciones confirmadas por el usuario")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Fila 1: revisa explícitamente el estado incierto/ })).toBeTruthy();
    expect((screen.getByRole("spinbutton", { name: "Año confirmado" }) as HTMLInputElement).value).toBe("2014");
    expect(screen.queryByRole("button", { name: "Analizar DTC con IA" })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2); expect(fetchMock.mock.calls[1]![0]).toBe("/api/reports/review");
  });
  it.each(["otro reporte", "logout", "otra identidad"])("descarta revisión pendiente al cambiar a %s", async change => {
    const file = createPdf("synthetic.pdf"), upload = await signedUpload(file), pending = createDeferred<Response>();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(createJsonResponse(true, upload)).mockReturnValueOnce(pending.promise);
    vi.stubGlobal("fetch", fetchMock);
    let listener: ((event: SupportedAuthEvent, userId?: string | null) => void) | undefined;
    const second = { id: "8b34944b-afec-40ad-a1ee-e31978be731e", username: "segundo.sintetico" };
    const auth = createTestAuthService({ validateCurrentSession: async () => second, subscribe: callback => { listener = callback; return () => undefined; } });
    const user = userEvent.setup(), { container } = await renderAuthenticatedApp(auth);
    await startReview(user, container, file);
    const signal = fetchMock.mock.calls[1]![1]!.signal!;
    if (change === "otro reporte") await user.upload(getUploadElements(container).input, createPdf("other-synthetic.pdf"));
    else if (change === "logout") await user.click(screen.getByRole("button", { name: "Cerrar sesión" }));
    else { await act(async () => listener?.("SIGNED_IN", second.id)); await screen.findByText(second.username); }
    expect(signal.aborted).toBe(true);
    await act(async () => { pending.resolve(createJsonResponse(true, reviewedResponse(upload))); await pending.promise; });
    expect(screen.queryByText("Originales y correcciones confirmadas por el usuario")).toBeNull();
    expect(screen.queryByRole("button", { name: "Analizar DTC con IA" })).toBeNull();
  });
  it("editar correcciones cancela análisis anterior y bloquea su respuesta tardía", async () => {
    const file = createPdf("synthetic.pdf"), upload = await signedUpload(file, false), pending = createDeferred<Response>();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(createJsonResponse(true, upload)).mockReturnValueOnce(pending.promise);
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup(), { container } = await renderAuthenticatedApp();
    await user.upload(getUploadElements(container).input, file); await user.click(screen.getByRole("button", { name: "Enviar reporte" }));
    await user.click(screen.getByRole("button", { name: "Analizar DTC con IA" })); await user.click(screen.getByRole("button", { name: "Confirmar y analizar" }));
    const signal = fetchMock.mock.calls[1]![1]!.signal!;
    await user.click(screen.getByRole("button", { name: "Revisar o corregir datos" }));
    expect(signal.aborted).toBe(true);
    expect(screen.getByText("Valida o cancela las correcciones antes de solicitar orientación.")).toBeTruthy();
    await act(async () => { pending.resolve(successfulAnalysis()); await pending.promise; });
    expect(screen.queryByRole("button", { name: /Descargar.*PDF/i })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it.each([false, true])("no confunde cero legítimo con extracción incompleta=%s", async incomplete => {
    const file = createPdf("synthetic-zero.pdf"), upload = await successfulUpload(file).json();
    upload.extraction.vehicle.odometerRaw = "0";
    upload.extraction.systems = Array.from({ length: 8 }, (_, i) => ({ code: `M${i}`, name: `Modulo ${i}`, dtcCount: 0 }));
    upload.extraction.scanSummary = { declaredSystems: 8, parsedSystems: 8, declaredDtcs: incomplete ? 2 : 0, parsedDtcs: 0 };
    upload.extraction.requiresManualReview = incomplete; upload.extraction.status = incomplete ? "partial" : "completed";
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(createJsonResponse(true, upload)); vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup(), { container } = await renderAuthenticatedApp();
    await user.upload(getUploadElements(container).input, file); await user.click(screen.getByRole("button", { name: "Enviar reporte" }));
    const good = screen.queryByText("¡Buenas noticias! Este escaneo no reportó códigos DTC en los 8 sistemas revisados.");
    expect(!!good).toBe(!incomplete);
    expect(screen.getByText("0 (unidad no indicada)")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Analizar DTC con IA" })).toBeNull();
    if (incomplete) expect(screen.getByText("No se pudieron interpretar los DTC declarados; revisa el reporte.")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("identidad visual", () => {
  it("renderiza el logo oficial como recurso local, accesible y con proporción reservada", async () => {
    await renderAuthenticatedApp();
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
  it("muestra observaciones opcionales con ayuda, contador y límite anticipado", async () => {
    await renderAuthenticatedApp();
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
    const { container, unmount } = await renderAuthenticatedApp();
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
    const { container } = await renderAuthenticatedApp();
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
    const { container } = await renderAuthenticatedApp();
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
    const { container } = await renderAuthenticatedApp();
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
    const backendMessage = "detalle contaminado sk-proj-synthetic-never-real";
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      createJsonResponse(false, {
        error: { code: "FILE_TOO_LARGE", message: backendMessage },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const { container } = await renderAuthenticatedApp();
    const { input } = getUploadElements(container);

    await user.upload(input, largeFile);

    expect(screen.getByText(largeFile.name)).toBeTruthy();
    expect(screen.queryByText(/supera el límite de 10 MiB/i)).toBeNull();

    await user.click(screen.getByRole("button", { name: "Enviar reporte" }));

    expect(await screen.findByText("El archivo excede el límite permitido por el servidor.")).toBeTruthy();
    expect(screen.queryByText(backendMessage)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rechaza una respuesta 200 vacía sin perder el archivo ni cerrar la sesión", async () => {
    const file = createPdf("respuesta-vacia.pdf");
    const signOutLocal = vi.fn(async () => undefined);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(createJsonResponse(true, {}));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const { container } = await renderAuthenticatedApp(createTestAuthService({ signOutLocal }));

    await user.upload(getUploadElements(container).input, file);
    await user.click(screen.getByRole("button", { name: "Enviar reporte" }));

    expect(await screen.findByText("El servidor devolvió una respuesta de carga no válida.")).toBeTruthy();
    expect(screen.getByText(file.name)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Iniciar sesión" })).toBeNull();
    expect(signOutLocal).not.toHaveBeenCalled();
  });

  it("rechaza una respuesta 200 con extracción anidada incompleta", async () => {
    const file = createPdf("respuesta-anidada.pdf");
    const malformed = await successfulUpload(file).json() as {
      extraction: { vehicle: Record<string, unknown> };
    };
    delete malformed.extraction.vehicle.make;
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(createJsonResponse(true, malformed));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const { container } = await renderAuthenticatedApp();

    await user.upload(getUploadElements(container).input, file);
    await user.click(screen.getByRole("button", { name: "Enviar reporte" }));

    expect(await screen.findByText("El servidor devolvió una respuesta de carga no válida.")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Datos del reporte" })).toBeNull();
    expect(screen.getByText(file.name)).toBeTruthy();
  });

  it("rechaza una respuesta 200 con un arreglo anidado de tipo incorrecto", async () => {
    const file = createPdf("respuesta-arreglo.pdf");
    const malformed = await successfulUpload(file).json() as {
      extraction: { systems: unknown };
    };
    malformed.extraction.systems = { unexpected: true };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(createJsonResponse(true, malformed));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const { container } = await renderAuthenticatedApp();

    await user.upload(getUploadElements(container).input, file);
    await user.click(screen.getByRole("button", { name: "Enviar reporte" }));

    expect(await screen.findByText("El servidor devolvió una respuesta de carga no válida.")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Datos del reporte" })).toBeNull();
    expect(screen.getByText(file.name)).toBeTruthy();
  });

  it("no muestra mensajes remotos para códigos de error desconocidos", async () => {
    const file = createPdf("error-desconocido.pdf");
    const remoteMessage = "detalle-remoto-sintetico-que-no-debe-mostrarse";
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(createJsonResponse(false, {
      error: { code: "UNKNOWN_INTERNAL_CODE", message: remoteMessage },
    }, 400));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const { container } = await renderAuthenticatedApp();

    await user.upload(getUploadElements(container).input, file);
    await user.click(screen.getByRole("button", { name: "Enviar reporte" }));

    expect(await screen.findByText("No fue posible enviar el reporte.")).toBeTruthy();
    expect(screen.queryByText(remoteMessage)).toBeNull();
  });
  it.each([
    ["PDF_UNREADABLE", "Vuelve a exportar el reporte desde Autel"],
    ["PDF_NO_USABLE_TEXT", "texto seleccionable"],
    ["PDF_EXTRACTION_LIMIT_EXCEEDED", "Este archivo no se truncará"],
    ["PDF_ENCRYPTED", "exportación autorizada sin protección"],
  ])("ofrece recuperación local para %s sin habilitar revisión ni IA", async (code, recovery) => {
    const file = createPdf("synthetic-invalid.pdf");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(createJsonResponse(false, { error: { code, message: "REMOTE_MESSAGE_NOT_FOR_DISPLAY" } }, 422));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup(), { container } = await renderAuthenticatedApp();
    await user.upload(getUploadElements(container).input, file); await user.click(screen.getByRole("button", { name: "Enviar reporte" }));
    expect(await screen.findByText(new RegExp(recovery))).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reintentar" })).toBeTruthy();
    expect(screen.getByText(file.name)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Revisión manual del reporte" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Analizar DTC con IA" })).toBeNull();
    expect(screen.queryByText("REMOTE_MESSAGE_NOT_FOR_DISPLAY")).toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("bloquea reintentos rápidos de una carga mientras el nuevo POST sigue activo", async () => {
    const file = createPdf("reintento-rapido.pdf");
    const pendingRetry = createDeferred<Response>();
    const fetchMock = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("synthetic network failure"))
      .mockReturnValueOnce(pendingRetry.promise);
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const { container } = await renderAuthenticatedApp();

    await user.upload(getUploadElements(container).input, file);
    await user.click(screen.getByRole("button", { name: "Enviar reporte" }));
    await screen.findByText("Servidor temporalmente no disponible");
    const retry = screen.getAllByRole("button", { name: "Reintentar" })
      .find((button) => button.classList.contains("submit-button"));
    if (!retry) throw new Error("No se encontró el reintento de carga.");

    fireEvent.click(retry);
    fireEvent.click(retry);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => pendingRetry.resolve(successfulUpload(file)));
    expect(await screen.findByText("Reporte recibido correctamente.")).toBeTruthy();
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
          vinPseudonym: TEST_VIN_PSEUDONYM,
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
    const { container } = await renderAuthenticatedApp();
    const { input } = getUploadElements(container);

    await user.upload(input, file);
    await user.click(screen.getByRole("button", { name: "Enviar reporte" }));

    expect(await screen.findByRole("heading", { name: "Datos del reporte" })).toBeTruthy();
    expect(screen.getByText("2025 · Marca Sintética · Modelo Sintético")).toBeTruthy();
    expect(screen.getByText("*************6789")).toBeTruthy();
    expect(screen.getByRole("table")).toBeTruthy();
    expect(screen.getByText("U1000:01-AB")).toBeTruthy();
    expect(screen.queryByText(fullVin)).toBeNull();
    expect(screen.queryByText(TEST_VIN_PSEUDONYM)).toBeNull();
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
    const { container } = await renderAuthenticatedApp();
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
    const { container } = await renderAuthenticatedApp();
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
        reasons: [{ code: "NO_VALID_DTCS", message: "Razón activa sintética." }],
        warnings: [],
        counts,
      },
    )));
    const user = userEvent.setup();
    const { container } = await renderAuthenticatedApp();
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
    const { container } = await renderAuthenticatedApp();
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
    const analysisHeaders = (analysisCalls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(analysisHeaders["Idempotency-Key"]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);
    const requestBody = JSON.parse(String((analysisCalls[0]?.[1] as RequestInit).body)) as Record<string, unknown>;
    expect(requestBody.input).toEqual({
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
    expect(requestBody.historyContext).toMatchObject({
      reportReference: "5f02d19b-5fd2-4128-aeb6-c5eef33554a0",
      extraction: {
        vehicle: { vinMasked: "*************6789", vinPseudonym: TEST_VIN_PSEUDONYM, odometer: { value: 45678, unit: "km" } },
      },
    });
    expect(JSON.stringify(requestBody)).not.toMatch(/originalName|sha256|rawText|cliente/iu);
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
    const { container } = await renderAuthenticatedApp();
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
    const { container } = await renderAuthenticatedApp();
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
    const analysisCalls = fetchMock.mock.calls.filter(([url]) => url === "/api/reports/analyze");
    const firstKey = ((analysisCalls[0]?.[1] as RequestInit).headers as Record<string, string>)["Idempotency-Key"];
    const secondKey = ((analysisCalls[1]?.[1] as RequestInit).headers as Record<string, string>)["Idempotency-Key"];
    expect(secondKey).not.toBe(firstKey);
  });

  it("genera una clave nueva al reemplazar el PDF por otra preparación", async () => {
    const firstFile = createPdf("primero-idempotencia.pdf");
    const secondFile = createPdf("segundo-idempotencia.pdf");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(readyAnalysisUpload(firstFile, "5f02d19b-5fd2-4128-aeb6-c5eef33554a0"))
      .mockResolvedValueOnce(successfulAnalysis())
      .mockResolvedValueOnce(readyAnalysisUpload(secondFile, "6f02d19b-5fd2-4128-aeb6-c5eef33554a1"))
      .mockResolvedValueOnce(successfulAnalysis());
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const { container } = await renderAuthenticatedApp();
    const { input } = getUploadElements(container);

    await user.upload(input, firstFile);
    await user.click(screen.getByRole("button", { name: "Enviar reporte" }));
    await user.click(await screen.findByRole("button", { name: "Analizar DTC con IA" }));
    await user.click(screen.getByRole("button", { name: "Confirmar y analizar" }));
    await screen.findByRole("button", { name: "Descargar informe PDF" });

    await user.upload(input, secondFile);
    await user.click(screen.getByRole("button", { name: "Enviar reporte" }));
    await user.click(await screen.findByRole("button", { name: "Analizar DTC con IA" }));
    await user.click(screen.getByRole("button", { name: "Confirmar y analizar" }));
    await screen.findByRole("button", { name: "Descargar informe PDF" });

    const analysisCalls = fetchMock.mock.calls.filter(([url]) => url === "/api/reports/analyze");
    const firstKey = ((analysisCalls[0]?.[1] as RequestInit).headers as Record<string, string>)["Idempotency-Key"];
    const secondKey = ((analysisCalls[1]?.[1] as RequestInit).headers as Record<string, string>)["Idempotency-Key"];
    expect(analysisCalls).toHaveLength(2);
    expect(secondKey).not.toBe(firstKey);
  });

  it("presenta de forma accesible un resultado recuperado sin exponer el token privado", async () => {
    const file = createPdf("reporte-recuperado.pdf");
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(readyAnalysisUpload(file))
      .mockResolvedValueOnce(successfulAnalysis(undefined, DISABLED_RAG, true));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const { container } = await renderAuthenticatedApp();
    const { input } = getUploadElements(container);

    await user.upload(input, file);
    await user.click(screen.getByRole("button", { name: "Enviar reporte" }));
    await user.click(await screen.findByRole("button", { name: "Analizar DTC con IA" }));
    await user.click(screen.getByRole("button", { name: "Confirmar y analizar" }));

    const message = await screen.findByText(/Se recuperó el resultado existente sin repetir el procesamiento/u);
    expect(message.getAttribute("role")).toBe("status");
    expect(container.textContent).not.toContain(TEST_CONTENT_TOKEN);
    const analysisCall = fetchMock.mock.calls.find(([url]) => url === "/api/reports/analyze");
    const body = JSON.parse(String((analysisCall?.[1] as RequestInit).body)) as {
      historyContext: { contentToken: string };
    };
    expect(body.historyContext.contentToken).toBe(TEST_CONTENT_TOKEN);
  });

  it("gestiona el foco al abrir y cancelar la confirmación", async () => {
    const file = createPdf("foco-confirmacion.pdf");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValueOnce(readyAnalysisUpload(file)));
    const user = userEvent.setup();
    const { container } = await renderAuthenticatedApp();
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
    const { container, unmount } = await renderAuthenticatedApp();
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
    const { container } = await renderAuthenticatedApp();
    const { input } = getUploadElements(container);

    await user.upload(input, file);
    await user.click(screen.getByRole("button", { name: "Enviar reporte" }));

    expect(await screen.findByRole("heading", { name: "Orientación asistida por IA" })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Analizar DTC con IA" }));

    expect(screen.getByRole("heading", { name: "Confirma los datos que se enviarán" })).toBeTruthy();
    expect(screen.getByText(/No se enviarán/i)).toBeTruthy();
    expect(screen.getByText(/No se enviarán a OpenAI/i)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Confirmar y analizar" }));

    expect(await screen.findByRole("heading", { name: "Resumen técnico" })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const analysisCalls = fetchMock.mock.calls.filter(([url]) => url === "/api/reports/analyze");
    expect(analysisCalls).toHaveLength(1);

    const requestBody = JSON.parse(String((analysisCalls[0]?.[1] as RequestInit | undefined)?.body)) as Record<string, unknown>;
    expect(requestBody.input).toEqual({
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
    expect(requestBody.historyContext).toMatchObject({
      reportReference: "5f02d19b-5fd2-4128-aeb6-c5eef33554a0",
      extraction: { vehicle: { vinMasked: "*************6789", vinPseudonym: TEST_VIN_PSEUDONYM } },
    });
    const serialized = JSON.stringify(requestBody).toLowerCase();
    for (const forbidden of ["originalname", "sha256", "customer", "cliente", "rawtext"]) {
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
    const { container } = await renderAuthenticatedApp();
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

  it("502 de validación conserva sesión, reporte y observaciones sin mostrar mensaje remoto", async () => {
    const file = createPdf("validacion-sintetica.pdf");
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(readyAnalysisUpload(file))
      .mockResolvedValueOnce(createJsonResponse(false, { error: { code: "OPENAI_RESPONSE_INVALID", message: "REMOTE_PRIVATE_MESSAGE" } }, 502));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const auth = createTestAuthService({ signOutLocal: vi.fn(async () => undefined) });
    const { container } = await renderAuthenticatedApp(auth);
    const { input } = getUploadElements(container);
    await user.upload(input, file);
    await user.click(screen.getByRole("button", { name: "Enviar reporte" }));
    const observations = await screen.findByRole("textbox", { name: "Observaciones del vehículo (opcional)" });
    await user.type(observations, "Vibración al acelerar.");
    await user.click(await screen.findByRole("button", { name: "Analizar DTC con IA" }));
    await user.click(screen.getByRole("button", { name: "Confirmar y analizar" }));
    expect(await screen.findByText("El servicio devolvió una orientación que no pudo validarse.")).toBeTruthy();
    expect((observations as HTMLTextAreaElement).value).toBe("Vibración al acelerar.");
    expect(screen.getByRole("heading", { name: "Datos del reporte" })).toBeTruthy();
    expect(screen.queryByText("REMOTE_PRIVATE_MESSAGE")).toBeNull();
    expect(screen.queryByText(/Tu sesión continúa activa. Puedes reintentar/u)).toBeNull();
    expect(auth.signOutLocal).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/reports/analyze")).toHaveLength(1);
  });

  it("presenta la orientación separada con prioridades, causas, comprobaciones, advertencias y confianza", async () => {
    const file = createPdf("resultado-ia.pdf");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(readyAnalysisUpload(file))
      .mockResolvedValueOnce(successfulAnalysis());
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const { container } = await renderAuthenticatedApp();
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
    const { container } = await renderAuthenticatedApp();
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
    const { container } = await renderAuthenticatedApp();
    const { input } = getUploadElements(container);

    await user.upload(input, file);
    await user.click(screen.getByRole("button", { name: "Enviar reporte" }));
    await user.click(await screen.findByRole("button", { name: "Analizar DTC con IA" }));
    await user.click(screen.getByRole("button", { name: "Confirmar y analizar" }));

    expect(await screen.findByText("La solicitud de orientación agotó el tiempo disponible.")).toBeTruthy();
    expect(screen.queryByText(rawMessage)).toBeNull();
    expect(screen.getByRole("button", { name: "Reintentar" })).toBeTruthy();
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
    const { container } = await renderAuthenticatedApp();
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
    const { container } = await renderAuthenticatedApp();
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

describe("evidencia RAG visible y segura", () => {
  const usedRag = {
    enabled: true,
    used: true,
    status: "used",
    querySummary: "Consulta técnica con un módulo y un DTC; sin datos personales.",
    sources: [{
      id: "11111111-1111-4111-8111-111111111111",
      title: "Comprobación de alimentación y tierra",
      label: "AutoDiag IA — Corpus demostrativo interno",
      url: "https://example.test/conocimiento",
      similarity: 0.91,
      excerpt: "Verificar tensión y caída bajo carga antes de sustituir componentes.",
    }],
  };

  it("renderiza fuentes y las elimina al seleccionar otro reporte", async () => {
    const provenance = JSON.parse(readFileSync(resolve(process.cwd(), "../../fixtures/rag-provenance.synthetic.json"), "utf8"));
    const scopedRag = { ...usedRag, sources: [{ ...usedRag.sources[0]!, provenance }] };
    downloadReportPdfMock.mockResolvedValue("informe_sintetico.pdf");
    const first = createPdf("primero.pdf");
    const second = createPdf("segundo.pdf");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(readyAnalysisUpload(first))
      .mockResolvedValueOnce(successfulAnalysis(undefined, scopedRag));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const { container } = await renderAuthenticatedApp();
    const { input } = getUploadElements(container);
    await user.upload(input, first);
    await user.click(screen.getByRole("button", { name: "Enviar reporte" }));
    await user.click(await screen.findByRole("button", { name: "Analizar DTC con IA" }));
    await user.click(screen.getByRole("button", { name: "Confirmar y analizar" }));

    expect(await screen.findByRole("heading", { name: "Evidencia recuperada por RAG" })).toBeTruthy();
    expect(screen.getByText("1 fuente")).toBeTruthy();
    expect(screen.getByText(/mercado del vehículo: desconocido/u)).toBeTruthy();
    expect(screen.getByText(/Equipamiento y mercado del vehículo sin comprobar/u)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Descargar informe PDF" }));
    expect(downloadReportPdfMock.mock.calls[0]?.[0].rag.sources[0]?.provenance).toEqual(provenance);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/Comprobación de alimentación y tierra/u)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Consultar fuente HTTPS" }).getAttribute("href"))
      .toBe("https://example.test/conocimiento");

    await user.upload(input, second);
    expect(screen.queryByRole("heading", { name: "Evidencia recuperada por RAG" })).toBeNull();
    expect(screen.queryByText(/Comprobación de alimentación y tierra/u)).toBeNull();
  });

  it("rechaza una respuesta que intente mostrar un enlace no HTTPS", async () => {
    const file = createPdf("url-insegura.pdf");
    const unsafeRag = {
      ...usedRag,
      sources: [{ ...usedRag.sources[0]!, url: "http://example.test/inseguro" }],
    };
    vi.stubGlobal("fetch", vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(readyAnalysisUpload(file))
      .mockResolvedValueOnce(successfulAnalysis(undefined, unsafeRag)));
    const user = userEvent.setup();
    const { container } = await renderAuthenticatedApp();
    const { input } = getUploadElements(container);
    await user.upload(input, file);
    await user.click(screen.getByRole("button", { name: "Enviar reporte" }));
    await user.click(await screen.findByRole("button", { name: "Analizar DTC con IA" }));
    await user.click(screen.getByRole("button", { name: "Confirmar y analizar" }));
    expect(await screen.findByText("El servicio devolvió una orientación que no pudo validarse.")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Consultar fuente HTTPS" })).toBeNull();
  });

  it.each([
    ["contenido", { excerpt: "Contacto 55551234" }],
    ["nombre PDF", { title: "reporte-cliente.pdf" }],
    ["clave", { label: ["sb", "secret", "syntheticValue123456"].join("_") }],
    ["parámetro URL", { url: "https://example.test/manual.pdf?token=valor-sintetico" }],
  ])("rechaza una fuente contaminada en %s antes de mostrarla", async (_case, override) => {
    const file = createPdf("respuesta-contaminada.pdf");
    const contaminatedRag = {
      ...usedRag,
      sources: [{ ...usedRag.sources[0]!, ...override }],
    };
    vi.stubGlobal("fetch", vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(readyAnalysisUpload(file))
      .mockResolvedValueOnce(successfulAnalysis(undefined, contaminatedRag)));
    const user = userEvent.setup();
    const { container } = await renderAuthenticatedApp();
    const { input } = getUploadElements(container);
    await user.upload(input, file);
    await user.click(screen.getByRole("button", { name: "Enviar reporte" }));
    await user.click(await screen.findByRole("button", { name: "Analizar DTC con IA" }));
    await user.click(screen.getByRole("button", { name: "Confirmar y analizar" }));

    expect(await screen.findByText("El servicio devolvió una orientación que no pudo validarse.")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Evidencia recuperada por RAG" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Consultar fuente HTTPS" })).toBeNull();
  });

  it("elimina las fuentes al cerrar sesión", async () => {
    const file = createPdf("cierre-sesion.pdf");
    vi.stubGlobal("fetch", vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(readyAnalysisUpload(file))
      .mockResolvedValueOnce(successfulAnalysis(undefined, usedRag)));
    const user = userEvent.setup();
    const { container } = await renderAuthenticatedApp();
    const { input } = getUploadElements(container);
    await user.upload(input, file);
    await user.click(screen.getByRole("button", { name: "Enviar reporte" }));
    await user.click(await screen.findByRole("button", { name: "Analizar DTC con IA" }));
    await user.click(screen.getByRole("button", { name: "Confirmar y analizar" }));
    expect(await screen.findByText(/Comprobación de alimentación y tierra/u)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Cerrar sesión" }));
    expect(await screen.findByRole("button", { name: "Iniciar sesión" })).toBeTruthy();
    expect(screen.queryByText(/Comprobación de alimentación y tierra/u)).toBeNull();
  });
});

describe("historial seguro de diagnósticos", () => {
  it("carga páginas adicionales sin duplicar registros", async () => {
    const firstPage = await historyListResponse().json() as { items: Array<Record<string, unknown>> };
    const secondId = "88888888-8888-4888-8888-888888888888";
    const authenticatedFetch = vi.fn<BrowserAuthenticationService["authenticatedFetch"]>()
      .mockResolvedValueOnce(createJsonResponse(true, { ...firstPage, nextCursor: "next-page" }))
      .mockResolvedValueOnce(createJsonResponse(true, {
        items: [{
          ...firstPage.items[0],
          id: secondId,
          vehicle: { make: "Segunda Marca", model: "Segundo Modelo", year: 2025 },
        }],
        nextCursor: null,
      }));
    const user = userEvent.setup();
    await renderAuthenticatedApp(createTestAuthService({ authenticatedFetch }));

    await user.click(screen.getByRole("button", { name: "Historial" }));
    expect(await screen.findByRole("button", { name: "Cargar más" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Cargar más" }));

    expect(await screen.findByRole("button", { name: "Abrir diagnóstico de Segunda Marca Segundo Modelo" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Abrir diagnóstico de Marca Histórica Modelo Seguro" })).toBeTruthy();
    expect(authenticatedFetch.mock.calls.map(([url]) => String(url))).toEqual([
      "/api/history?limit=20",
      "/api/history?limit=20&cursor=next-page",
    ]);
  });

  it.each([false, true])("integra historial, PDF local y n8n explícito (procedencia: %s)", async (scoped) => {
    const provenance = JSON.parse(readFileSync(resolve(process.cwd(), "../../fixtures/rag-provenance.synthetic.json"), "utf8"));
    const authenticatedFetch = vi.fn<BrowserAuthenticationService["authenticatedFetch"]>(async (input, init) => {
      const url = String(input);
      if (url === `/api/history/${HISTORY_ID}/automation`) {
        expect(init?.method).toBe("POST");
        expect(init?.body).toBeUndefined();
        return createJsonResponse(true, { status: "completed" });
      }
      expect(init?.method).toBeUndefined();
      if (url === "/api/automation/capabilities") return createJsonResponse(true, { enabled: true });
      if (url === "/api/history?limit=20") return historyListResponse();
      if (url === `/api/history/${HISTORY_ID}`) {
        const detail = await historyDetailResponse().json();
        if (scoped) detail.history.snapshot.rag.sources[0].provenance = provenance;
        return createJsonResponse(true, detail);
      }
      throw new Error(`Solicitud inesperada: ${url}`);
    });
    downloadReportPdfMock.mockResolvedValue("AutoDiagIA_Informe_historico.pdf");
    const user = userEvent.setup();
    await renderAuthenticatedApp(createTestAuthService({ authenticatedFetch }));

    await user.click(screen.getByRole("button", { name: "Historial" }));
    const historyButton = await screen.findByRole("button", { name: "Abrir diagnóstico de Marca Histórica Modelo Seguro" });
    await user.click(historyButton);

    expect(await screen.findByRole("heading", { name: "Orientación guardada" })).toBeTruthy();
    const automationButton = await screen.findByRole("button", { name: "Registrar evento en n8n" });
    expect(screen.getByRole("button", { name: "Estadísticas" })).toBeTruthy();
    expect(screen.getByText("Orientación histórica validada.")).toBeTruthy();
    expect(screen.getByText("Odómetro: 45,678 km")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Evidencia recuperada por RAG" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Consultar fuente HTTPS" }).getAttribute("href")).toBe("https://example.com/manual");

    const requestsBeforeDownload = authenticatedFetch.mock.calls.length;
    await user.click(screen.getByRole("button", { name: "Descargar informe PDF" }));

    expect(downloadReportPdfMock).toHaveBeenCalledTimes(1);
    expect(authenticatedFetch).toHaveBeenCalledTimes(requestsBeforeDownload);
    expect(authenticatedFetch.mock.calls.map(([url]) => String(url))).toEqual([
      "/api/history?limit=20",
      `/api/history/${HISTORY_ID}`,
      "/api/automation/capabilities",
    ]);
    expect(authenticatedFetch.mock.calls.some(([url]) => String(url).includes("/api/reports/analyze"))).toBe(false);
    const exported = downloadReportPdfMock.mock.calls[0]?.[0];
    expect(exported?.rag.sources[0]?.provenance).toEqual(scoped ? provenance : undefined);
    expect(exported?.vehicle.odometer).toEqual({ value: 45678, unit: "km" });
    expect(JSON.stringify(exported)).not.toMatch(/vin|reportReference|analysisModel|embeddingModel/iu);
    await user.click(automationButton);
    expect(await screen.findByText("Recepción del evento confirmada. El diagnóstico no fue modificado.")).toBeTruthy();
    expect(authenticatedFetch).toHaveBeenCalledTimes(requestsBeforeDownload + 1);
    expect(authenticatedFetch.mock.calls.at(-1)?.[0]).toBe(`/api/history/${HISTORY_ID}/automation`);
    expect(screen.getByText("Orientación histórica validada.")).toBeTruthy();
  });

  it("rechaza una instantánea histórica contaminada antes de mostrarla o exportarla", async () => {
    const contaminated = await historyDetailResponse().json() as {
      history: { snapshot: { extraction: { vehicle: { engine: string } } } };
    };
    contaminated.history.snapshot.extraction.vehicle.engine = "API_KEY=valor-sintetico";
    const authenticatedFetch = vi.fn<BrowserAuthenticationService["authenticatedFetch"]>(async (input) => (
      String(input) === "/api/history?limit=20"
        ? historyListResponse()
        : createJsonResponse(true, contaminated)
    ));
    const user = userEvent.setup();
    await renderAuthenticatedApp(createTestAuthService({ authenticatedFetch }));

    await user.click(screen.getByRole("button", { name: "Historial" }));
    await user.click(await screen.findByRole("button", { name: "Abrir diagnóstico de Marca Histórica Modelo Seguro" }));

    expect(await screen.findByText("El servidor devolvió un diagnóstico inválido.")).toBeTruthy();
    expect(screen.queryByText("API_KEY=valor-sintetico")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Orientación guardada" })).toBeNull();
    expect(downloadReportPdfMock).not.toHaveBeenCalled();
  });

  it("elimina el historial visible al cerrar sesión", async () => {
    const authenticatedFetch = vi.fn<BrowserAuthenticationService["authenticatedFetch"]>(async () => historyListResponse());
    const signOutLocal = vi.fn(async () => undefined);
    const user = userEvent.setup();
    await renderAuthenticatedApp(createTestAuthService({ authenticatedFetch, signOutLocal }));

    await user.click(screen.getByRole("button", { name: "Historial" }));
    expect(await screen.findByRole("button", { name: "Abrir diagnóstico de Marca Histórica Modelo Seguro" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Cerrar sesión" }));

    expect(await screen.findByRole("button", { name: "Iniciar sesión" })).toBeTruthy();
    expect(screen.queryByText("Marca Histórica")).toBeNull();
    expect(signOutLocal).toHaveBeenCalledOnce();
  });

  it("descarta el historial anterior cuando cambia la identidad autenticada", async () => {
    let authListener: ((event: SupportedAuthEvent, userId?: string | null) => void) | undefined;
    const secondIdentity = { id: "8b34944b-afec-40ad-a1ee-e31978be731e", username: "otro.usuario" };
    const authenticatedFetch = vi.fn<BrowserAuthenticationService["authenticatedFetch"]>(async () => historyListResponse());
    const authService = createTestAuthService({
      authenticatedFetch,
      validateCurrentSession: async () => secondIdentity,
      subscribe: (listener) => {
        authListener = listener;
        return () => undefined;
      },
    });
    const user = userEvent.setup();
    await renderAuthenticatedApp(authService);
    await user.click(screen.getByRole("button", { name: "Historial" }));
    expect(await screen.findByRole("button", { name: "Abrir diagnóstico de Marca Histórica Modelo Seguro" })).toBeTruthy();

    await act(async () => {
      authListener?.("TOKEN_REFRESHED", secondIdentity.id);
    });

    expect(await screen.findByText("otro.usuario")).toBeTruthy();
    expect(screen.queryByText("Marca Histórica")).toBeNull();
    expect(screen.getByRole("heading", { name: "Carga tu reporte Autel" })).toBeTruthy();
  });

  it("aborta una lista pendiente al cerrar sesión y descarta su respuesta tardía", async () => {
    const pendingList = createDeferred<Response>();
    let listSignal: AbortSignal | undefined;
    const authenticatedFetch = vi.fn<BrowserAuthenticationService["authenticatedFetch"]>((_input, init) => {
      listSignal = init?.signal as AbortSignal | undefined;
      return pendingList.promise;
    });
    const user = userEvent.setup();
    await renderAuthenticatedApp(createTestAuthService({ authenticatedFetch }));

    await user.click(screen.getByRole("button", { name: "Historial" }));
    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalledOnce());
    await user.click(screen.getByRole("button", { name: "Cerrar sesión" }));

    expect(await screen.findByRole("button", { name: "Iniciar sesión" })).toBeTruthy();
    expect(listSignal?.aborted).toBe(true);
    await act(async () => pendingList.resolve(historyListResponse()));
    expect(screen.queryByText("Marca Histórica")).toBeNull();
    expect(screen.queryByRole("button", { name: "Cargar más" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("aborta un detalle pendiente al cerrar sesión y descarta su respuesta tardía", async () => {
    const pendingDetail = createDeferred<Response>();
    let detailSignal: AbortSignal | undefined;
    const authenticatedFetch = vi.fn<BrowserAuthenticationService["authenticatedFetch"]>((input, init) => {
      if (String(input) === "/api/history?limit=20") return Promise.resolve(historyListResponse());
      detailSignal = init?.signal as AbortSignal | undefined;
      return pendingDetail.promise;
    });
    const user = userEvent.setup();
    await renderAuthenticatedApp(createTestAuthService({ authenticatedFetch }));

    await user.click(screen.getByRole("button", { name: "Historial" }));
    await user.click(await screen.findByRole("button", { name: "Abrir diagnóstico de Marca Histórica Modelo Seguro" }));
    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole("button", { name: "Cerrar sesión" }));

    expect(await screen.findByRole("button", { name: "Iniciar sesión" })).toBeTruthy();
    expect(detailSignal?.aborted).toBe(true);
    await act(async () => pendingDetail.resolve(historyDetailResponse()));
    expect(screen.queryByText("Orientación histórica validada.")).toBeNull();
    expect(downloadReportPdfMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("descarta una lista pendiente de A y permite cargar exclusivamente la lista de B", async () => {
    const pendingUserA = createDeferred<Response>();
    let authListener: ((event: SupportedAuthEvent, userId?: string | null) => void) | undefined;
    let listSignal: AbortSignal | undefined;
    const secondIdentity = { id: "8b34944b-afec-40ad-a1ee-e31978be731e", username: "otro.usuario" };
    const secondPage = await historyListResponse().json() as { items: Array<Record<string, unknown>>; nextCursor: null };
    secondPage.items[0] = {
      ...secondPage.items[0],
      id: "88888888-8888-4888-8888-888888888888",
      vehicle: { make: "Marca B", model: "Modelo B", year: 2025 },
    };
    const authenticatedFetch = vi.fn<BrowserAuthenticationService["authenticatedFetch"]>((_input, init) => {
      if (authenticatedFetch.mock.calls.length === 1) {
        listSignal = init?.signal as AbortSignal | undefined;
        return pendingUserA.promise;
      }
      return Promise.resolve(createJsonResponse(true, secondPage));
    });
    const authService = createTestAuthService({
      authenticatedFetch,
      validateCurrentSession: async () => secondIdentity,
      subscribe: (listener) => {
        authListener = listener;
        return () => undefined;
      },
    });
    const user = userEvent.setup();
    await renderAuthenticatedApp(authService);

    await user.click(screen.getByRole("button", { name: "Historial" }));
    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalledOnce());
    await act(async () => authListener?.("TOKEN_REFRESHED", secondIdentity.id));
    expect(await screen.findByText("otro.usuario")).toBeTruthy();
    expect(listSignal?.aborted).toBe(true);
    await act(async () => pendingUserA.resolve(historyListResponse()));

    await user.click(screen.getByRole("button", { name: "Historial" }));
    expect(await screen.findByRole("button", { name: "Abrir diagnóstico de Marca B Modelo B" })).toBeTruthy();
    expect(screen.queryByText("Marca Histórica")).toBeNull();
    expect(authenticatedFetch).toHaveBeenCalledTimes(2);
  });

  it("descarta un detalle pendiente de A y permite cargar exclusivamente el historial de B", async () => {
    const pendingDetailA = createDeferred<Response>();
    let authListener: ((event: SupportedAuthEvent, userId?: string | null) => void) | undefined;
    let detailSignal: AbortSignal | undefined;
    const secondIdentity = { id: "8b34944b-afec-40ad-a1ee-e31978be731e", username: "otro.usuario" };
    const secondPage = await historyListResponse().json() as { items: Array<Record<string, unknown>>; nextCursor: null };
    secondPage.items[0] = {
      ...secondPage.items[0],
      id: "88888888-8888-4888-8888-888888888888",
      vehicle: { make: "Marca B", model: "Modelo B", year: 2025 },
    };
    const authenticatedFetch = vi.fn<BrowserAuthenticationService["authenticatedFetch"]>((input, init) => {
      const url = String(input);
      if (url === `/api/history/${HISTORY_ID}`) {
        detailSignal = init?.signal as AbortSignal | undefined;
        return pendingDetailA.promise;
      }
      if (authenticatedFetch.mock.calls.length >= 3) return Promise.resolve(createJsonResponse(true, secondPage));
      return Promise.resolve(historyListResponse());
    });
    const authService = createTestAuthService({
      authenticatedFetch,
      validateCurrentSession: async () => secondIdentity,
      subscribe: (listener) => {
        authListener = listener;
        return () => undefined;
      },
    });
    const user = userEvent.setup();
    await renderAuthenticatedApp(authService);

    await user.click(screen.getByRole("button", { name: "Historial" }));
    await user.click(await screen.findByRole("button", { name: "Abrir diagnóstico de Marca Histórica Modelo Seguro" }));
    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalledTimes(2));
    await act(async () => authListener?.("TOKEN_REFRESHED", secondIdentity.id));
    expect(await screen.findByText("otro.usuario")).toBeTruthy();
    expect(detailSignal?.aborted).toBe(true);
    await act(async () => pendingDetailA.resolve(historyDetailResponse()));

    await user.click(screen.getByRole("button", { name: "Historial" }));
    expect(await screen.findByRole("button", { name: "Abrir diagnóstico de Marca B Modelo B" })).toBeTruthy();
    expect(screen.queryByText("Orientación histórica validada.")).toBeNull();
    expect(authenticatedFetch).toHaveBeenCalledTimes(3);
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
    const { container } = await renderAuthenticatedApp();
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
    expect(exported?.vehicle.odometer).toEqual({ value: 45678, unit: "km" });
    expect(JSON.stringify(exported)).not.toMatch(/vin|Motor privado|originalName|sha256|vin_v1_private/iu);
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
    const { container } = await renderAuthenticatedApp();
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
    const { container } = await renderAuthenticatedApp();
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
    const { container } = await renderAuthenticatedApp();
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
    const { container } = await renderAuthenticatedApp();
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

describe("resiliencia de comunicación con la API", () => {
  it("un timeout durante análisis conserva sesión, observaciones y datos sin reintento automático", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const file = createPdf("timeout-analisis.pdf");
    const signOutLocal = vi.fn(async () => undefined);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(readyAnalysisUpload(file))
      .mockResolvedValueOnce(createJsonResponse(false, { error: { code: "ANALYSIS_TIMEOUT" } }, 504))
      .mockResolvedValueOnce(successfulAnalysis({
        status: "no_clear_match",
        summary: "Resultado recuperado sin duplicar la operación.",
        matches: [],
      }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const { container } = await renderAuthenticatedApp(createTestAuthService({ signOutLocal }));
    const { input } = getUploadElements(container);
    const observations = "Vibración sintética al acelerar";

    await user.upload(input, file);
    await user.click(screen.getByRole("button", { name: "Enviar reporte" }));
    const textarea = screen.getByRole("textbox", { name: "Observaciones del vehículo (opcional)" }) as HTMLTextAreaElement;
    await user.type(textarea, observations);
    await user.click(await screen.findByRole("button", { name: "Analizar DTC con IA" }));
    await user.click(screen.getByRole("button", { name: "Confirmar y analizar" }));

    expect(await screen.findByText("Servidor temporalmente no disponible")).toBeTruthy();
    expect(screen.getByText("P0300")).toBeTruthy();
    expect(textarea.value).toBe(observations);
    expect(screen.getAllByRole("button", { name: "Reintentar" }).length).toBeGreaterThan(0);
    expect(screen.getByText(/Puede continuar procesándose/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Iniciar sesión" })).toBeNull();
    expect(signOutLocal).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/reports/analyze")).toHaveLength(1);
    expect(setTimeoutSpy.mock.calls.some(([, delay]) => delay === 160_000)).toBe(true);

    await user.click(screen.getAllByRole("button", { name: "Reintentar" })[0]!);
    await user.click(await screen.findByRole("button", { name: "Confirmar y analizar" }));
    expect(await screen.findByText("Resultado recuperado sin duplicar la operación.")).toBeTruthy();
    const analysisCalls = fetchMock.mock.calls.filter(([url]) => url === "/api/reports/analyze");
    expect(analysisCalls).toHaveLength(2);
    const firstKey = ((analysisCalls[0]?.[1] as RequestInit).headers as Record<string, string>)["Idempotency-Key"];
    const retryKey = ((analysisCalls[1]?.[1] as RequestInit).headers as Record<string, string>)["Idempotency-Key"];
    expect(retryKey).toBe(firstKey);
  });

  it.each([
    [500, "server"],
    [429, "rate limit"],
  ])("un HTTP %i durante análisis es recuperable y no repite el POST (%s)", async (status) => {
    const file = createPdf(`http-${status}.pdf`);
    const signOutLocal = vi.fn(async () => undefined);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(readyAnalysisUpload(file))
      .mockResolvedValueOnce(createJsonResponse(false, { error: { code: "TEMPORARY_FAILURE" } }, status));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const { container } = await renderAuthenticatedApp(createTestAuthService({ signOutLocal }));

    await user.upload(getUploadElements(container).input, file);
    await user.click(screen.getByRole("button", { name: "Enviar reporte" }));
    await user.click(await screen.findByRole("button", { name: "Analizar DTC con IA" }));
    await user.click(screen.getByRole("button", { name: "Confirmar y analizar" }));

    expect(await screen.findByRole("heading", { name: "No fue posible obtener la orientación" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Iniciar sesión" })).toBeNull();
    expect(signOutLocal).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/reports/analyze")).toHaveLength(1);
  });

  it("restablece la conectividad con health sin borrar un resultado existente", async () => {
    const file = createPdf("resultado-conservado.pdf");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(readyAnalysisUpload(file))
      .mockResolvedValueOnce(successfulAnalysis())
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(createJsonResponse(true, { status: "ok" }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const { container } = await renderAuthenticatedApp();

    await user.upload(getUploadElements(container).input, file);
    await user.click(screen.getByRole("button", { name: "Enviar reporte" }));
    await user.click(await screen.findByRole("button", { name: "Analizar DTC con IA" }));
    await user.click(screen.getByRole("button", { name: "Confirmar y analizar" }));
    expect(await screen.findByRole("heading", { name: "Resumen técnico" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Historial" }));
    expect(await screen.findByText("Servidor temporalmente no disponible")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Comprobar conexión" }));

    await waitFor(() => expect(screen.queryByText("Servidor temporalmente no disponible")).toBeNull());
    await user.click(screen.getByRole("button", { name: "Nuevo diagnóstico" }));
    expect(screen.getByRole("heading", { name: "Resumen técnico" })).toBeTruthy();
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/health")).toHaveLength(1);
  });

  it("conserva el historial cargado si una página posterior falla", async () => {
    const firstPage = await historyListResponse().json() as { items: unknown[] };
    const authenticatedFetch = vi
      .fn<BrowserAuthenticationService["authenticatedFetch"]>()
      .mockResolvedValueOnce(createJsonResponse(true, { ...firstPage, nextCursor: "next-page" }))
      .mockRejectedValueOnce(new TypeError("ECONNRESET"))
      .mockRejectedValueOnce(new TypeError("ECONNRESET"));
    const signOutLocal = vi.fn(async () => undefined);
    const user = userEvent.setup();
    await renderAuthenticatedApp(createTestAuthService({ authenticatedFetch, signOutLocal }));

    await user.click(screen.getByRole("button", { name: "Historial" }));
    const existing = await screen.findByRole("button", { name: "Abrir diagnóstico de Marca Histórica Modelo Seguro" });
    await user.click(screen.getByRole("button", { name: "Cargar más" }));

    expect(await screen.findByText("Servidor temporalmente no disponible")).toBeTruthy();
    expect(existing).toBeTruthy();
    expect(screen.getByRole("button", { name: "Abrir diagnóstico de Marca Histórica Modelo Seguro" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Reintentar" }).length).toBeGreaterThan(0);
    expect(authenticatedFetch).toHaveBeenCalledTimes(3);
    expect(signOutLocal).not.toHaveBeenCalled();
  });

  it("bloquea reintentos rápidos del historial mientras la solicitud sigue activa", async () => {
    const pendingRetry = createDeferred<Response>();
    const authenticatedFetch = vi
      .fn<BrowserAuthenticationService["authenticatedFetch"]>()
      .mockRejectedValueOnce(new TypeError("synthetic network failure"))
      .mockRejectedValueOnce(new TypeError("synthetic network failure"))
      .mockReturnValueOnce(pendingRetry.promise);
    const user = userEvent.setup();
    await renderAuthenticatedApp(createTestAuthService({ authenticatedFetch }));

    await user.click(screen.getByRole("button", { name: "Historial" }));
    await waitFor(() => expect(document.querySelector(".history-error button")).toBeTruthy());
    const retry = document.querySelector<HTMLButtonElement>(".history-error button");
    if (!retry) throw new Error("No se encontró el reintento del historial.");

    fireEvent.click(retry);
    fireEvent.click(retry);

    expect(authenticatedFetch).toHaveBeenCalledTimes(3);
    await act(async () => pendingRetry.resolve(historyListResponse()));
    expect(await screen.findByRole("button", { name: "Abrir diagnóstico de Marca Histórica Modelo Seguro" })).toBeTruthy();
  });

  it("ignora una respuesta tardía de health después de cerrar sesión", async () => {
    const file = createPdf("health-logout.pdf");
    const pendingHealth = createDeferred<Response>();
    const fetchMock = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("synthetic upload failure"))
      .mockReturnValueOnce(pendingHealth.promise);
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const { container } = await renderAuthenticatedApp();

    await user.upload(getUploadElements(container).input, file);
    await user.click(screen.getByRole("button", { name: "Enviar reporte" }));
    await screen.findByText("Servidor temporalmente no disponible");
    await user.click(screen.getByRole("button", { name: "Comprobar conexión" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole("button", { name: "Cerrar sesión" }));
    expect(await screen.findByRole("button", { name: "Iniciar sesión" })).toBeTruthy();

    await act(async () => pendingHealth.resolve(createJsonResponse(true, { status: "ok" })));

    expect(screen.getByRole("button", { name: "Iniciar sesión" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Carga tu reporte Autel" })).toBeNull();
  });

  it("ignora health tardío del usuario A después de cambiar al UUID B", async () => {
    const file = createPdf("health-identidad.pdf");
    const pendingHealth = createDeferred<Response>();
    const fetchMock = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("synthetic upload failure"))
      .mockReturnValueOnce(pendingHealth.promise);
    vi.stubGlobal("fetch", fetchMock);
    const secondIdentity = { id: "8b34944b-afec-40ad-a1ee-e31978be731e", username: "otro.usuario" };
    let authListener: ((event: SupportedAuthEvent, userId?: string | null) => void) | undefined;
    const authService = createTestAuthService({
      validateCurrentSession: async () => secondIdentity,
      subscribe: (listener) => {
        authListener = listener;
        return () => undefined;
      },
    });
    const user = userEvent.setup();
    const { container } = await renderAuthenticatedApp(authService);

    await user.upload(getUploadElements(container).input, file);
    await user.click(screen.getByRole("button", { name: "Enviar reporte" }));
    await screen.findByText("Servidor temporalmente no disponible");
    const check = screen.getByRole("button", { name: "Comprobar conexión" });
    fireEvent.click(check);
    fireEvent.click(check);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await act(async () => authListener?.("SIGNED_IN", secondIdentity.id));
    expect(await screen.findByText(secondIdentity.username)).toBeTruthy();

    await act(async () => pendingHealth.resolve(createJsonResponse(true, { status: "ok" })));

    expect(screen.getByText(secondIdentity.username)).toBeTruthy();
    expect(screen.queryByText(TEST_IDENTITY.username)).toBeNull();
    expect(screen.queryByText(file.name)).toBeNull();
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === "/api/health")).toHaveLength(1);
  });

  it("oculta PDF, análisis e historial de A durante la validación fallida de B y abre B limpio al reintentar", async () => {
    const file = createPdf("privado-usuario-a.pdf");
    const secondIdentity = { id: "8b34944b-afec-40ad-a1ee-e31978be731e", username: "otro.usuario" };
    const initialize = vi.fn(async () => TEST_IDENTITY);
    const validateCurrentSession = vi.fn<BrowserAuthenticationService["validateCurrentSession"]>();
    let authListener: ((event: SupportedAuthEvent, userId?: string | null) => void) | undefined;
    const authService = createTestAuthService({
      initialize,
      validateCurrentSession,
      subscribe: (listener) => {
        authListener = listener;
        return () => undefined;
      },
    });
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === "/api/reports/upload") return readyAnalysisUpload(file);
      if (url === "/api/reports/analyze") return successfulAnalysis();
      if (url === "/api/history?limit=20") return historyListResponse();
      if (url === "/api/health") return createJsonResponse(true, { status: "ok" });
      throw new Error(`Solicitud sintética inesperada: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const { container } = await renderAuthenticatedApp(authService);

    await user.upload(getUploadElements(container).input, file);
    await user.click(screen.getByRole("button", { name: "Enviar reporte" }));
    await user.click(await screen.findByRole("button", { name: "Analizar DTC con IA" }));
    await user.click(screen.getByRole("button", { name: "Confirmar y analizar" }));
    expect(await screen.findByRole("heading", { name: "Resumen técnico" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Historial" }));
    expect(await screen.findByRole("button", { name: "Abrir diagnóstico de Marca Histórica Modelo Seguro" })).toBeTruthy();

    validateCurrentSession.mockRejectedValueOnce(new BrowserAuthenticationError(
      "AUTH_PROVIDER_UNAVAILABLE",
      "No fue posible iniciar sesión. Intenta nuevamente.",
    ));
    await act(async () => authListener?.("SIGNED_IN", secondIdentity.id));

    expect(await screen.findByRole("heading", { name: "Servidor temporalmente no disponible" })).toBeTruthy();
    expect(screen.queryByText(file.name)).toBeNull();
    expect(screen.queryByRole("heading", { name: "Resumen técnico" })).toBeNull();
    expect(screen.queryByText("Marca Histórica")).toBeNull();
    expect(screen.queryByRole("button", { name: "Iniciar sesión" })).toBeNull();

    initialize.mockResolvedValueOnce(secondIdentity);
    await user.click(screen.getByRole("button", { name: "Comprobar conexión" }));

    expect(await screen.findByText(secondIdentity.username)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Carga tu reporte Autel" })).toBeTruthy();
    expect(screen.queryByText(file.name)).toBeNull();
    expect(screen.queryByRole("heading", { name: "Resumen técnico" })).toBeNull();
    expect(screen.queryByText("Marca Histórica")).toBeNull();
  });
});
