import { isMainThread, parentPort, workerData } from "node:worker_threads";

import type { PdfExtractionLimits } from "./config.js";
import type { ExtractedPdfPage, ExtractedTextFragment, ExtractedTextLine } from "./report-types.js";

export type PdfWorkerErrorCode =
  | "PDF_ENCRYPTED"
  | "PDF_UNREADABLE"
  | "PDF_NO_USABLE_TEXT"
  | "PDF_EXTRACTION_LIMIT_EXCEEDED"
  | "PDF_EXTRACTION_ERROR";

export class PdfWorkerError extends Error {
  constructor(public readonly code: PdfWorkerErrorCode) {
    super(code);
  }
}

interface PdfTextItemSource {
  str: string;
  width?: number;
  transform: number[];
}

interface EssentialTextItem {
  text: string;
  x: number;
  y: number;
  width: number;
}

interface PdfTextContentChunk {
  items: unknown[];
}

interface PdfTextStreamReader {
  read(): Promise<{ done: boolean; value?: PdfTextContentChunk }>;
  cancel(): Promise<void>;
  releaseLock(): void;
}

interface PdfTextStream {
  getReader(): PdfTextStreamReader;
}

interface PdfPageProxy {
  streamTextContent(): PdfTextStream;
  cleanup(): void;
}

interface PdfDocumentProxy {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPageProxy>;
  destroy(): Promise<void>;
}

interface PdfLoadingTask {
  promise: Promise<PdfDocumentProxy>;
  destroy(): Promise<void>;
}

export type PdfDocumentLoader = (data: Uint8Array) => PdfLoadingTask;

interface WorkerInput {
  buffer: ArrayBuffer;
  limits: PdfExtractionLimits;
}

interface WorkerSuccess {
  ok: true;
  pages: ExtractedPdfPage[];
}

interface WorkerFailure {
  ok: false;
  code: PdfWorkerErrorCode;
}

function isPdfTextItem(value: unknown): value is PdfTextItemSource {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PdfTextItemSource>;
  return typeof candidate.str === "string" && Array.isArray(candidate.transform) && candidate.transform.length >= 6;
}

function joinFragments(fragments: ExtractedTextFragment[]) {
  return fragments
    .map((fragment) => fragment.text.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function reconstructLines(items: EssentialTextItem[], verticalTolerance = 2.5): ExtractedTextLine[] {
  const fragments = items
    .filter((item) => item.text.trim() !== "")
    .map((item) => ({
      text: item.text,
      x: item.x,
      y: item.y,
      width: item.width,
    }))
    .sort((left, right) => right.y - left.y || left.x - right.x);

  const groups: Array<{ y: number; fragments: ExtractedTextFragment[] }> = [];

  for (const fragment of fragments) {
    const group = groups.find((candidate) => Math.abs(candidate.y - fragment.y) <= verticalTolerance);
    if (group) {
      group.fragments.push(fragment);
      group.y = (group.y * (group.fragments.length - 1) + fragment.y) / group.fragments.length;
    } else {
      groups.push({ y: fragment.y, fragments: [fragment] });
    }
  }

  return groups
    .sort((left, right) => right.y - left.y)
    .map((group) => {
      const sortedFragments = group.fragments.sort((left, right) => left.x - right.x);
      return { text: joinFragments(sortedFragments), y: group.y, fragments: sortedFragments };
    })
    .filter((line) => line.text !== "");
}

function mapLibraryError(error: unknown) {
  if (error instanceof PdfWorkerError) return error;
  const name = error instanceof Error ? error.name : "";
  if (name === "PasswordException") return new PdfWorkerError("PDF_ENCRYPTED");
  if (["InvalidPDFException", "MissingPDFException", "UnexpectedResponseException"].includes(name)) {
    return new PdfWorkerError("PDF_UNREADABLE");
  }
  return new PdfWorkerError("PDF_EXTRACTION_ERROR");
}

export async function defaultDocumentLoader(data: Uint8Array): Promise<PdfLoadingTask> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjs.getDocument({
    data,
    isEvalSupported: false,
    useSystemFonts: true,
    verbosity: pdfjs.VerbosityLevel.ERRORS,
  }) as unknown as PdfLoadingTask;
}

async function releaseResource(action: (() => void | Promise<void>) | undefined) {
  if (!action) return;
  try {
    await action();
  } catch {
    // Los errores internos de limpieza no deben sustituir el resultado seguro de la extracción.
  }
}

export async function extractPdfDocument(
  buffer: Uint8Array,
  limits: PdfExtractionLimits,
  loader: PdfDocumentLoader | typeof defaultDocumentLoader = defaultDocumentLoader,
): Promise<ExtractedPdfPage[]> {
  let loadingTask: PdfLoadingTask | undefined;
  let document: PdfDocumentProxy | undefined;

  try {
    loadingTask = await loader(buffer);
    document = await loadingTask.promise;

    if (document.numPages > limits.maxPages) throw new PdfWorkerError("PDF_EXTRACTION_LIMIT_EXCEEDED");

    const pages: ExtractedPdfPage[] = [];
    let totalTextItems = 0;
    let totalCharacters = 0;

    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      let page: PdfPageProxy | undefined;
      let reader: PdfTextStreamReader | undefined;
      let streamFinished = false;
      try {
        page = await document.getPage(pageNumber);
        reader = page.streamTextContent().getReader();
        const pageItems: EssentialTextItem[] = [];

        while (true) {
          const chunk = await reader.read();
          if (chunk.done) {
            streamFinished = true;
            break;
          }

          for (const item of chunk.value?.items ?? []) {
            if (!isPdfTextItem(item)) continue;
            if (totalTextItems + 1 > limits.maxTextItems) {
              throw new PdfWorkerError("PDF_EXTRACTION_LIMIT_EXCEEDED");
            }
            if (totalCharacters + item.str.length > limits.maxCharacters) {
              throw new PdfWorkerError("PDF_EXTRACTION_LIMIT_EXCEEDED");
            }
            totalTextItems += 1;
            totalCharacters += item.str.length;
            pageItems.push({
              text: item.str,
              x: item.transform[4] ?? 0,
              y: item.transform[5] ?? 0,
              width: item.width ?? 0,
            });
          }
        }

        pages.push({ pageNumber, lines: reconstructLines(pageItems) });
      } finally {
        const readerToRelease = reader;
        if (readerToRelease && !streamFinished) {
          await releaseResource(() => readerToRelease.cancel());
        }
        await releaseResource(readerToRelease ? () => readerToRelease.releaseLock() : undefined);
        const pageToRelease = page;
        await releaseResource(pageToRelease ? () => pageToRelease.cleanup() : undefined);
      }
    }

    if (!pages.some((page) => page.lines.some((line) => line.text.trim() !== ""))) {
      throw new PdfWorkerError("PDF_NO_USABLE_TEXT");
    }

    return pages;
  } catch (error) {
    throw mapLibraryError(error);
  } finally {
    const documentToRelease = document;
    const taskToRelease = loadingTask;
    await releaseResource(documentToRelease ? () => documentToRelease.destroy() : undefined);
    await releaseResource(taskToRelease ? () => taskToRelease.destroy() : undefined);
  }
}

if (!isMainThread) {
  const port = parentPort;
  const input = workerData as WorkerInput;

  void (async () => {
    let response: WorkerSuccess | WorkerFailure;
    try {
      const pages = await extractPdfDocument(new Uint8Array(input.buffer), input.limits);
      response = { ok: true, pages };
    } catch (error) {
      response = {
        ok: false,
        code: error instanceof PdfWorkerError ? error.code : "PDF_EXTRACTION_ERROR",
      };
    }
    port?.postMessage(response);
    port?.close();
  })();
}
