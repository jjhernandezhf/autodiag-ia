import { createHash, randomUUID } from "node:crypto";
import { resolveOpenAiReasoningEffort, type AnalysisReasoningEffort } from "./analysis-generation.js";
import express, { type NextFunction, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import multer from "multer";

import {
  AiAnalysisError,
  DiagnosticAnalysisService,
  DIAGNOSTIC_PROMPT_VERSION,
  OpenAiResponsesClient,
  validateDiagnosticAnalysisInput,
} from "./ai-analysis-service.js";
import { DIAGNOSTIC_OUTPUT_SCHEMA_VERSION, type DiagnosticAnalysisOutput } from "./ai-analysis-types.js";
import { prepareAiAnalysis } from "./ai-analysis-adapter.js";
import {
  AnalysisCoordinationError,
  AnalysisIdempotencyCoordinator,
  fingerprintAnalysisRequest,
  parseAnalysisIdempotencyKey,
  runWithAnalysisBudget,
} from "./analysis-coordinator.js";
import {
  AnalysisFingerprintError,
  createAnalysisFingerprint,
  createPdfContentToken,
  verifyPdfContentToken,
} from "./analysis-fingerprint.js";
import { AutelFormatError, extractAutelReport, type PdfPageExtractor } from "./autel-extraction.js";
import {
  DEFAULT_MAX_FILE_SIZE_BYTES,
  DEFAULT_ANALYSIS_IDEMPOTENCY_MAX_ENTRIES,
  DEFAULT_ANALYSIS_IDEMPOTENCY_TTL_MS,
  DEFAULT_OPENAI_TIMEOUT_MS,
  DEFAULT_OPENAI_EMBEDDING_MODEL,
  DEFAULT_RAG_MATCH_COUNT,
  DEFAULT_RAG_MATCH_THRESHOLD,
  DEFAULT_RAG_MAX_CONTEXT_CHARACTERS,
  resolveAnalysisTotalTimeout,
  resolveDiagnosticHistorySaveTimeout,
  resolvePdfExtractionLimits,
  type PdfExtractionLimits,
} from "./config.js";
import { extractPdfPages, PdfExtractionError } from "./pdf-extractor.js";
import {
  AuthenticationError,
  createAuthenticationService,
  type AuthenticationService,
} from "./auth-service.js";
import {
  DiagnosticHistoryError,
  DiagnosticHistoryService,
  parseAnalysisRequest,
  parseHistoryListQuery,
} from "./diagnostic-history.js";
import {
  DISABLED_RAG_RESULT,
  NOT_CONFIGURED_RAG_RESULT,
  unavailableRagResult,
  type RagRetrievalService,
} from "./rag-service.js";
import type { RagMetadata } from "./rag-types.js";
import { KNOWLEDGE_CORPUS_VERSION } from "./knowledge-corpus.js";
import { preventPrivateCaching } from "./production-web.js";
import { resolveTrustedProxyIps, validateLoginProxyChain } from "./trusted-proxies.js";

const PDF_MIME_TYPE = "application/pdf";
const PDF_SIGNATURE = Buffer.from("%PDF-");
const ANALYSIS_JSON_LIMIT_BYTES = 256 * 1024;

type ErrorCode =
  | "FILE_REQUIRED"
  | "FILE_TOO_LARGE"
  | "INVALID_FILE_FORMAT"
  | "INVALID_UPLOAD"
  | "INTERNAL_ERROR"
  | "PDF_ENCRYPTED"
  | "PDF_UNREADABLE"
  | "PDF_NO_USABLE_TEXT"
  | "PDF_EXTRACTION_LIMIT_EXCEEDED"
  | "PDF_EXTRACTION_TIMEOUT"
  | "AUTEL_FORMAT_NOT_RECOGNIZED"
  | "PDF_EXTRACTION_ERROR"
  | "OPENAI_API_KEY_MISSING"
  | "OPENAI_MODEL_MISSING"
  | "AI_INPUT_INVALID"
  | "OBSERVATIONS_INVALID"
  | "OBSERVATIONS_SENSITIVE_CONTENT"
  | "OPENAI_TIMEOUT"
  | "OPENAI_LIMIT_EXCEEDED"
  | "OPENAI_RESPONSE_INVALID"
  | "OPENAI_UNAVAILABLE"
  | "ANALYSIS_TIMEOUT"
  | "IDEMPOTENCY_KEY_INVALID"
  | "IDEMPOTENCY_CONFLICT"
  | "ANALYSIS_CAPACITY_EXCEEDED"
  | "CONTENT_TOKEN_INVALID"
  | "AUTH_REQUEST_INVALID"
  | "AUTH_CREDENTIALS_INVALID"
  | "AUTH_SESSION_INVALID"
  | "AUTH_PROFILE_FORBIDDEN"
  | "AUTH_CONFIGURATION_UNAVAILABLE"
  | "AUTH_PROVIDER_UNAVAILABLE"
  | "AUTH_RATE_LIMITED"
  | "HISTORY_REQUEST_INVALID"
  | "HISTORY_ID_INVALID"
  | "HISTORY_NOT_FOUND"
  | "HISTORY_DATA_INVALID"
  | "HISTORY_UNAVAILABLE";

interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
  };
}

interface AnalysisResponsePayload {
  status: "completed";
  reused: boolean;
  analysis: DiagnosticAnalysisOutput;
  rag: RagMetadata;
  history: { status: "saved"; id: string } | { status: "unavailable" };
}

export interface AppOptions {
  trustedProxyIps?: string[];
  maxFileSizeBytes?: number;
  pdfExtractionLimits?: Partial<PdfExtractionLimits>;
  vinHmacSecret: string;
  extractPdfPages?: PdfPageExtractor;
  openAiApiKey?: string;
  openAiModel?: string;
  openAiReasoningEffort?: AnalysisReasoningEffort;
  openAiTimeoutMs?: number;
  analysisTotalTimeoutMs?: number;
  analysisIdempotencyTtlMs?: number;
  analysisIdempotencyMaxEntries?: number;
  openAiEmbeddingModel?: string;
  analysisService?: DiagnosticAnalysisService;
  ragEnabled?: boolean;
  ragMatchCount?: number;
  ragMatchThreshold?: number;
  ragMaxContextCharacters?: number;
  ragService?: Pick<RagRetrievalService, "retrieve">;
  authenticationService?: AuthenticationService;
  historyService?: DiagnosticHistoryService;
  diagnosticHistorySaveTimeoutMs?: number;
}

class UploadValidationError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

function sendError(response: Response, status: number, code: ErrorCode, message: string) {
  if (response.headersSent || response.writableEnded || response.destroyed) return;
  const body: ApiErrorBody = { error: { code, message } };
  response.status(status).json(body);
}

function responseIsAvailable(response: Response) {
  return !response.headersSent && !response.writableEnded && !response.destroyed;
}

export function createApp(options: AppOptions) {
  const maxFileSizeBytes = options.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES;
  const pdfExtractionLimits = resolvePdfExtractionLimits(options.pdfExtractionLimits);
  const openAiApiKey = options.openAiApiKey?.trim();
  const openAiModel = options.openAiModel?.trim();
  const openAiReasoningEffort = resolveOpenAiReasoningEffort(openAiModel, options.openAiReasoningEffort);
  const authenticationService = options.authenticationService ?? createAuthenticationService();
  const diagnosticHistorySaveTimeoutMs = resolveDiagnosticHistorySaveTimeout(
    options.diagnosticHistorySaveTimeoutMs,
  );
  const analysisTotalTimeoutMs = resolveAnalysisTotalTimeout(options.analysisTotalTimeoutMs);
  const analysisCoordinator = new AnalysisIdempotencyCoordinator<AnalysisResponsePayload>({
    ttlMs: options.analysisIdempotencyTtlMs ?? DEFAULT_ANALYSIS_IDEMPOTENCY_TTL_MS,
    maxEntries: options.analysisIdempotencyMaxEntries ?? DEFAULT_ANALYSIS_IDEMPOTENCY_MAX_ENTRIES,
  });
  let analysisService = options.analysisService;
  if (Buffer.byteLength(options.vinHmacSecret, "utf8") < 32) {
    throw new Error("VIN_HMAC_SECRET debe contener al menos 32 bytes.");
  }
  const app = express();
  const trustedProxyIps = resolveTrustedProxyIps(options.trustedProxyIps);
  app.set("trust proxy", trustedProxyIps.length ? trustedProxyIps : false);

  // Multer 2.4 supports fieldArrayIndexLimit at runtime, while the current
  // @types/multer declaration has not added it yet. This upload accepts no
  // text fields, nesting or array indexes, so zero is the minimum valid limit.
  const uploadLimits: NonNullable<multer.Options["limits"]> & { fieldArrayIndexLimit: number } = {
    fileSize: maxFileSizeBytes,
    files: 1,
    fields: 0,
    fieldNestingDepth: 0,
    fieldArrayIndexLimit: 0,
  };
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: uploadLimits,
    fileFilter: (_request, file, callback) => {
      const hasPdfExtension = file.originalname.toLowerCase().endsWith(".pdf");
      const hasPdfMimeType = file.mimetype.toLowerCase() === PDF_MIME_TYPE;

      if (!hasPdfExtension || !hasPdfMimeType) {
        callback(
          new UploadValidationError(
            "INVALID_FILE_FORMAT",
            "El archivo debe tener extensión .pdf y tipo application/pdf.",
            415,
          ),
        );
        return;
      }

      callback(null, true);
    },
  });
  const receiveReport = upload.single("report");
  const validateReportUpload = (request: Request, response: Response, next: NextFunction) => {
    receiveReport(request, response, (error) => {
      if (error && !(error instanceof multer.MulterError) && !(error instanceof UploadValidationError)) {
        next(new UploadValidationError("INVALID_UPLOAD", 'Envía un único archivo en el campo "report".', 400));
        return;
      }
      next(error);
    });
  };

  app.disable("x-powered-by");
  app.use(preventPrivateCaching);
  // The largest contract-valid analysis DTO (40 modules, 100 DTC and all text
  // fields at their maxima) stays below 256 KiB; the bounded margin rejects
  // unrelated oversized JSON without changing Multer's multipart file limit.
  const jsonParser = express.json({ limit: ANALYSIS_JSON_LIMIT_BYTES });

  // The in-memory store is appropriate only for this local prototype. A
  // distributed deployment must replace it with a shared rate-limit store.
  const loginRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1_000,
    limit: 10,
    skipSuccessfulRequests: true,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_request, response) => {
      sendError(response, 429, "AUTH_RATE_LIMITED", "Demasiados intentos. Intenta nuevamente más tarde.");
    },
  });

  const requireAuthentication = async (request: Request, response: Response, next: NextFunction) => {
    const authorization = request.get("Authorization");
    const match = authorization ? /^Bearer ([^\s]+)$/u.exec(authorization) : null;
    if (!match?.[1]) {
      sendError(response, 401, "AUTH_SESSION_INVALID", "La sesión no es válida.");
      return;
    }

    try {
      request.usuario = await authenticationService.authenticate(match[1]);
      next();
    } catch (error) {
      next(error);
    }
  };

  app.get("/health", (_request, response) => {
    response.json({ status: "ok", service: "AutoDiag IA" });
  });

  app.get("/api/health", (_request, response) => {
    response.json({ status: "ok" });
  });

  app.post(
    "/api/auth/login",
    (_request, response, next) => {
      response.set("Cache-Control", "no-store");
      response.set("Pragma", "no-cache");
      next();
    },
    validateLoginProxyChain,
    loginRateLimiter,
    jsonParser,
    async (request, response) => {
      const tokens = await authenticationService.login(request.body);
      response.json(tokens);
    },
  );

  app.use(jsonParser);

  app.get("/api/auth/me", requireAuthentication, (request, response) => {
    response.json(request.usuario);
  });

  app.post("/api/reports/upload", requireAuthentication, validateReportUpload, async (request, response) => {
    const file = request.file;

    if (!file) {
      sendError(response, 400, "FILE_REQUIRED", 'Se requiere un archivo en el campo "report".');
      return;
    }

    if (file.buffer.length < PDF_SIGNATURE.length || !file.buffer.subarray(0, PDF_SIGNATURE.length).equals(PDF_SIGNATURE)) {
      sendError(response, 415, "INVALID_FILE_FORMAT", "El contenido del archivo no corresponde a un PDF válido.");
      return;
    }

    const extractionAbort = new AbortController();
    const cancelExtraction = () => { if (!response.writableEnded) extractionAbort.abort(); };
    request.once("aborted", cancelExtraction);
    response.once("close", cancelExtraction);
    let extraction;
    try {
      const pageExtractor = options.extractPdfPages ?? ((buffer: Buffer) => extractPdfPages(buffer, pdfExtractionLimits,
        { signal: extractionAbort.signal, maxFileSizeBytes }));
      extraction = await extractAutelReport(file.buffer, options.vinHmacSecret, pageExtractor);
    } finally {
      request.removeListener("aborted", cancelExtraction);
      response.removeListener("close", cancelExtraction);
    }
    const analysisPreparation = prepareAiAnalysis(extraction);

    response.status(201).json({
      id: randomUUID(),
      originalName: file.originalname,
      size: file.size,
      sha256: createHash("sha256").update(file.buffer).digest("hex"),
      contentToken: createPdfContentToken(file.buffer, options.vinHmacSecret, request.usuario!.id),
      type: PDF_MIME_TYPE,
      status: "received",
      extraction,
      analysisPreparation,
    });
  });

  app.post("/api/reports/analyze", requireAuthentication, async (request, response) => {
    const parsedRequest = parseAnalysisRequest(request.body);
    const input = validateDiagnosticAnalysisInput(parsedRequest.input);
    const idempotencyKey = parseAnalysisIdempotencyKey(request.get("Idempotency-Key"));

    if (!analysisService) {
      if (!openAiApiKey) {
        sendError(response, 503, "OPENAI_API_KEY_MISSING", "La orientación por IA no está configurada en el servidor.");
        return;
      }
      if (!openAiModel) {
        sendError(response, 503, "OPENAI_MODEL_MISSING", "El modelo de orientación no está configurado en el servidor.");
        return;
      }
      analysisService = new DiagnosticAnalysisService(
        new OpenAiResponsesClient(openAiApiKey),
        openAiModel,
        options.openAiTimeoutMs ?? DEFAULT_OPENAI_TIMEOUT_MS,
        { reasoningEffort: openAiReasoningEffort },
      );
    }

    const userId = request.usuario!.id;
    const contentFingerprint = parsedRequest.historyContext?.contentToken === undefined
      ? null
      : verifyPdfContentToken(parsedRequest.historyContext.contentToken, options.vinHmacSecret, userId);
    const analysisFingerprint = contentFingerprint !== null && openAiModel
      ? createAnalysisFingerprint({
          contentFingerprint,
          input,
          extraction: {
            ...parsedRequest.historyContext!.extraction,
            vehicle: {
              ...parsedRequest.historyContext!.extraction.vehicle,
              vinMasked: undefined,
              vinPseudonym: undefined,
            },
          },
          analysisModel: openAiModel,
          ...(openAiReasoningEffort === undefined ? {} : { reasoningEffort: openAiReasoningEffort }),
          promptVersion: DIAGNOSTIC_PROMPT_VERSION,
          outputSchemaVersion: DIAGNOSTIC_OUTPUT_SCHEMA_VERSION,
          embeddingModel: options.openAiEmbeddingModel?.trim() || DEFAULT_OPENAI_EMBEDDING_MODEL,
          corpusVersion: KNOWLEDGE_CORPUS_VERSION,
          rag: {
            enabled: options.ragEnabled ?? false,
            matchCount: options.ragMatchCount ?? DEFAULT_RAG_MATCH_COUNT,
            matchThreshold: options.ragMatchThreshold ?? DEFAULT_RAG_MATCH_THRESHOLD,
            maxContextCharacters: options.ragMaxContextCharacters ?? DEFAULT_RAG_MAX_CONTEXT_CHARACTERS,
          },
        }, options.vinHmacSecret)
      : fingerprintAnalysisRequest({ input, historyContext: parsedRequest.historyContext ?? null,
          ...(openAiReasoningEffort === undefined ? {} : { reasoningEffort: openAiReasoningEffort }) });
    const result = await analysisCoordinator.execute(userId, idempotencyKey, analysisFingerprint, () =>
      runWithAnalysisBudget(async (signal, deadlineAtMs, observePhysical) => {
        if (options.historyService && contentFingerprint !== null && analysisFingerprint.startsWith("analysis_v1_")) {
          try {
            const existing = await options.historyService.findByAnalysisFingerprint(
              userId,
              analysisFingerprint,
              signal,
            );
            if (existing) {
              return {
                status: "completed" as const,
                reused: true,
                analysis: existing.snapshot.analysis.output,
                rag: existing.snapshot.rag,
                history: { status: "saved" as const, id: existing.id },
              };
            }
          } catch (error) {
            if (error instanceof AnalysisCoordinationError) throw error;
            // History is best-effort; an unavailable lookup must not block analysis.
          }
        }

        signal.throwIfAborted();
        let ragResult = options.ragEnabled ? NOT_CONFIGURED_RAG_RESULT : DISABLED_RAG_RESULT;
        if (options.ragEnabled && options.ragService) {
          try {
            ragResult = await options.ragService.retrieve(input, signal);
          } catch {
            if (signal.aborted) throw signal.reason;
            ragResult = unavailableRagResult();
          }
        }

        signal.throwIfAborted();
        const analysis = await analysisService!.analyze(input, ragResult.evidence, signal, deadlineAtMs, observePhysical);
        signal.throwIfAborted();
        const history: AnalysisResponsePayload["history"] = { status: "unavailable" };
        const historyDeadlineAtMs = Date.now() + diagnosticHistorySaveTimeoutMs;
        // Best-effort history must fit before the integral deadline; otherwise
        // return the validated analysis without starting another physical job.
        if (options.historyService && parsedRequest.historyContext && openAiModel && historyDeadlineAtMs < deadlineAtMs) {
          const abortController = new AbortController();
          const abortFromBudget = () => abortController.abort(signal.reason);
          signal.addEventListener("abort", abortFromBudget, { once: true });
          let timeout: ReturnType<typeof setTimeout> | undefined;
          const assertHistoryBudget = () => {
            if (Date.now() >= historyDeadlineAtMs) {
              abortController.abort(new DiagnosticHistoryError("HISTORY_UNAVAILABLE"));
            }
            abortController.signal.throwIfAborted();
          };
          try {
            const timeoutPromise = new Promise<never>((_resolve, reject) => {
              timeout = setTimeout(() => {
                abortController.abort();
                reject(new DiagnosticHistoryError("HISTORY_UNAVAILABLE"));
              }, Math.max(0, historyDeadlineAtMs - Date.now()));
            });
            const persistenceJob = (async () => {
              const saved = await options.historyService!.save(userId, {
                context: parsedRequest.historyContext!,
                ...(contentFingerprint === null ? {} : { contentFingerprint }),
                ...(analysisFingerprint.startsWith("analysis_v1_") ? { analysisFingerprint } : {}),
                input,
                analysis,
                rag: ragResult.metadata,
                analysisModel: openAiModel,
                embeddingModel: options.openAiEmbeddingModel?.trim() || null,
              }, abortController.signal);
              assertHistoryBudget();
              if (saved.reused && analysisFingerprint.startsWith("analysis_v1_")) {
                const winner = await options.historyService!.findByAnalysisFingerprint(userId, analysisFingerprint, abortController.signal);
                assertHistoryBudget();
                if (!winner) throw new DiagnosticHistoryError("HISTORY_UNAVAILABLE");
                return {
                  status: "completed" as const,
                  reused: true,
                  analysis: winner.snapshot.analysis.output,
                  rag: winner.snapshot.rag,
                  history: { status: "saved" as const, id: winner.id },
                };
              }
              return { status: "completed" as const, reused: false, analysis, rag: ragResult.metadata,
                history: { status: "saved" as const, id: saved.id } };
            })();
            observePhysical(persistenceJob);
            return await Promise.race([persistenceJob, timeoutPromise]);
          } catch {
            console.warn("DIAGNOSTIC_HISTORY_SAVE_FAILED");
          } finally {
            if (timeout !== undefined) clearTimeout(timeout);
            signal.removeEventListener("abort", abortFromBudget);
          }
        }
        signal.throwIfAborted();
        return { status: "completed", reused: false, analysis, rag: ragResult.metadata, history };
      }, analysisTotalTimeoutMs)
    );
    if (responseIsAvailable(response)) response.json(result);
  });

  app.get("/api/history", requireAuthentication, async (request, response) => {
    if (!options.historyService || !request.usuario) {
      sendError(response, 503, "HISTORY_UNAVAILABLE", "El historial no está disponible temporalmente.");
      return;
    }
    const query = parseHistoryListQuery(request.query);
    const result = await options.historyService.list(request.usuario.id, query);
    response.json(result);
  });

  app.get("/api/history/:id", requireAuthentication, async (request, response) => {
    if (!options.historyService || !request.usuario) {
      sendError(response, 503, "HISTORY_UNAVAILABLE", "El historial no está disponible temporalmente.");
      return;
    }
    const historyId = typeof request.params.id === "string" ? request.params.id : "";
    const history = await options.historyService.get(request.usuario.id, historyId);
    response.json({ history });
  });

  app.use((error: unknown, request: Request, response: Response, _next: NextFunction) => {
    void _next;

    if (error instanceof UploadValidationError) {
      sendError(response, error.status, error.code, error.message);
      return;
    }

    if (error instanceof AuthenticationError) {
      sendError(response, error.status, error.code, error.message);
      return;
    }

    if (error instanceof DiagnosticHistoryError) {
      const statusByCode: Record<typeof error.code, number> = {
        HISTORY_REQUEST_INVALID: 400,
        HISTORY_ID_INVALID: 400,
        HISTORY_NOT_FOUND: 404,
        HISTORY_DATA_INVALID: 502,
        HISTORY_UNAVAILABLE: 503,
      };
      const messageByCode: Record<typeof error.code, string> = {
        HISTORY_REQUEST_INVALID: "La solicitud de historial no es válida.",
        HISTORY_ID_INVALID: "El identificador del diagnóstico no es válido.",
        HISTORY_NOT_FOUND: "El diagnóstico solicitado no existe.",
        HISTORY_DATA_INVALID: "El historial almacenado no cumple el contrato esperado.",
        HISTORY_UNAVAILABLE: "El historial no está disponible temporalmente.",
      };
      sendError(response, statusByCode[error.code], error.code, messageByCode[error.code]);
      return;
    }

    if (request.path === "/api/auth/login" && error instanceof Error) {
      const httpStatus = "status" in error && typeof error.status === "number" ? error.status : null;
      sendError(
        response,
        httpStatus === 413 ? 413 : 400,
        "AUTH_REQUEST_INVALID",
        "La solicitud de inicio de sesión no es válida.",
      );
      return;
    }

    if (error instanceof multer.MulterError) {
      if (error.code === "LIMIT_FILE_SIZE") {
        sendError(response, 413, "FILE_TOO_LARGE", `El archivo excede el límite permitido de ${maxFileSizeBytes} bytes.`);
        return;
      }

      sendError(response, 400, "INVALID_UPLOAD", 'Envía un único archivo en el campo "report".');
      return;
    }

    if (error instanceof PdfExtractionError) {
      sendError(response, error.code === "PDF_EXTRACTION_ERROR" ? 500 : 422, error.code, error.message);
      return;
    }

    if (error instanceof AutelFormatError) {
      sendError(response, 422, error.code, error.message);
      return;
    }

    if (error instanceof AiAnalysisError) {
      const statusByCode: Record<typeof error.code, number> = {
        AI_INPUT_INVALID: 400,
        OBSERVATIONS_INVALID: 400,
        OBSERVATIONS_SENSITIVE_CONTENT: 400,
        OPENAI_TIMEOUT: 504,
        OPENAI_LIMIT_EXCEEDED: 429,
        OPENAI_RESPONSE_INVALID: 502,
        OPENAI_UNAVAILABLE: 503,
      };
      sendError(response, statusByCode[error.code], error.code, error.message);
      return;
    }

    if (error instanceof AnalysisCoordinationError) {
      const mapping: Record<typeof error.code, { status: number; message: string }> = {
        ANALYSIS_TIMEOUT: { status: 504, message: "El anÃ¡lisis excediÃ³ el tiempo disponible en el servidor." },
        IDEMPOTENCY_KEY_INVALID: { status: 400, message: "La clave de idempotencia no es vÃ¡lida." },
        IDEMPOTENCY_CONFLICT: { status: 409, message: "La clave de idempotencia ya fue utilizada con otra solicitud." },
        ANALYSIS_CAPACITY_EXCEEDED: { status: 503, message: "El servicio de anÃ¡lisis estÃ¡ temporalmente ocupado." },
      };
      const mapped = mapping[error.code];
      sendError(response, mapped.status, error.code, mapped.message);
      return;
    }

    if (error instanceof AnalysisFingerprintError) {
      sendError(response, 400, "CONTENT_TOKEN_INVALID", "La referencia privada del reporte no es válida.");
      return;
    }

    if (request.path === "/api/reports/analyze" && error instanceof Error) {
      const httpStatus = "status" in error && typeof error.status === "number" ? error.status : null;
      if (!(error instanceof SyntaxError) && httpStatus !== 413) {
        sendError(response, 503, "OPENAI_UNAVAILABLE", "El servicio de orientación no está disponible temporalmente.");
        return;
      }
      sendError(response, httpStatus === 413 ? 413 : 400, "AI_INPUT_INVALID", "Los datos estructurados del reporte no son válidos.");
      return;
    }

    sendError(response, 500, "PDF_EXTRACTION_ERROR", "No fue posible extraer el contenido del PDF.");
  });

  return app;
}
