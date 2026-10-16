import { createApp } from "./app.js";
import { loadEnv } from "./config.js";
import { createConfiguredDiagnosticHistoryService } from "./diagnostic-history-runtime.js";
import { createConfiguredRagService } from "./rag-runtime.js";

const env = loadEnv();
const ragService = createConfiguredRagService(env);
const historyService = createConfiguredDiagnosticHistoryService();
const app = createApp({
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

app.listen(env.PORT, () => {
  console.log(`AutoDiag IA API disponible en http://localhost:${env.PORT}`);
});
