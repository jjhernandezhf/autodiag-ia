// @vitest-environment jsdom

import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildReportExportModel,
  createReportFilename,
  downloadReportPdf,
  renderReportPdf,
  REPORT_PDF_TEXT,
  ReportPdfValidationError,
  validateReportExportModel,
  type ReportExportSource,
} from "./report-pdf";

const logo = new Uint8Array(readFileSync(resolve(process.cwd(), "src/assets/autodiag-ia-logo.png")));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function createSource(status: "not_provided" | "no_clear_match" | "matches_found" = "matches_found"): ReportExportSource {
  const hasObservation = status !== "not_provided";
  return {
    vehicle: { make: "Marca Sintética", model: "Modelo Académico", year: 2025 },
    counts: { systems: 2, detected: 3, actionable: 1, historical: 2 },
    actionableModules: [{
      code: "PCM",
      name: "Módulo motriz",
      dtcs: [{
        code: "P0300",
        description: "Fallo de encendido múltiple sintético",
        status: "current",
        alsoHistorical: true,
      }],
    }],
    documentaryDtcs: [
      {
        code: "P0300",
        moduleCode: "PCM",
        moduleName: "Módulo motriz",
        description: "Fallo de encendido múltiple sintético",
        originalStatus: "Actual",
        normalizedClassification: "actionable",
      },
      {
        code: "P0300",
        moduleCode: "PCM",
        moduleName: "Módulo motriz",
        description: "Fallo de encendido múltiple sintético",
        originalStatus: "Histórico",
        normalizedClassification: "historical",
      },
      {
        code: "B1000",
        moduleCode: "SRS",
        moduleName: "Módulo de seguridad",
        description: "Antecedente documental sintético",
        originalStatus: "Memorizado",
        normalizedClassification: "historical",
      },
    ],
    analysis: {
      technicalSummary: "Resumen técnico sintético con acentos y señal intermitente.",
      findings: [{
        relatedDtc: { code: "P0300", moduleCode: "PCM", moduleName: "Módulo motriz" },
        priority: "high",
        simpleExplanation: "La combustión irregular requiere comprobación profesional.",
        possibleCauses: ["Conexión eléctrica deficiente", "Componente de encendido desgastado"],
        recommendedChecks: ["Inspeccionar conectores", "Medir la señal según el fabricante"],
        safetyWarnings: ["Trabajar con el motor frío cuando corresponda"],
        confidence: "medium",
      }],
      observationCorrelation: {
        status,
        summary: status === "not_provided"
          ? "Sin observaciones."
          : status === "no_clear_match"
            ? "No se encontró una relación clara con los DTC accionables."
            : "La vibración podría guardar relación con el DTC, sin confirmar causalidad.",
        matches: status === "matches_found" ? [{
          relatedDtc: { code: "P0300", moduleCode: "PCM", moduleName: "Módulo motriz" },
          observation: "Vibración al acelerar.",
          possibleRelation: "Podría relacionarse con la combustión irregular; debe verificarse.",
          confidence: "low",
        }] : [],
      },
      safetyWarnings: ["No sustituir piezas sin realizar comprobaciones"],
      confidence: "medium",
      requiresTechnicianConfirmation: true,
    },
    submittedObservations: hasObservation ? "  Vibración al acelerar.  " : "",
  };
}

function pdfText(bytes: Uint8Array) {
  return new TextDecoder("latin1").decode(bytes);
}

describe("recurso gráfico oficial", () => {
  it("conserva el PNG horizontal de alta resolución, transparencia y solo bloques necesarios", () => {
    expect(Array.from(logo.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const view = new DataView(logo.buffer, logo.byteOffset, logo.byteLength);
    expect(view.getUint32(16)).toBe(2172);
    expect(view.getUint32(20)).toBe(724);
    expect(logo[25]).toBe(6);

    const chunks: string[] = [];
    let offset = 8;
    while (offset + 12 <= logo.length) {
      const length = view.getUint32(offset);
      const type = new TextDecoder("ascii").decode(logo.slice(offset + 4, offset + 8));
      chunks.push(type);
      offset += length + 12;
      if (type === "IEND") break;
    }
    expect(chunks[0]).toBe("IHDR");
    expect(chunks.at(-1)).toBe("IEND");
    expect(chunks).not.toContain("caBX");
    expect(chunks.every((chunk) => ["IHDR", "IDAT", "IEND"].includes(chunk))).toBe(true);
  });
});

describe("modelo seguro del informe PDF", () => {
  it("construye una copia con lista blanca, orden estable e identidad módulo+código", () => {
    const source = createSource();
    const before = structuredClone(source);
    const sourceWithPrivateFields = Object.assign(source, {
      vin: "dato-que-no-debe-copiarse",
      originalName: "archivo-privado.pdf",
      sha256: "hash-privado",
      rawResponse: "respuesta-interna",
    });

    const model = buildReportExportModel(sourceWithPrivateFields);

    expect(source).toEqual({ ...before, vin: "dato-que-no-debe-copiarse", originalName: "archivo-privado.pdf", sha256: "hash-privado", rawResponse: "respuesta-interna" });
    expect(Object.keys(model)).toEqual(["vehicle", "summary", "actionableDtcs", "historicalDtcs", "analysis", "observations"]);
    expect(model.actionableDtcs.map((dtc) => [dtc.moduleCode, dtc.code])).toEqual([["PCM", "P0300"]]);
    expect(model.actionableDtcs[0]?.alsoHistorical).toBe(true);
    expect(model.historicalDtcs.map((dtc) => [dtc.moduleCode, dtc.code])).toEqual([["SRS", "B1000"]]);
    expect(model.observations.used).toBe("Vibración al acelerar.");
    expect(JSON.stringify(model)).not.toMatch(/dato-que-no|archivo-privado|hash-privado|respuesta-interna/iu);
  });

  it.each(["not_provided", "no_clear_match", "matches_found"] as const)(
    "conserva el estado de observaciones %s sin inventar coincidencias",
    (status) => {
      const model = buildReportExportModel(createSource(status));
      expect(model.observations.status).toBe(status);
      expect(model.observations.matches).toHaveLength(status === "matches_found" ? 1 : 0);
      expect(model.observations.used).toBe(status === "not_provided" ? null : "Vibración al acelerar.");
      if (status === "not_provided") expect(model.observations.summary).toBe(REPORT_PDF_TEXT.NOT_PROVIDED_MESSAGE);
    },
  );

  it("rechaza referencias ajenas y propiedades desconocidas", () => {
    const source = createSource();
    source.analysis.observationCorrelation.matches[0]!.relatedDtc.code = "P9999";
    expect(() => buildReportExportModel(source)).toThrow(ReportPdfValidationError);

    const model = buildReportExportModel(createSource()) as ReturnType<typeof buildReportExportModel> & { token?: string };
    model.token = "valor";
    expect(() => validateReportExportModel(model)).toThrow(ReportPdfValidationError);
  });

  it.each([
    "1HGCM82633A123456",
    "persona@example.test",
    "sk-syntheticSecretValue123",
    "token=synthetic-secret",
    "C:\\clientes\\reporte.pdf",
    "a".repeat(64),
    "+502 5555 1234",
  ])("bloquea contenido sensible sin revelarlo en el error", (sensitiveValue) => {
    const source = createSource();
    source.analysis.technicalSummary = sensitiveValue;
    expect(() => buildReportExportModel(source)).toThrow(
      "No fue posible generar el informe porque los datos no superaron la validación de privacidad.",
    );
  });
});

describe("documento PDF", () => {
  it("genera un PDF no vacío, con imagen, texto autorizado, fecha y numeración", () => {
    const generatedAt = new Date(2026, 8, 7, 10, 15, 0);
    const bytes = renderReportPdf(buildReportExportModel(createSource()), generatedAt, logo);
    const raw = pdfText(bytes);

    expect(raw.startsWith("%PDF-")).toBe(true);
    expect(bytes.length).toBeGreaterThan(10_000);
    expect(raw).toContain("/Subtype /Image");
    expect(raw).toContain("Informe de orientaci");
    expect(raw).toContain("7 de septiembre de 2026");
    expect(raw).toContain("Resumen del veh");
    expect(raw).toContain("Sistemas escaneados");
    expect(raw).toContain("Resumen t");
    expect(raw).toContain("P0300");
    expect(raw).toContain("Posibles causas");
    expect(raw).toContain("Comprobaciones recomendadas");
    expect(raw).toContain("Advertencias de seguridad");
    expect(raw).toContain("Confianza");
    expect(raw).toContain("Antecedentes hist");
    expect(raw).toContain("Requiere confirmaci");
    expect(raw).toMatch(/P.gina 1 de \d/u);
    expect(raw).not.toMatch(/archivo-privado|vin_v1|od.metro|sha256|rawResponse|prompt|token=/iu);
  });

  it("pagina contenido extenso sin producir una página final vacía", () => {
    const source = createSource();
    const longText = "Descripción técnica extensa con acentos, señal y comprobación profesional. ".repeat(12);
    source.analysis.technicalSummary = longText;
    source.analysis.findings = Array.from({ length: 10 }, (_, index) => ({
      relatedDtc: index === 0 ? { code: "P0300", moduleCode: "PCM", moduleName: "Módulo motriz" } : null,
      priority: index % 2 === 0 ? "high" as const : "medium" as const,
      simpleExplanation: longText,
      possibleCauses: Array.from({ length: 5 }, (_, cause) => `Causa sintética ${index + 1}.${cause + 1} con información extensa.`),
      recommendedChecks: Array.from({ length: 6 }, (_, check) => `Comprobación sintética ${index + 1}.${check + 1} según documentación.`),
      safetyWarnings: ["Aplicar procedimientos de seguridad antes de intervenir."],
      confidence: "medium" as const,
    }));
    const bytes = renderReportPdf(buildReportExportModel(source), new Date(2026, 8, 7, 12, 0), logo);
    const raw = pdfText(bytes);
    const pages = raw.match(/\/Type \/Page\b/gu) ?? [];

    expect(pages.length).toBeGreaterThan(2);
    expect(raw).toContain(`Página ${pages.length} de ${pages.length}`);
    expect(raw).toContain("Comprobación sintética 10.6");
  });

  it("representa not_provided una sola vez y sin aviso de coincidencias", () => {
    const raw = pdfText(renderReportPdf(
      buildReportExportModel(createSource("not_provided")),
      new Date(2026, 8, 7, 12, 0),
      logo,
    ));
    expect(raw.match(/No se proporcionaron observaciones adicionales/gu)).toHaveLength(1);
    expect(raw).not.toContain(REPORT_PDF_TEXT.MATCH_CAUTION);
    expect(raw).not.toMatch(/coincidencias? (?:es|son) orientativas?/iu);
  });

  it("crea un nombre local seguro y metadatos sin datos del vehículo", () => {
    const generatedAt = new Date(2026, 8, 7, 6, 5, 0);
    expect(createReportFilename(generatedAt)).toBe("AutoDiagIA_Informe_2026-09-07_06-05.pdf");
    expect(createReportFilename(generatedAt)).not.toMatch(/Marca|Modelo|P0300/iu);
  });

  it("descarga una sola vez mediante un objeto local y lo libera", async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const createObjectURL = vi.fn(() => "blob:autodiag-synthetic");
    const revokeObjectURL = vi.fn();
    const fetchMock = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    vi.stubGlobal("fetch", fetchMock);
    const filename = await downloadReportPdf(
      buildReportExportModel(createSource()),
      new Date(2026, 8, 7, 6, 5, 0),
      logo,
    );

    expect(filename).toBe("AutoDiagIA_Informe_2026-09-07_06-05.pdf");
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:autodiag-synthetic");
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("reutiliza el logo ya cargado sin solicitarlo por HTTP durante la descarga", async () => {
    const realCreateElement = document.createElement.bind(document);
    const canvas = realCreateElement("canvas");
    const drawImage = vi.fn();
    vi.spyOn(canvas, "getContext").mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
    vi.spyOn(canvas, "toDataURL").mockReturnValue(`data:image/png;base64,${Buffer.from(logo).toString("base64")}`);
    const createElement = vi.spyOn(document, "createElement").mockImplementation((tagName, options) =>
      tagName === "canvas" ? canvas : realCreateElement(tagName, options)
    );
    const image = realCreateElement("img");
    image.src = "/src/assets/autodiag-ia-logo.png";
    Object.defineProperties(image, {
      complete: { value: true },
      naturalWidth: { value: 2172 },
      naturalHeight: { value: 724 },
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const fetchMock = vi.fn();
    const xhrOpen = vi.spyOn(XMLHttpRequest.prototype, "open");
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:local"), revokeObjectURL: vi.fn() });

    await downloadReportPdf(buildReportExportModel(createSource()), new Date(2026, 8, 7, 6, 5), image);

    expect(drawImage).toHaveBeenCalledWith(image, 0, 0, 2172, 724);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(xhrOpen).not.toHaveBeenCalled();
    expect(click).toHaveBeenCalledTimes(1);
    createElement.mockRestore();
    vi.unstubAllGlobals();
  });
});
