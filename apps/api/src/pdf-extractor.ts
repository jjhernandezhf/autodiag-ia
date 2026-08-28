import { Worker, type WorkerOptions } from "node:worker_threads";

import {
  resolvePdfExtractionLimits,
  type PdfExtractionLimits,
} from "./config.js";
import type { ExtractedPdfPage } from "./report-types.js";
import type { PdfWorkerErrorCode } from "./pdf-extractor-worker.mjs";

export type PdfExtractionErrorCode =
  | PdfWorkerErrorCode
  | "PDF_EXTRACTION_TIMEOUT";

const SAFE_MESSAGES: Record<PdfExtractionErrorCode, string> = {
  PDF_ENCRYPTED: "El PDF está cifrado y no puede procesarse.",
  PDF_UNREADABLE: "El PDF está dañado o no puede leerse.",
  PDF_NO_USABLE_TEXT: "El PDF no contiene texto digital utilizable.",
  PDF_EXTRACTION_LIMIT_EXCEEDED: "El PDF excede los límites seguros de extracción.",
  PDF_EXTRACTION_TIMEOUT: "La extracción del PDF excedió el tiempo permitido.",
  PDF_EXTRACTION_ERROR: "No fue posible extraer el contenido del PDF.",
};

export class PdfExtractionError extends Error {
  constructor(public readonly code: PdfExtractionErrorCode) {
    super(SAFE_MESSAGES[code]);
  }
}

interface WorkerSuccess {
  ok: true;
  pages: ExtractedPdfPage[];
}

interface WorkerFailure {
  ok: false;
  code: PdfWorkerErrorCode;
}

type WorkerResponse = WorkerSuccess | WorkerFailure;

export type PdfWorkerFactory = (url: URL, options: WorkerOptions) => Worker;

export interface PdfExtractorRuntime {
  workerFactory?: PdfWorkerFactory;
  workerUrl?: URL;
  workerExecArgv?: string[];
}

function isWorkerResponse(value: unknown): value is WorkerResponse {
  if (!value || typeof value !== "object" || !("ok" in value)) return false;
  const candidate = value as Partial<WorkerResponse>;
  return candidate.ok === true ? Array.isArray((candidate as Partial<WorkerSuccess>).pages) : typeof (candidate as Partial<WorkerFailure>).code === "string";
}

function defaultWorkerUrl() {
  return new URL(import.meta.url.endsWith(".ts") ? "./pdf-extractor-worker.mts" : "./pdf-extractor-worker.mjs", import.meta.url);
}

function defaultWorkerExecArgv() {
  return import.meta.url.endsWith(".ts") ? ["--import", "tsx"] : [];
}

function executeWorker(
  buffer: Buffer,
  limits: PdfExtractionLimits,
  runtime: PdfExtractorRuntime,
): Promise<ExtractedPdfPage[]> {
  const transferableBuffer = Uint8Array.from(buffer).buffer;
  const workerFactory = runtime.workerFactory ?? ((url, options) => new Worker(url, options));
  const worker = workerFactory(runtime.workerUrl ?? defaultWorkerUrl(), {
    workerData: { buffer: transferableBuffer, limits },
    transferList: [transferableBuffer],
    execArgv: runtime.workerExecArgv ?? defaultWorkerExecArgv(),
    resourceLimits: {
      maxOldGenerationSizeMb: limits.workerMemoryMb,
      stackSizeMb: 4,
    },
    stdout: true,
    stderr: true,
  });
  for (const output of [worker.stdout, worker.stderr]) {
    if (!output) continue;
    output.on("error", () => undefined);
    output.resume();
  }

  return new Promise((resolve, reject) => {
    let settling = false;

    const removeListeners = () => {
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
    };

    const settleAfterTermination = (result: ExtractedPdfPage[] | PdfExtractionError) => {
      if (settling) return;
      settling = true;
      clearTimeout(timeout);
      removeListeners();
      void worker.terminate().then(
        () => {
          if (result instanceof PdfExtractionError) reject(result);
          else resolve(result);
        },
        () => reject(new PdfExtractionError("PDF_EXTRACTION_ERROR")),
      );
    };

    const onMessage = (message: unknown) => {
      if (!isWorkerResponse(message)) {
        settleAfterTermination(new PdfExtractionError("PDF_EXTRACTION_ERROR"));
        return;
      }
      settleAfterTermination(message.ok ? message.pages : new PdfExtractionError(message.code));
    };

    const onError = (error: Error & { code?: string }) => {
      settleAfterTermination(
        new PdfExtractionError(error.code === "ERR_WORKER_OUT_OF_MEMORY" ? "PDF_EXTRACTION_LIMIT_EXCEEDED" : "PDF_EXTRACTION_ERROR"),
      );
    };

    const onExit = () => {
      settleAfterTermination(new PdfExtractionError("PDF_EXTRACTION_ERROR"));
    };

    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.on("exit", onExit);

    const timeout = setTimeout(() => {
      settleAfterTermination(new PdfExtractionError("PDF_EXTRACTION_TIMEOUT"));
    }, limits.timeoutMs);
    timeout.unref();
  });
}

export async function extractPdfPages(
  buffer: Buffer,
  inputLimits: Partial<PdfExtractionLimits> = {},
  runtime: PdfExtractorRuntime = {},
): Promise<ExtractedPdfPage[]> {
  const limits = resolvePdfExtractionLimits(inputLimits);
  return executeWorker(buffer, limits, runtime);
}
