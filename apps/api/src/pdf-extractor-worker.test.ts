import { describe, expect, it, vi } from "vitest";

const pdfJsMocks = vi.hoisted(() => ({
  getDocument: vi.fn(() => ({ promise: Promise.resolve(undefined), destroy: vi.fn(async () => undefined) })),
}));

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  getDocument: pdfJsMocks.getDocument,
  VerbosityLevel: { ERRORS: 0 },
}));

import { DEFAULT_PDF_EXTRACTION_LIMITS } from "./config.js";
import {
  defaultDocumentLoader,
  extractPdfDocument,
  PdfWorkerError,
  type PdfDocumentLoader,
} from "./pdf-extractor-worker.mjs";

function textItem(text: string) {
  return { str: text, width: text.length, transform: [1, 0, 0, 1, 10, 700] };
}

interface HarnessOptions {
  readErrorAt?: number;
  cancelFails?: boolean;
  cleanupFails?: boolean;
}

function createPdfHarness(chunks: unknown[][], declaredPages = 1, options: HarnessOptions = {}) {
  let chunkIndex = 0;
  const read = vi.fn(async () => {
    if (options.readErrorAt === chunkIndex) throw new Error("detalle interno de lectura");
    if (chunkIndex < chunks.length) {
      const items = chunks[chunkIndex] ?? [];
      chunkIndex += 1;
      return { done: false, value: { items } };
    }
    return { done: true };
  });
  const cancel = vi.fn(async () => {
    if (options.cancelFails) throw new Error("detalle interno de cancelación");
  });
  const releaseLock = vi.fn(() => undefined);
  const getReader = vi.fn(() => ({ read, cancel, releaseLock }));
  const streamTextContent = vi.fn(() => ({ getReader }));
  const getTextContent = vi.fn(async () => {
    throw new Error("getTextContent no debe utilizarse");
  });
  const pageCleanup = vi.fn(() => {
    if (options.cleanupFails) throw new Error("detalle interno de limpieza");
  });
  const documentDestroy = vi.fn(async () => undefined);
  const taskDestroy = vi.fn(async () => undefined);
  const getPage = vi.fn(async () => ({ streamTextContent, getTextContent, cleanup: pageCleanup }));
  const loader: PdfDocumentLoader = () => ({
    promise: Promise.resolve({ numPages: declaredPages, getPage, destroy: documentDestroy }),
    destroy: taskDestroy,
  });

  return {
    loader,
    read,
    cancel,
    releaseLock,
    getReader,
    streamTextContent,
    getTextContent,
    getPage,
    pageCleanup,
    documentDestroy,
    taskDestroy,
  };
}

describe("núcleo aislado de extracción PDF", () => {
  it("configura getDocument con el nivel oficial de solo errores", async () => {
    const data = new Uint8Array([1, 2, 3]);

    await defaultDocumentLoader(data);

    expect(pdfJsMocks.getDocument).toHaveBeenCalledWith({
      data,
      isEvalSupported: false,
      useSystemFonts: true,
      verbosity: 0,
    });
  });

  it("rechaza el exceso de páginas antes de recorrer el documento y libera sus recursos", async () => {
    const harness = createPdfHarness([], 2);

    await expect(
      extractPdfDocument(new Uint8Array(), { ...DEFAULT_PDF_EXTRACTION_LIMITS, maxPages: 1 }, harness.loader),
    ).rejects.toMatchObject({ code: "PDF_EXTRACTION_LIMIT_EXCEEDED" });
    expect(harness.getPage).not.toHaveBeenCalled();
    expect(harness.documentDestroy).toHaveBeenCalledOnce();
    expect(harness.taskDestroy).toHaveBeenCalledOnce();
  });

  it("consume bloques incrementalmente sin invocar getTextContent", async () => {
    const harness = createPdfHarness([[textItem("primer bloque")], [textItem("segundo bloque")]]);

    const pages = await extractPdfDocument(new Uint8Array(), DEFAULT_PDF_EXTRACTION_LIMITS, harness.loader);

    expect(pages).toHaveLength(1);
    expect(harness.read).toHaveBeenCalledTimes(3);
    expect(harness.streamTextContent).toHaveBeenCalledOnce();
    expect(harness.getTextContent).not.toHaveBeenCalled();
    expect(harness.cancel).not.toHaveBeenCalled();
    expect(harness.releaseLock).toHaveBeenCalledOnce();
    expect(harness.pageCleanup).toHaveBeenCalledOnce();
    expect(harness.documentDestroy).toHaveBeenCalledOnce();
    expect(harness.taskDestroy).toHaveBeenCalledOnce();
  });

  it("cancela al exceder elementos sin solicitar el bloque siguiente", async () => {
    const nextBlockText = vi.fn(() => "no-debe-leerse");
    const nextBlockItem = {
      get str() {
        return nextBlockText();
      },
      width: 10,
      transform: [1, 0, 0, 1, 10, 600],
    };
    const harness = createPdfHarness([[textItem("uno"), textItem("dos")], [nextBlockItem]]);

    await expect(
      extractPdfDocument(new Uint8Array(), { ...DEFAULT_PDF_EXTRACTION_LIMITS, maxTextItems: 1 }, harness.loader),
    ).rejects.toMatchObject({ code: "PDF_EXTRACTION_LIMIT_EXCEEDED" });
    expect(harness.read).toHaveBeenCalledOnce();
    expect(nextBlockText).not.toHaveBeenCalled();
    expect(harness.cancel).toHaveBeenCalledOnce();
    expect(harness.releaseLock).toHaveBeenCalledOnce();
    expect(harness.pageCleanup).toHaveBeenCalledOnce();
  });

  it("no copia el elemento que excede caracteres y cancela sin leer otro bloque", async () => {
    const copiedWidth = vi.fn(() => 2);
    const overLimitItem = {
      str: "56",
      get width() {
        return copiedWidth();
      },
      transform: [1, 0, 0, 1, 10, 600],
    };
    const harness = createPdfHarness([[textItem("1234"), overLimitItem], [textItem("bloque posterior")]]);

    await expect(
      extractPdfDocument(new Uint8Array(), { ...DEFAULT_PDF_EXTRACTION_LIMITS, maxCharacters: 5 }, harness.loader),
    ).rejects.toMatchObject({ code: "PDF_EXTRACTION_LIMIT_EXCEEDED" });
    expect(copiedWidth).not.toHaveBeenCalled();
    expect(harness.read).toHaveBeenCalledOnce();
    expect(harness.cancel).toHaveBeenCalledOnce();
    expect(harness.releaseLock).toHaveBeenCalledOnce();
    expect(harness.pageCleanup).toHaveBeenCalledOnce();
  });

  it("cancela y libera el bloqueo cuando el stream falla", async () => {
    const harness = createPdfHarness([], 1, { readErrorAt: 0 });

    await expect(extractPdfDocument(new Uint8Array(), DEFAULT_PDF_EXTRACTION_LIMITS, harness.loader)).rejects.toEqual(
      new PdfWorkerError("PDF_EXTRACTION_ERROR"),
    );
    expect(harness.cancel).toHaveBeenCalledOnce();
    expect(harness.releaseLock).toHaveBeenCalledOnce();
    expect(harness.pageCleanup).toHaveBeenCalledOnce();
    expect(harness.documentDestroy).toHaveBeenCalledOnce();
    expect(harness.taskDestroy).toHaveBeenCalledOnce();
  });

  it("conserva el error de límite aunque fallen cancelación y limpieza", async () => {
    const harness = createPdfHarness([[textItem("uno"), textItem("dos")]], 1, {
      cancelFails: true,
      cleanupFails: true,
    });

    await expect(
      extractPdfDocument(new Uint8Array(), { ...DEFAULT_PDF_EXTRACTION_LIMITS, maxTextItems: 1 }, harness.loader),
    ).rejects.toEqual(new PdfWorkerError("PDF_EXTRACTION_LIMIT_EXCEEDED"));
    expect(harness.cancel).toHaveBeenCalledOnce();
    expect(harness.releaseLock).toHaveBeenCalledOnce();
    expect(harness.pageCleanup).toHaveBeenCalledOnce();
    expect(harness.documentDestroy).toHaveBeenCalledOnce();
    expect(harness.taskDestroy).toHaveBeenCalledOnce();
  });
});
