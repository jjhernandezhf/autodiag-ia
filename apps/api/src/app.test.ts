import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import type { AuthenticationService } from "./auth-service.js";
import type { ExtractedPdfPage, ExtractedTextFragment } from "./report-types.js";

const validPdf = Buffer.from("%PDF-1.7\nAutoDiag test fixture\n%%EOF");
const TEST_SECRET = "synthetic-test-secret-with-at-least-32-bytes";
const AUTHORIZATION = "Bearer synthetic-access-token";
const testAuthenticationService: AuthenticationService = {
  login: async () => ({ access_token: "synthetic-access-token", refresh_token: "synthetic-refresh-token" }),
  authenticate: async () => ({ id: "6a103df0-8e4d-4c51-89f5-7030c5443d89", username: "usuario.sintetico" }),
};

function line(text: string, fragments?: ExtractedTextFragment[]) {
  return { text, y: 0, fragments: fragments ?? [{ text, x: 0, width: text.length }] };
}

function columns(code: string, description: string, status: string) {
  return line(`${code} ${description} ${status}`, [
    { text: code, x: 20, width: 70 },
    { text: description, x: 130, width: 250 },
    { text: status, x: 480, width: 70 },
  ]);
}

const completedPages: ExtractedPdfPage[] = [
  {
    pageNumber: 1,
    lines: [
      line("Informe de diagnóstico de vehículo"),
      line("Información del vehículo"),
      line("2024 / Fabricante Sintético / Modelo Sintético / Motor Sintético"),
      line("Lectura del odómetro: 1200 km"),
      line("VIN: 1ABCD23EFGH456789"),
      line("Sistema/s escaneado/s (0)"),
      line("Sistema Estado/DTC"),
      line("DTC (0)"),
    ],
  },
];

const completedDtcPages: ExtractedPdfPage[] = [
  {
    pageNumber: 1,
    lines: [
      line("Informe de diagnóstico de vehículo"),
      line("Información del vehículo"),
      line("2024 / Fabricante Sintético / Modelo Sintético / Motor Sintético"),
      line("Lectura del odómetro: 1200 km"),
      line("VIN: 1ABCD23EFGH456789"),
      line("Sistema/s escaneado/s (1)"),
      line("Sistema Estado/DTC"),
      line("PCM(Módulo sintético) 1"),
      line("DTC (1)"),
      line("PCM(Módulo sintético) (1 DTC)"),
      line("DTC Descripción Estado", [
        { text: "DTC", x: 20, width: 50 },
        { text: "Descripción", x: 130, width: 100 },
        { text: "Estado", x: 480, width: 60 },
      ]),
      columns("P0300", "Fallo sintético", "Corriente"),
    ],
  },
];

function createTestApp(options: { maxFileSizeBytes?: number; pages?: ExtractedPdfPage[] } = {}) {
  const { pages = completedPages, ...appOptions } = options;
  return createApp({
    ...appOptions,
    authenticationService: testAuthenticationService,
    vinHmacSecret: TEST_SECRET,
    extractPdfPages: async () => pages,
  });
}

function postUpload(app = createTestApp()) {
  return request(app).post("/api/reports/upload").set("Authorization", AUTHORIZATION);
}

describe("POST /api/reports/upload", () => {
  it("recibe un PDF válido y devuelve sus metadatos", async () => {
    const response = await postUpload()
      .attach("report", validPdf, { filename: "reporte-autel.pdf", contentType: "application/pdf" });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      id: expect.any(String),
      originalName: "reporte-autel.pdf",
      size: validPdf.length,
      sha256: createHash("sha256").update(validPdf).digest("hex"),
      type: "application/pdf",
      status: "received",
      extraction: expect.objectContaining({
        status: "completed",
        format: "autel_vehicle_diagnostic_report",
        requiresManualReview: false,
      }),
      analysisPreparation: expect.objectContaining({
        available: false,
        counts: { detected: 0, actionable: 0, historical: 0 },
        reasons: expect.arrayContaining([expect.objectContaining({ code: "NO_VALID_DTCS" })]),
      }),
    });
    expect(response.body.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it("incluye un DTO de análisis sanitizado sin datos sensibles ni propiedades desconocidas", async () => {
    const response = await postUpload(createTestApp({ pages: completedDtcPages }))
      .attach("report", validPdf, { filename: "cliente-autel.pdf", contentType: "application/pdf" });

    expect(response.status).toBe(201);
    expect(response.body.analysisPreparation).toEqual({
      available: true,
      input: {
        vehicle: { make: "Fabricante Sintético", model: "Modelo Sintético", year: 2024 },
        modules: [
          {
            code: "PCM",
            name: "Módulo sintético",
            dtcs: [{
              code: "P0300",
              description: "Fallo sintético",
              status: "current",
              alsoHistorical: false,
            }],
          },
        ],
      },
      reasons: [],
      warnings: [],
      counts: { detected: 1, actionable: 1, historical: 0 },
    });

    const sanitized = response.body.analysisPreparation.input;
    expect(Object.keys(sanitized)).toEqual(["vehicle", "modules"]);
    expect(Object.keys(sanitized.vehicle)).toEqual(["make", "model", "year"]);
    expect(Object.keys(sanitized.modules[0])).toEqual(["code", "name", "dtcs"]);
    expect(Object.keys(sanitized.modules[0].dtcs[0])).toEqual(["code", "description", "status", "alsoHistorical"]);
    const serialized = JSON.stringify(sanitized).toLowerCase();
    for (const forbidden of ["vin", "odometer", "originalname", "sha256", "pdf", "cliente-autel", "1abcd23efgh456789"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("rechaza una solicitud sin archivo", async () => {
    const response = await postUpload();

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: {
        code: "FILE_REQUIRED",
        message: 'Se requiere un archivo en el campo "report".',
      },
    });
  });

  it("rechaza un archivo con tipo o extensión inválidos", async () => {
    const invalidMimeResponse = await postUpload()
      .attach("report", validPdf, { filename: "reporte.pdf", contentType: "text/plain" });
    const invalidExtensionResponse = await postUpload()
      .attach("report", validPdf, { filename: "reporte.txt", contentType: "application/pdf" });

    expect(invalidMimeResponse.status).toBe(415);
    expect(invalidMimeResponse.body.error.code).toBe("INVALID_FILE_FORMAT");
    expect(invalidExtensionResponse.status).toBe(415);
    expect(invalidExtensionResponse.body.error.code).toBe("INVALID_FILE_FORMAT");
  });

  it("rechaza un archivo que declara ser PDF pero tiene una firma falsa", async () => {
    const response = await postUpload()
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
    const response = await postUpload(createTestApp({ maxFileSizeBytes: 16 }))
      .attach("report", validPdf, { filename: "reporte.pdf", contentType: "application/pdf" });

    expect(response.status).toBe(413);
    expect(response.body).toEqual({
      error: {
        code: "FILE_TOO_LARGE",
        message: "El archivo excede el límite permitido de 16 bytes.",
      },
    });
  });

  it.each([
    ["simple", "comment"],
    ["anidado", "metadata[vehicle][make]"],
    ["indice de arreglo", "items[1]"],
  ])("rechaza un campo de texto %s de forma controlada", async (_case, fieldName) => {
    const response = await postUpload()
      .field(fieldName, "synthetic")
      .attach("report", validPdf, { filename: "reporte.pdf", contentType: "application/pdf" });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: {
        code: "INVALID_UPLOAD",
        message: 'Envía un único archivo en el campo "report".',
      },
    });
  });

  it("rechaza un segundo archivo y conserva un solo archivo esperado", async () => {
    const response = await postUpload()
      .attach("report", validPdf, { filename: "primero.pdf", contentType: "application/pdf" })
      .attach("report", validPdf, { filename: "segundo.pdf", contentType: "application/pdf" });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("INVALID_UPLOAD");
  });

  it("rechaza un multipart truncado sin exponer el error interno ni tumbar la API", async () => {
    const app = createTestApp();
    const response = await postUpload(app)
      .set("Content-Type", "multipart/form-data; boundary=autodiag-boundary")
      .send([
        "--autodiag-boundary",
        'Content-Disposition: form-data; name="report"; filename="reporte.pdf"',
        "Content-Type: application/pdf",
        "",
        "%PDF-truncated",
      ].join("\r\n"));

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: {
        code: "INVALID_UPLOAD",
        message: 'Envía un único archivo en el campo "report".',
      },
    });
    expect((await request(app).get("/health")).status).toBe(200);
  });

  it("mantiene el archivo en memoria y los límites multipart mínimos", () => {
    const source = readFileSync(new URL("./app.ts", import.meta.url), "utf8");
    expect(source).toContain("storage: multer.memoryStorage()");
    expect(source).toContain("fieldNestingDepth: 0");
    expect(source).toContain("fieldArrayIndexLimit: 0");
    expect(source).not.toMatch(/multer\.diskStorage|\bdest\s*:/u);
  });
});
