import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolvePdfExtractionLimits, type PdfExtractionLimits } from "./config.js";
import type { ExtractedPdfPage } from "./report-types.js";
import { MAX_PDF_INPUT_BYTES, PDF_PROCESS_TIMEOUT_EXIT_CODE, maxPdfResponseBytes, parsePdfProcessResponse } from "./pdf-process-protocol.js";
import type { PdfWorkerErrorCode } from "./pdf-extractor-worker.mjs";

export type PdfExtractionErrorCode = PdfWorkerErrorCode | "PDF_EXTRACTION_TIMEOUT";
const SAFE_MESSAGES: Record<PdfExtractionErrorCode, string> = {
  PDF_ENCRYPTED: "El PDF está cifrado y no puede procesarse.",
  PDF_UNREADABLE: "El PDF está dañado o no puede leerse.",
  PDF_NO_USABLE_TEXT: "El PDF no contiene texto digital utilizable.",
  PDF_EXTRACTION_LIMIT_EXCEEDED: "El PDF excede los límites seguros de extracción.",
  PDF_EXTRACTION_TIMEOUT: "La extracción del PDF excedió el tiempo permitido.",
  PDF_EXTRACTION_ERROR: "No fue posible extraer el contenido del PDF.",
};
export class PdfExtractionError extends Error {
  constructor(public readonly code: PdfExtractionErrorCode) { super(SAFE_MESSAGES[code]); }
}
export type PdfProcessFactory = (executable: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
export interface PdfExtractorRuntime {
  processFactory?: PdfProcessFactory;
  processUrl?: URL;
  signal?: AbortSignal;
  maxFileSizeBytes?: number;
}
export const MAX_PDF_EXTRACTION_PROCESSES = 2;
let activeProcesses = 0;
const children = new Set<ChildProcessWithoutNullStreams>();
// Synchronous exit hook; abrupt death is also observed through the IPC channel.
process.once("exit", () => { for (const child of children) child.kill("SIGKILL"); });

function processOptions(limits: PdfExtractionLimits) {
  const source = import.meta.url.endsWith(".ts");
  const args = [`--max-old-space-size=${limits.workerMemoryMb}`, "--stack-size=4096"];
  if (source) args.push("--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href);
  // Never inherit API execArgv, NODE_OPTIONS, env-file flags or credentials.
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP"]) {
    const value = process.env[key]; if (value !== undefined) env[key] = value;
  }
  return { args, env, url: new URL(source ? "./pdf-extractor-child.mts" : "./pdf-extractor-child.mjs", import.meta.url) };
}

export async function extractPdfPages(buffer: Buffer, inputLimits: Partial<PdfExtractionLimits> = {}, runtime: PdfExtractorRuntime = {}): Promise<ExtractedPdfPage[]> {
  const limits = resolvePdfExtractionLimits(inputLimits);
  if (runtime.signal?.aborted) throw new PdfExtractionError("PDF_EXTRACTION_ERROR");
  const inputCap = Math.min(runtime.maxFileSizeBytes ?? MAX_PDF_INPUT_BYTES, MAX_PDF_INPUT_BYTES);
  if (!buffer.length || buffer.length > inputCap || activeProcesses >= MAX_PDF_EXTRACTION_PROCESSES) {
    throw new PdfExtractionError("PDF_EXTRACTION_LIMIT_EXCEEDED");
  }
  activeProcesses++;
  const deadlineAtMs = Date.now() + limits.timeoutMs;
  try {
    return await new Promise<ExtractedPdfPage[]>((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      const { args, env, url } = processOptions(limits);
      try {
        child = (runtime.processFactory ?? ((executable, argv, options) => spawn(executable, argv,
          { ...options, stdio: ["pipe", "pipe", "pipe", "ipc"] }) as ChildProcessWithoutNullStreams))(
          process.execPath, [...args, fileURLToPath(runtime.processUrl ?? url)], { env, shell: false, windowsHide: true });
      } catch { reject(new PdfExtractionError("PDF_EXTRACTION_ERROR")); return; }
      children.add(child);
      let failure: PdfExtractionError | undefined;
      let closed = false;
      let bytes = 0;
      const chunks: Buffer[] = [];
      const fail = (code: PdfExtractionErrorCode = "PDF_EXTRACTION_ERROR") => {
        if (closed || failure) return;
        failure = new PdfExtractionError(code);
        // Capacity remains occupied until close, even if kill fails.
        child.kill("SIGKILL");
      };
      const abort = () => fail();
      const onOutput = (chunk: Buffer) => {
        if (failure) return;
        bytes += chunk.length;
        if (bytes > maxPdfResponseBytes(limits)) { fail("PDF_EXTRACTION_LIMIT_EXCEEDED"); return; }
        chunks.push(chunk);
      };
      const onError = () => fail();
      const onInputError = () => fail();
      let processingSeen = false;
      const onMessage = (value: unknown) => {
        if (value !== "processing" || processingSeen) { fail(); return; }
        processingSeen = true;
        child.send?.("start", (error: Error | null) => { if (error) fail(); });
      };
      const timer = setTimeout(() => fail("PDF_EXTRACTION_TIMEOUT"), limits.timeoutMs);
      child.on("error", onError);
      child.on("message", onMessage);
      child.stdin.on("error", onInputError);
      child.stdout.on("error", onError);
      child.stderr.on("error", onError);
      child.stdout.on("data", onOutput);
      child.stderr.resume(); // Never forward library/native diagnostics.
      runtime.signal?.addEventListener("abort", abort, { once: true });
      const finish = (code: number | null, signal: NodeJS.Signals | null) => {
        if (closed) return;
        children.delete(child);
        closed = true; clearTimeout(timer);
        runtime.signal?.removeEventListener("abort", abort);
        child.removeListener("error", onError);
        child.removeListener("message", onMessage);
        child.removeListener("close", finish);
        child.removeListener("exit", onExit);
        child.removeListener("disconnect", maybeFinish);
        child.stdout.removeListener("close", maybeFinish); child.stderr.removeListener("close", maybeFinish);
        child.stdin.removeListener("error", onInputError);
        child.stdout.removeListener("error", onError); child.stderr.removeListener("error", onError);
        child.stdout.removeListener("data", onOutput);
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
        if (!failure && (code !== 0 || signal)) failure = new PdfExtractionError(
          code === PDF_PROCESS_TIMEOUT_EXIT_CODE && !signal ? "PDF_EXTRACTION_TIMEOUT" : "PDF_EXTRACTION_ERROR");
        if (failure) { reject(failure); return; }
        try {
          const response = parsePdfProcessResponse(JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")), limits);
          if (!response.ok) reject(new PdfExtractionError(response.code)); else resolve(response.pages);
        } catch { reject(new PdfExtractionError("PDF_EXTRACTION_ERROR")); }
      };
      let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
      const maybeFinish = () => {
        // Node can omit ChildProcess.close after a disconnect during message dispatch.
        // exit + closed output pipes + disconnected IPC still prove physical termination.
        if (exited && child.stdout.closed && child.stderr.closed && !child.connected) finish(exited.code, exited.signal);
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => { exited = { code, signal }; maybeFinish(); };
      child.once("close", finish);
      child.once("exit", onExit);
      child.on("disconnect", maybeFinish);
      child.stdout.on("close", maybeFinish); child.stderr.on("close", maybeFinish);
      if (runtime.signal?.aborted) { abort(); return; }
      child.stdin.write(JSON.stringify({ size: buffer.length, deadlineAtMs, limits }) + "\n");
      child.stdin.end(buffer);
    });
  } finally { activeProcesses--; }
}
