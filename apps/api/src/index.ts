import { createApp } from "./app.js";
import { loadEnv } from "./config.js";
import { createConfiguredDiagnosticHistoryService } from "./diagnostic-history-runtime.js";
import { createConfiguredRagService } from "./rag-runtime.js";
import { serveCompiledWeb } from "./production-web.js";
import { stopPdfExtraction } from "./pdf-extractor.js";

const env = loadEnv();
const ragService = createConfiguredRagService(env);
const historyService = createConfiguredDiagnosticHistoryService();
const app = createApp({
  trustedProxyIps: env.TRUSTED_PROXY_IPS,
  maxFileSizeBytes: env.REPORT_MAX_SIZE_BYTES,
  pdfExtractionLimits: {
    maxPages: env.PDF_EXTRACTION_MAX_PAGES,
    maxTextItems: env.PDF_EXTRACTION_MAX_TEXT_ITEMS,
    maxCharacters: env.PDF_EXTRACTION_MAX_CHARACTERS,
    timeoutMs: env.PDF_EXTRACTION_TIMEOUT_MS,
    workerMemoryMb: env.PDF_EXTRACTION_WORKER_MEMORY_MB,
  },
  openAiApiKey: env.OPENAI_API_KEY,
  openAiModel: env.OPENAI_MODEL,
  openAiReasoningEffort: env.OPENAI_REASONING_EFFORT,
  openAiTimeoutMs: env.OPENAI_TIMEOUT_MS,
  analysisTotalTimeoutMs: env.ANALYSIS_TOTAL_TIMEOUT_MS,
  analysisIdempotencyTtlMs: env.ANALYSIS_IDEMPOTENCY_TTL_MS,
  analysisIdempotencyMaxEntries: env.ANALYSIS_IDEMPOTENCY_MAX_ENTRIES,
  diagnosticHistorySaveTimeoutMs: env.DIAGNOSTIC_HISTORY_SAVE_TIMEOUT_MS,
  openAiEmbeddingModel: env.OPENAI_EMBEDDING_MODEL,
  ragEnabled: env.RAG_ENABLED,
  ragMatchCount: env.RAG_MATCH_COUNT,
  ragMatchThreshold: env.RAG_MATCH_THRESHOLD,
  ragMaxContextCharacters: env.RAG_MAX_CONTEXT_CHARACTERS,
  ragService,
  historyService,
  vinHmacSecret: env.VIN_HMAC_SECRET,
});

if (process.env.NODE_ENV === "production") serveCompiledWeb(app);

const server = app.listen(env.PORT, "0.0.0.0", () => {
  console.log(`AutoDiag IA API disponible en http://localhost:${env.PORT}`);
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  // Platform shutdown budget, not a change to request/extraction deadlines.
  const forcedExit = setTimeout(() => process.exit(1), 25_000);
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  void stopPdfExtraction().then(async () => {
    server.closeAllConnections();
    await closed;
    clearTimeout(forcedExit);
    process.exit(0);
  }).catch(() => { process.exit(1); });
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
