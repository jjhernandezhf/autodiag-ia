import { PDFDocument, StandardFonts, type PDFPage, type PDFFont } from "pdf-lib";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp, type AppOptions } from "./app.js";
import type { AuthenticationService } from "./auth-service.js";
import { PdfExtractionError } from "./pdf-extractor.js";

const TEST_SECRET = "endpoint-integration-secret-at-least-32-bytes";
const SYNTHETIC_VIN = "1ABCD23EFGH456789";
const AUTHORIZATION = "Bearer synthetic-access-token";
const testAuthenticationService: AuthenticationService = {
  login: async () => ({ access_token: "synthetic-access-token", refresh_token: "synthetic-refresh-token" }),
  authenticate: async () => ({ id: "6a103df0-8e4d-4c51-89f5-7030c5443d89", username: "usuario.sintetico" }),
};

function createTestApp(options: AppOptions) {
  return createApp({ ...options, authenticationService: testAuthenticationService });
}

function postUpload(app: ReturnType<typeof createApp>) {
  return request(app).post("/api/reports/upload").set("Authorization", AUTHORIZATION);
}

function draw(page: PDFPage, font: PDFFont, text: string, y: number, x = 30) {
  page.drawText(text, { x, y, size: 11, font });
}

async function buildAutelPdf() {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const firstPage = document.addPage([600, 800]);
  draw(firstPage, font, "Informe de diagnostico de vehiculo", 760);
  draw(firstPage, font, "Informacion del vehiculo", 730);
  draw(firstPage, font, "2025 / Marca Sintetica / Modelo Sintetico / Motor Sintetico", 710);
  draw(firstPage, font, "Lectura del odometro: 54321 km", 690);
  draw(firstPage, font, `VIN: ${SYNTHETIC_VIN}`, 670);
  draw(firstPage, font, "Sistema/s escaneado/s (2)", 630);
  draw(firstPage, font, "Sistema", 610, 30);
  draw(firstPage, font, "Estado/DTC", 610, 470);
  draw(firstPage, font, "PCM(Control Unit (Synthetic))", 585, 30);
  draw(firstPage, font, "1", 585, 500);

  const secondPage = document.addPage([600, 800]);
  draw(secondPage, font, "BCM(Body Control Module)", 760, 30);
  draw(secondPage, font, "0", 760, 500);
  draw(secondPage, font, "DTC (1)", 720);
  draw(secondPage, font, "PCM(Control Unit (Synthetic)) (1 DTC)", 695);
  draw(secondPage, font, "DTC", 670, 30);
  draw(secondPage, font, "Descripcion", 670, 150);
  draw(secondPage, font, "Estado", 670, 490);
  draw(secondPage, font, "U1234:56-AB", 645, 30);
  draw(secondPage, font, "Descripcion completamente sintetica", 645, 150);
  draw(secondPage, font, "Corriente", 645, 490);
  return Buffer.from(await document.save());
}

async function buildTextPdf(text: string | null) {
  const document = await PDFDocument.create();
  const page = document.addPage([600, 800]);
  if (text) {
    const font = await document.embedFont(StandardFonts.Helvetica);
    draw(page, font, text, 740);
  }
  return Buffer.from(await document.save());
}

function appWithRealExtractor() {
  return createTestApp({ vinHmacSecret: TEST_SECRET });
}

describe("integración de extracción PDF", () => {
  it("extrae un reporte Autel sintético sin exponer el VIN completo", async () => {
    const pdf = await buildAutelPdf();
    const response = await postUpload(appWithRealExtractor())
      .attach("report", pdf, { filename: "autel-sintetico.pdf", contentType: "application/pdf" });

    expect(response.status).toBe(201);
    expect(response.body.extraction).toMatchObject({
      status: "completed",
      requiresManualReview: false,
      scanSummary: { declaredSystems: 2, parsedSystems: 2, declaredDtcs: 1, parsedDtcs: 1 },
    });
    expect(response.body.extraction.vehicle.vinMasked).toBe("*************6789");
    expect(JSON.stringify(response.body)).not.toContain(SYNTHETIC_VIN);
  });

  it("rechaza un PDF sin texto digital utilizable", async () => {
    const response = await postUpload(appWithRealExtractor())
      .attach("report", await buildTextPdf(null), { filename: "sin-texto.pdf", contentType: "application/pdf" });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("PDF_NO_USABLE_TEXT");
  });

  it("rechaza un PDF dañado con un error seguro", async () => {
    const response = await postUpload(appWithRealExtractor())
      .attach("report", Buffer.from("%PDF-1.7\ncontenido dañado"), { filename: "danado.pdf", contentType: "application/pdf" });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("PDF_UNREADABLE");
    expect(JSON.stringify(response.body)).not.toContain("contenido dañado");
  });

  it("rechaza un PDF cifrado mediante el código seguro de la biblioteca", async () => {
    const app = createTestApp({
      vinHmacSecret: TEST_SECRET,
      extractPdfPages: async () => {
        throw new PdfExtractionError("PDF_ENCRYPTED");
      },
    });
    const response = await postUpload(app)
      .attach("report", Buffer.from("%PDF-1.7\nsynthetic"), { filename: "cifrado.pdf", contentType: "application/pdf" });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("PDF_ENCRYPTED");
  });

  it("rechaza un formato no reconocido", async () => {
    const response = await postUpload(appWithRealExtractor())
      .attach("report", await buildTextPdf("Documento sintetico de otro formato"), {
        filename: "otro-formato.pdf",
        contentType: "application/pdf",
      });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("AUTEL_FORMAT_NOT_RECOGNIZED");
  });

  it("rechaza por exceso de páginas con una respuesta HTTP segura", async () => {
    const response = await postUpload(
      createTestApp({
        vinHmacSecret: TEST_SECRET,
        pdfExtractionLimits: { maxPages: 1 },
      }),
    ).attach("report", await buildAutelPdf(), {
        filename: "limite-sintetico.pdf",
        contentType: "application/pdf",
      });

    expect(response.status).toBe(422);
    expect(response.body).toEqual({
      error: {
        code: "PDF_EXTRACTION_LIMIT_EXCEEDED",
        message: "El PDF excede los límites seguros de extracción.",
      },
    });
  });

  it.each([
    ["PDF_EXTRACTION_LIMIT_EXCEEDED", "El PDF excede los límites seguros de extracción."],
    ["PDF_EXTRACTION_TIMEOUT", "La extracción del PDF excedió el tiempo permitido."],
  ] as const)("no expone contenido sensible en el error %s", async (code, message) => {
    const sensitiveText = "VIN-SYNTHETIC-SHOULD-NOT-APPEAR";
    const app = createTestApp({
      vinHmacSecret: TEST_SECRET,
      extractPdfPages: async () => {
        void sensitiveText;
        throw new PdfExtractionError(code);
      },
    });

    const response = await postUpload(app)
      .attach("report", Buffer.from(`%PDF-1.7\n${sensitiveText}`), {
        filename: "error-seguro.pdf",
        contentType: "application/pdf",
      });

    expect(response.status).toBe(422);
    expect(response.body).toEqual({ error: { code, message } });
    expect(JSON.stringify(response.body)).not.toContain(sensitiveText);
  });

  it("no registra VIN, texto extraído ni datos sensibles", async () => {
    const spies = ["log", "info", "warn", "error"].map((method) => vi.spyOn(console, method as "log").mockImplementation(() => undefined));
    const pdf = await buildAutelPdf();

    try {
      const response = await postUpload(appWithRealExtractor())
        .attach("report", pdf, { filename: "privacidad.pdf", contentType: "application/pdf" });

      expect(response.status).toBe(201);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
