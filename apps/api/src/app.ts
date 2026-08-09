import { createHash, randomUUID } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";

import { DEFAULT_MAX_FILE_SIZE_BYTES } from "./config.js";

const PDF_MIME_TYPE = "application/pdf";
const PDF_SIGNATURE = Buffer.from("%PDF-");

type ErrorCode =
  | "FILE_REQUIRED"
  | "FILE_TOO_LARGE"
  | "INVALID_FILE_FORMAT"
  | "INVALID_UPLOAD"
  | "INTERNAL_ERROR";

interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
  };
}

interface AppOptions {
  maxFileSizeBytes?: number;
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

export function createApp(options: AppOptions = {}) {
  const maxFileSizeBytes = options.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES;
  const app = express();

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: maxFileSizeBytes,
      files: 1,
      fields: 0,
    },
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

  app.disable("x-powered-by");
  app.use(express.json());

  app.get("/health", (_request, response) => {
    response.json({ status: "ok", service: "AutoDiag IA" });
  });

  app.post("/api/reports/upload", upload.single("report"), (request, response) => {
    const file = request.file;

    if (!file) {
      sendError(response, 400, "FILE_REQUIRED", 'Se requiere un archivo en el campo "report".');
      return;
    }

    if (file.buffer.length < PDF_SIGNATURE.length || !file.buffer.subarray(0, PDF_SIGNATURE.length).equals(PDF_SIGNATURE)) {
      sendError(response, 415, "INVALID_FILE_FORMAT", "El contenido del archivo no corresponde a un PDF válido.");
      return;
    }

    response.status(201).json({
      id: randomUUID(),
      originalName: file.originalname,
      size: file.size,
      hash: createHash("sha256").update(file.buffer).digest("hex"),
      type: PDF_MIME_TYPE,
      status: "received",
    });
  });

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    void _next;

    if (error instanceof UploadValidationError) {
      sendError(response, error.status, error.code, error.message);
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

    sendError(response, 500, "INTERNAL_ERROR", "No fue posible procesar el archivo.");
  });

  return app;
}
