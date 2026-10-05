import { createHash, randomUUID } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import multer from "multer";

import {
  AiAnalysisError,
  DiagnosticAnalysisService,
  OpenAiResponsesClient,
  validateDiagnosticAnalysisInput,
} from "./ai-analysis-service.js";
import { prepareAiAnalysis } from "./ai-analysis-adapter.js";
import { AutelFormatError, extractAutelReport, type PdfPageExtractor } from "./autel-extraction.js";
import {
  DEFAULT_MAX_FILE_SIZE_BYTES,
  DEFAULT_OPENAI_TIMEOUT_MS,
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
  DISABLED_RAG_RESULT,
  NOT_CONFIGURED_RAG_RESULT,
  unavailableRagResult,
  type RagRetrievalService,
} from "./rag-service.js";

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
  | "AUTH_REQUEST_INVALID"
  | "AUTH_CREDENTIALS_INVALID"
  | "AUTH_SESSION_INVALID"
  | "AUTH_PROFILE_FORBIDDEN"
  | "AUTH_CONFIGURATION_UNAVAILABLE"
  | "AUTH_PROVIDER_UNAVAILABLE"
  | "AUTH_RATE_LIMITED";

interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
  };
}

export interface AppOptions {
  maxFileSizeBytes?: number;
  pdfExtractionLimits?: Partial<PdfExtractionLimits>;
  vinHmacSecret: string;
  extractPdfPages?: PdfPageExtractor;
  openAiApiKey?: string;
  openAiModel?: string;
  openAiTimeoutMs?: number;
  analysisService?: DiagnosticAnalysisService;
  ragEnabled?: boolean;
  ragService?: Pick<RagRetrievalService, "retrieve">;
  authenticationService?: AuthenticationService;
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
  const body: ApiErrorBody = { error: { code, message } };
  response.status(status).json(body);
}

export function createApp(options: AppOptions) {
  const maxFileSizeBytes = options.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES;
  const pdfExtractionLimits = resolvePdfExtractionLimits(options.pdfExtractionLimits);
  const pageExtractor = options.extractPdfPages ?? ((buffer: Buffer) => extractPdfPages(buffer, pdfExtractionLimits));
  const openAiApiKey = options.openAiApiKey?.trim();
  const openAiModel = options.openAiModel?.trim();
  const authenticationService = options.authenticationService ?? createAuthenticationService();
  let analysisService = options.analysisService;
  if (Buffer.byteLength(options.vinHmacSecret, "utf8") < 32) {
    throw new Error("VIN_HMAC_SECRET debe contener al menos 32 bytes.");
  }
  const app = express();

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

  app.post(
    "/api/auth/login",
    (_request, response, next) => {
      response.set("Cache-Control", "no-store");
      response.set("Pragma", "no-cache");
      next();
    },
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

    const extraction = await extractAutelReport(file.buffer, options.vinHmacSecret, pageExtractor);
    const analysisPreparation = prepareAiAnalysis(extraction);

    response.status(201).json({
      id: randomUUID(),
      originalName: file.originalname,
      size: file.size,
      sha256: createHash("sha256").update(file.buffer).digest("hex"),
      type: PDF_MIME_TYPE,
      status: "received",
      extraction,
      analysisPreparation,
    });
  });

  app.post("/api/reports/analyze", requireAuthentication, async (request, response) => {
    const input = validateDiagnosticAnalysisInput(request.body);

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
      );
    }

    let ragResult = options.ragEnabled ? NOT_CONFIGURED_RAG_RESULT : DISABLED_RAG_RESULT;
    if (options.ragEnabled && options.ragService) {
      try {
        ragResult = await options.ragService.retrieve(input);
      } catch {
        ragResult = unavailableRagResult();
      }
    }

    const analysis = await analysisService.analyze(input, ragResult.evidence);
    response.json({ status: "completed", analysis, rag: ragResult.metadata });
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
