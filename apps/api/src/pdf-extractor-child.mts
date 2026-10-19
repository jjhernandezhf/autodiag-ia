import { requestHeaderSchema, PDF_PROCESS_TIMEOUT_EXIT_CODE, maxPdfResponseBytes, parsePdfProcessResponse, type PdfProcessResponse } from "./pdf-process-protocol.js";
import { extractPdfDocument, PdfWorkerError } from "./pdf-extractor-worker.mjs";
import { DEFAULT_PDF_EXTRACTION_LIMITS } from "./config.js";

// Dedicated liveness channel stays open throughout parsing, unlike stdin (PDF EOF).
// This is process termination, not a promise race leaving PDF.js running.
if (!process.connected) process.exit(1);
let completed = false;
process.once("disconnect", () => { if (!completed) process.exit(1); });
let allowStart: () => void;
let startReceived = false;
const startPermission = new Promise<void>((resolve) => { allowStart = resolve; });
process.on("message", (message: unknown) => {
  if (message !== "start" || startReceived) process.exit(1);
  startReceived = true; allowStart();
});
let watchdog = setTimeout(() => process.exit(PDF_PROCESS_TIMEOUT_EXIT_CODE), DEFAULT_PDF_EXTRACTION_LIMITS.timeoutMs);

// Runs on the child process main thread, never in worker_threads.
async function main() {
  let header: ReturnType<typeof requestHeaderSchema.parse> | undefined;
  let prefix = Buffer.alloc(0);
  const parts: Buffer[] = [];
  let size = 0;
  let response: PdfProcessResponse;
  try {
    for await (const data of process.stdin) {
      let chunk = Buffer.from(data as Uint8Array);
      if (!header) {
        const newline = chunk.indexOf(10);
        if (newline < 0) {
          if (prefix.length + chunk.length > 1024) throw new Error("Header limit");
          prefix = Buffer.concat([prefix, chunk]); continue;
        }
        if (prefix.length + newline > 1024) throw new Error("Header limit");
        header = requestHeaderSchema.parse(JSON.parse(Buffer.concat([prefix, chunk.subarray(0, newline)]).toString("utf8")));
        clearTimeout(watchdog);
        const remainingMs = Math.min(header.limits.timeoutMs, header.deadlineAtMs - Date.now());
        if (remainingMs <= 0) process.exit(PDF_PROCESS_TIMEOUT_EXIT_CODE);
        watchdog = setTimeout(() => process.exit(PDF_PROCESS_TIMEOUT_EXIT_CODE), remainingMs);
        prefix = Buffer.alloc(0); chunk = chunk.subarray(newline + 1);
      }
      size += chunk.length;
      if (size > header.size) throw new Error("Input limit");
      parts.push(chunk);
    }
    if (!header || size !== header.size) throw new Error("Incomplete input");
    process.send?.("processing");
    await startPermission;
    const pages = await extractPdfDocument(new Uint8Array(Buffer.concat(parts, size)), header.limits);
    response = parsePdfProcessResponse({ ok: true, pages }, header.limits);
  } catch (error) {
    response = { ok: false, code: error instanceof PdfWorkerError ? error.code : "PDF_EXTRACTION_ERROR" };
  }
  const encoded = JSON.stringify(response);
  if (header && Buffer.byteLength(encoded) > maxPdfResponseBytes(header.limits)) throw new Error("Output limit");
  await new Promise<void>((resolve, reject) => process.stdout.write(encoded, (error) => error ? reject(error) : resolve()));
}
// No exception text, PDF content or internal diagnostics are emitted.
void main().then(() => {
  completed = true;
  clearTimeout(watchdog);
  // Drain IPC close before natural exit; do not race process.exit with disconnect.
  if (process.connected) process.disconnect?.();
}, () => { clearTimeout(watchdog); process.exit(1); });
