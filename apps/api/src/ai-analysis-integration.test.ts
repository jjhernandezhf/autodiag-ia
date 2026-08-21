import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { AiAnalysisError, DiagnosticAnalysisService, type AiAnalysisClient } from "./ai-analysis-service.js";
import { createApp } from "./app.js";

const TEST_SECRET = "synthetic-analysis-secret-at-least-32-bytes";
const validInput = {
  vehicle: { make: "Marca Sintética", model: "Modelo Sintético", year: 2024 },
  modules: [
    {
      code: "PCM",
      name: "Módulo sintético",
      dtcs: [{ code: "P0001", description: "Descripción completamente sintética", status: "current" }],
    },
  ],
};
const validOutput = {
  technicalSummary: "Resumen sintético que requiere verificación.",
  findings: [
    {
      relatedDtcCode: "P0001",
      priority: "medium",
      simpleExplanation: "Existe una condición que requiere comprobación.",
      possibleCauses: ["Una causa posible completamente sintética."],
      recommendedChecks: ["Realizar una comprobación técnica segura."],
      safetyWarnings: ["Seguir las precauciones del fabricante."],
      confidence: "medium",
    },
  ],
  safetyWarnings: ["No sustituye el criterio del técnico."],
  confidence: "medium",
  requiresTechnicianConfirmation: true,
};

function appWithClient(client: AiAnalysisClient) {
  return createApp({
    vinHmacSecret: TEST_SECRET,
    analysisService: new DiagnosticAnalysisService(client, "modelo-sintetico", 2_000),
  });
}

describe("POST /api/reports/analyze", () => {
  it("devuelve una orientación estructurada para una entrada válida", async () => {
    const response = await request(appWithClient({ generate: async () => JSON.stringify(validOutput) }))
      .post("/api/reports/analyze")
      .send(validInput);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "completed", analysis: validOutput });
  });

  it.each(["vin", "pdf", "originalName", "sha256", "odometer"])("rechaza el campo sensible o fuera de contrato %s", async (field) => {
    const generate = vi.fn(async () => JSON.stringify(validOutput));
    const response = await request(appWithClient({ generate }))
      .post("/api/reports/analyze")
      .send({ ...validInput, [field]: "SYNTHETIC-SENSITIVE-VALUE" });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("AI_INPUT_INVALID");
    expect(JSON.stringify(response.body)).not.toContain("SYNTHETIC-SENSITIVE-VALUE");
    expect(generate).not.toHaveBeenCalled();
  });

  it("rechaza datos sensibles anidados", async () => {
    const generate = vi.fn(async () => JSON.stringify(validOutput));
    const response = await request(appWithClient({ generate }))
      .post("/api/reports/analyze")
      .send({ ...validInput, vehicle: { ...validInput.vehicle, vin: "SYNTHETIC-SENSITIVE-VIN" } });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("AI_INPUT_INVALID");
    expect(JSON.stringify(response.body)).not.toContain("SYNTHETIC-SENSITIVE-VIN");
    expect(generate).not.toHaveBeenCalled();
  });

  it("rechaza límites de cantidad y longitud", async () => {
    const tooManyModules = Array.from({ length: 41 }, (_, index) => ({
      code: `M${index}`,
      name: "Módulo sintético",
      dtcs: [],
    }));
    const response = await request(appWithClient({ generate: async () => JSON.stringify(validOutput) }))
      .post("/api/reports/analyze")
      .send({ vehicle: validInput.vehicle, modules: tooManyModules });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("AI_INPUT_INVALID");

    const longDescriptionResponse = await request(appWithClient({ generate: async () => JSON.stringify(validOutput) }))
      .post("/api/reports/analyze")
      .send({
        ...validInput,
        modules: [{ ...validInput.modules[0], dtcs: [{ ...validInput.modules[0]!.dtcs[0], description: "x".repeat(1_001) }] }],
      });
    expect(longDescriptionResponse.status).toBe(400);
    expect(longDescriptionResponse.body.error.code).toBe("AI_INPUT_INVALID");
  });

  it("acepta el DTO máximo de 100 DTC con textos en sus máximos contractuales", async () => {
    const modules = Array.from({ length: 40 }, (_, moduleIndex) => ({
      code: `M${String(moduleIndex).padStart(2, "0")}${"X".repeat(29)}`,
      name: `M${moduleIndex}${"n".repeat(159 - String(moduleIndex).length)}`,
      dtcs: moduleIndex < 5
        ? Array.from({ length: 20 }, (_, dtcIndex) => ({
            code: `P${String(moduleIndex * 20 + dtcIndex).padStart(3, "0")}${"C".repeat(28)}`,
            description: "d".repeat(1_000),
            status: "current" as const,
          }))
        : [],
    }));
    const maximumInput = {
      vehicle: { make: "m".repeat(80), model: "v".repeat(120), year: 2024 },
      modules,
    };
    const relatedDtcCode = modules[0]!.dtcs[0]!.code;
    const generate = vi.fn(async () => JSON.stringify({
      ...validOutput,
      findings: [{ ...validOutput.findings[0]!, relatedDtcCode }],
    }));

    const response = await request(appWithClient({ generate }))
      .post("/api/reports/analyze")
      .send(maximumInput);

    expect(Buffer.byteLength(JSON.stringify(maximumInput), "utf8")).toBeLessThanOrEqual(256 * 1024);
    expect(response.status).toBe(200);
    expect(generate).toHaveBeenCalledOnce();
  });

  it("rechaza un JSON superior a 256 KiB sin invocar el cliente ni exponer trazas", async () => {
    const generate = vi.fn(async () => JSON.stringify(validOutput));
    const response = await request(appWithClient({ generate }))
      .post("/api/reports/analyze")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ padding: "x".repeat(256 * 1024) }));

    expect(response.status).toBe(413);
    expect(response.body).toEqual({
      error: { code: "AI_INPUT_INVALID", message: "Los datos estructurados del reporte no son válidos." },
    });
    expect(JSON.stringify(response.body)).not.toMatch(/stack|trace|SyntaxError|PayloadTooLargeError/iu);
    expect(generate).not.toHaveBeenCalled();
  });

  it("maneja JSON mal formado como entrada inválida", async () => {
    const response = await request(appWithClient({ generate: async () => JSON.stringify(validOutput) }))
      .post("/api/reports/analyze")
      .set("Content-Type", "application/json")
      .send("{");

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("AI_INPUT_INVALID");
  });

  it("informa de forma segura cuando falta la clave", async () => {
    const response = await request(createApp({ vinHmacSecret: TEST_SECRET, openAiModel: "modelo-sintetico" }))
      .post("/api/reports/analyze")
      .send(validInput);

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("OPENAI_API_KEY_MISSING");
  });

  it("informa de forma segura cuando falta el modelo", async () => {
    const response = await request(createApp({ vinHmacSecret: TEST_SECRET, openAiApiKey: "synthetic-key" }))
      .post("/api/reports/analyze")
      .send(validInput);

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("OPENAI_MODEL_MISSING");
  });

  it.each([
    ["OPENAI_TIMEOUT", 504],
    ["OPENAI_LIMIT_EXCEEDED", 429],
    ["OPENAI_RESPONSE_INVALID", 502],
    ["OPENAI_UNAVAILABLE", 503],
  ] as const)("devuelve un error controlado para %s", async (code, status) => {
    const response = await request(
      appWithClient({
        generate: async () => {
          throw new AiAnalysisError(code);
        },
      }),
    )
      .post("/api/reports/analyze")
      .send(validInput);

    expect(response.status).toBe(status);
    expect(response.body.error.code).toBe(code);
    expect(JSON.stringify(response.body)).not.toMatch(/synthetic-key|instrucciones|stack/iu);
  });

  it("valida en integración la respuesta del modelo", async () => {
    const response = await request(appWithClient({ generate: async () => JSON.stringify({ texto: "sin estructura" }) }))
      .post("/api/reports/analyze")
      .send(validInput);

    expect(response.status).toBe(502);
    expect(response.body.error.code).toBe("OPENAI_RESPONSE_INVALID");
  });

  it("mantiene la API disponible después de un error del proveedor", async () => {
    const app = appWithClient({
      generate: async () => {
        throw new AiAnalysisError("OPENAI_UNAVAILABLE");
      },
    });

    const failedAnalysis = await request(app).post("/api/reports/analyze").send(validInput);
    const health = await request(app).get("/health");

    expect(failedAnalysis.status).toBe(503);
    expect(health.status).toBe(200);
    expect(health.body.status).toBe("ok");
  });
});
