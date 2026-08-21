import { createApp } from "./app.js";
import { loadEnv } from "./config.js";

const env = loadEnv();
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
  vinHmacSecret: env.VIN_HMAC_SECRET,
});

app.listen(env.PORT, () => {
  console.log(`AutoDiag IA API disponible en http://localhost:${env.PORT}`);
});
