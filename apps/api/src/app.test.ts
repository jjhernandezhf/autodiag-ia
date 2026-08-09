import { createHash } from "node:crypto";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "./app.js";

const validPdf = Buffer.from("%PDF-1.7\nAutoDiag test fixture\n%%EOF");

describe("POST /api/reports/upload", () => {
  it("recibe un PDF válido y devuelve sus metadatos", async () => {
    const response = await request(createApp())
      .post("/api/reports/upload")
      .attach("report", validPdf, { filename: "reporte-autel.pdf", contentType: "application/pdf" });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      id: expect.any(String),
      originalName: "reporte-autel.pdf",
      size: validPdf.length,
      hash: createHash("sha256").update(validPdf).digest("hex"),
      type: "application/pdf",
      status: "received",
    });
    expect(response.body.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it("rechaza una solicitud sin archivo", async () => {
    const response = await request(createApp()).post("/api/reports/upload");

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: {
        code: "FILE_REQUIRED",
        message: 'Se requiere un archivo en el campo "report".',
      },
    });
  });

  it("rechaza un archivo con tipo o extensión inválidos", async () => {
    const invalidMimeResponse = await request(createApp())
      .post("/api/reports/upload")
      .attach("report", validPdf, { filename: "reporte.pdf", contentType: "text/plain" });
    const invalidExtensionResponse = await request(createApp())
      .post("/api/reports/upload")
      .attach("report", validPdf, { filename: "reporte.txt", contentType: "application/pdf" });

    expect(invalidMimeResponse.status).toBe(415);
    expect(invalidMimeResponse.body.error.code).toBe("INVALID_FILE_FORMAT");
    expect(invalidExtensionResponse.status).toBe(415);
    expect(invalidExtensionResponse.body.error.code).toBe("INVALID_FILE_FORMAT");
  });

  it("rechaza un archivo que declara ser PDF pero tiene una firma falsa", async () => {
    const response = await request(createApp())
      .post("/api/reports/upload")
      .attach("report", Buffer.from("not really a PDF"), { filename: "reporte.pdf", contentType: "application/pdf" });

    expect(response.status).toBe(415);
    expect(response.body).toEqual({
      error: {
        code: "INVALID_FILE_FORMAT",
        message: "El contenido del archivo no corresponde a un PDF válido.",
      },
    });
  });

  it("rechaza un archivo que excede el límite configurado", async () => {
    const response = await request(createApp({ maxFileSizeBytes: 16 }))
      .post("/api/reports/upload")
      .attach("report", validPdf, { filename: "reporte.pdf", contentType: "application/pdf" });

    expect(response.status).toBe(413);
    expect(response.body).toEqual({
      error: {
        code: "FILE_TOO_LARGE",
        message: "El archivo excede el límite permitido de 16 bytes.",
      },
    });
  });
});
