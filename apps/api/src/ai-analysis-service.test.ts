import OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";

import {
  AiAnalysisError,
  DiagnosticAnalysisService,
  OpenAiResponsesClient,
  type AiAnalysisClient,
} from "./ai-analysis-service.js";
import { DIAGNOSTIC_ANALYSIS_JSON_SCHEMA, diagnosticAnalysisOutputSchema } from "./ai-analysis-types.js";

const validInput = {
  vehicle: { make: "Marca Sintética", model: "Modelo Sintético", year: 2024 },
  modules: [
    {
      code: "PCM",
      name: "Módulo de control sintético",
      dtcs: [{
        code: "P0001",
        description: "Descripción técnica sintética",
        status: "current" as const,
        alsoHistorical: false,
      }],
    },
  ],
};

const validOutput = {
  technicalSummary: "Resumen técnico sujeto a verificación.",
  findings: [
    {
      relatedDtc: { code: "P0001", moduleCode: "PCM", moduleName: "Módulo de control sintético" },
      priority: "high" as const,
      simpleExplanation: "El código indica una condición que debe comprobarse.",
      possibleCauses: ["Una conexión podría presentar una anomalía."],
      recommendedChecks: ["Verificar la conexión siguiendo la documentación técnica."],
      safetyWarnings: ["Aplicar las medidas de seguridad del fabricante."],
      confidence: "medium" as const,
    },
  ],
  safetyWarnings: ["La orientación no sustituye una inspección profesional."],
  confidence: "medium" as const,
  requiresTechnicianConfirmation: true as const,
};

describe("DiagnosticAnalysisService", () => {
  it("envía solamente el DTO validado y devuelve una respuesta estructurada", async () => {
    const generate = vi.fn(async () => JSON.stringify(validOutput));
    const service = new DiagnosticAnalysisService({ generate }, "modelo-sintetico", 4_000);

    const result = await service.analyze(validInput);

    expect(result).toEqual(validOutput);
    expect(generate).toHaveBeenCalledOnce();
    const request = generate.mock.calls[0]![0];
    expect(request.model).toBe("modelo-sintetico");
    expect(request.timeoutMs).toBe(4_000);
    expect(JSON.parse(request.input)).toEqual(validInput);
    expect(request.input).not.toMatch(/vin|sha256|filename|odometer|pdf/iu);
    expect(request.instructions).toContain("requiere confirmación");
  });

  it("rechaza propiedades sensibles antes de invocar el cliente", async () => {
    const generate = vi.fn(async () => JSON.stringify(validOutput));
    const service = new DiagnosticAnalysisService({ generate }, "modelo-sintetico", 4_000);

    await expect(service.analyze({ ...validInput, vin: "SYNTHETIC-SENSITIVE" })).rejects.toMatchObject({
      code: "AI_INPUT_INVALID",
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it.each(["texto libre", JSON.stringify({ ...validOutput, requiresTechnicianConfirmation: false })])(
    "rechaza una respuesta no validable",
    async (rawOutput) => {
      const service = new DiagnosticAnalysisService({ generate: async () => rawOutput }, "modelo-sintetico", 4_000);

      await expect(service.analyze(validInput)).rejects.toMatchObject({ code: "OPENAI_RESPONSE_INVALID" });
    },
  );

  it.each([
    ["hallazgos", { ...validOutput, findings: [] }],
    ["causas posibles", {
      ...validOutput,
      findings: [{ ...validOutput.findings[0]!, possibleCauses: [] }],
    }],
    ["comprobaciones", {
      ...validOutput,
      findings: [{ ...validOutput.findings[0]!, recommendedChecks: [] }],
    }],
    ["advertencias del hallazgo", {
      ...validOutput,
      findings: [{ ...validOutput.findings[0]!, safetyWarnings: [] }],
    }],
    ["advertencias generales", { ...validOutput, safetyWarnings: [] }],
  ])("rechaza una respuesta con %s vacíos", async (_field, emptyOutput) => {
    const service = new DiagnosticAnalysisService(
      { generate: async () => JSON.stringify(emptyOutput) },
      "modelo-sintetico",
      4_000,
    );

    await expect(service.analyze(validInput)).rejects.toMatchObject({ code: "OPENAI_RESPONSE_INVALID" });
  });

  it("rechaza un hallazgo relacionado con un DTC que no estaba en la entrada", async () => {
    const incompatibleOutput = {
      ...validOutput,
      findings: [{
        ...validOutput.findings[0]!,
        relatedDtc: { code: "P9999", moduleCode: "PCM", moduleName: "Módulo de control sintético" },
      }],
    };
    const service = new DiagnosticAnalysisService(
      { generate: async () => JSON.stringify(incompatibleOutput) },
      "modelo-sintetico",
      4_000,
    );

    await expect(service.analyze(validInput)).rejects.toMatchObject({ code: "OPENAI_RESPONSE_INVALID" });
  });

  it("convierte fallos desconocidos del cliente en indisponibilidad segura", async () => {
    const client: AiAnalysisClient = {
      generate: async () => {
        throw new Error("detalle interno que no debe exponerse");
      },
    };
    const service = new DiagnosticAnalysisService(client, "modelo-sintetico", 4_000);

    await expect(service.analyze(validInput)).rejects.toEqual(new AiAnalysisError("OPENAI_UNAVAILABLE"));
  });
});

describe("contrato de relatedDtc", () => {
  const relatedDtcSchema = DIAGNOSTIC_ANALYSIS_JSON_SCHEMA.properties.findings.items.properties.relatedDtc;
  const objectSchema = relatedDtcSchema.anyOf[0];
  const codeSchema = objectSchema.properties.code;

  it.each([
    ["cadena vacía", "", false],
    ["solo espacios", "   ", false],
    ["código válido", "P0001", true],
    ["superior al máximo", "P".repeat(33), false],
  ])("mantiene Zod y JSON Schema alineados para %s", (_case, value, expected) => {
    const zodAccepts = diagnosticAnalysisOutputSchema.safeParse({
      ...validOutput,
      findings: [{
        ...validOutput.findings[0]!,
        relatedDtc: { ...validOutput.findings[0]!.relatedDtc, code: value },
      }],
    }).success;
    const jsonSchemaAccepts = value.length >= codeSchema.minLength
      && value.length <= codeSchema.maxLength
      && new RegExp(codeSchema.pattern, "u").test(value);

    expect(zodAccepts).toBe(expected);
    expect(jsonSchemaAccepts).toBe(expected);
  });

  it("rechaza dos hallazgos para la misma combinación módulo+código", async () => {
    const duplicatedOutput = { ...validOutput, findings: [validOutput.findings[0], validOutput.findings[0]] };
    const service = new DiagnosticAnalysisService(
      { generate: async () => JSON.stringify(duplicatedOutput) },
      "modelo-sintetico",
      4_000,
    );

    await expect(service.analyze(validInput)).rejects.toMatchObject({ code: "OPENAI_RESPONSE_INVALID" });
  });
});

describe("OpenAiResponsesClient", () => {
  it("usa Responses API con salida JSON estricta, sin almacenamiento y con timeout", async () => {
    const create = vi.fn(async () => ({ output_text: JSON.stringify(validOutput) }));
    const client = new OpenAiResponsesClient("synthetic-key", { responses: { create } } as never);

    const output = await client.generate({
      model: "modelo-sintetico",
      instructions: "instrucciones sintéticas",
      input: JSON.stringify(validInput),
      timeoutMs: 3_000,
    });

    expect(output).toBe(JSON.stringify(validOutput));
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "modelo-sintetico",
        store: false,
        text: { format: expect.objectContaining({ type: "json_schema", strict: true }) },
      }),
      { timeout: 3_000 },
    );
  });

  it.each([
    [new OpenAI.APIConnectionTimeoutError({ message: "detalle sensible" }), "OPENAI_TIMEOUT"],
    [new OpenAI.RateLimitError(429, { code: "rate_limit_exceeded" }, "detalle sensible", new Headers()), "OPENAI_LIMIT_EXCEEDED"],
    [new Error("detalle sensible"), "OPENAI_UNAVAILABLE"],
  ])("normaliza errores del SDK sin exponer detalles", async (sdkError, expectedCode) => {
    const client = new OpenAiResponsesClient("synthetic-key", {
      responses: { create: async () => Promise.reject(sdkError) },
    } as never);

    let caught: unknown;
    try {
      await client.generate({ model: "modelo", instructions: "instrucciones", input: "{}", timeoutMs: 1_000 });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ code: expectedCode });
    expect(caught).not.toHaveProperty("message", "detalle sensible");
  });
});
