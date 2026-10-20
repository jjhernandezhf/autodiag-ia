import OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import { DiagnosticAnalysisService, OpenAiResponsesClient } from "./ai-analysis-service.js";
import { prepareAnalysisReferences } from "./analysis-references.js";

const input = {
  vehicle: { make: "Marca sintética", model: "Modelo", year: 2025 },
  modules: [
    { code: "DME", name: "Digital Motor Electronics", dtcs: [
      { code: "ABC123", description: "Descripción sintética", status: "current" as const, alsoHistorical: false },
      { code: "C1A56:87-0B", description: "Descripción sintética", status: "confirmed" as const, alsoHistorical: true },
    ] },
    { code: null, name: "Módulo secundario", dtcs: [
      { code: "ABC123", description: "Descripción sintética", status: "stored" as const, alsoHistorical: false },
    ] },
  ],
};
const finding = { relatedDtc: "D001", priority: "medium", simpleExplanation: "Comprobar condición.",
  possibleCauses: ["Posibilidad no confirmada."], recommendedChecks: ["Verificar documentación."],
  safetyWarnings: ["Confirmar con un técnico."], confidence: "low" };
const output = { technicalSummary: "Resumen sintético.", findings: [finding],
  observationCorrelation: { status: "not_provided", summary: "Sin observaciones.", matches: [] },
  safetyWarnings: ["Requiere confirmación técnica."], confidence: "low", requiresTechnicianConfirmation: true };

describe("referencias internas de análisis", () => {
  it.each([
    { code: "ABC123", moduleCode: "DME", moduleName: "Módulo del motor" },
    { code: "abc123", moduleCode: "DME", moduleName: "Digital Motor Electronics" },
    { code: "C1A56", moduleCode: "DME", moduleName: "Digital Motor Electronics" },
    { code: "ABC123", moduleCode: "DME", moduleName: "Módulo secundario" },
  ])("reproduce rechazo exacto de identidad alterada, no el incidente histórico: %j", async (reference) => {
    const generate = vi.fn(async () => JSON.stringify({ ...output, findings: [{ ...finding, relatedDtc: reference }] }));
    await expect(new DiagnosticAnalysisService({ generate }, "synthetic", 1000).analyze(input))
      .rejects.toMatchObject({ validationReason: "UNKNOWN_REFERENCE" });
    expect(generate).toHaveBeenCalledOnce();
  });

  it("enum restringido y restauración exacta para hex, sufijos, nombres y código repetido en otro módulo", async () => {
    const wire = { ...output, findings: ["D001", "D002", "D003"].map(relatedDtc => ({ ...finding, relatedDtc })) };
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      const body = JSON.parse(init!.body as string);
      expect(body.store).toBe(false);
      expect(body.tools).toBeUndefined();
      expect(body.instructions).toContain("server-assigned referenceId");
      const report = JSON.parse(body.input[0].content[0].text).report;
      expect(report.modules.flatMap((module: { dtcs: { referenceId: string }[] }) => module.dtcs.map(dtc => dtc.referenceId)))
        .toEqual(["D001", "D002", "D003"]);
      expect(body.text.format.schema.properties.findings.items.properties.relatedDtc.anyOf[0].enum).toEqual(["D001", "D002", "D003"]);
      return new Response(JSON.stringify({ status: "completed", object: "response", output: [{ type: "message", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: JSON.stringify(wire), annotations: [] }] }] }), { headers: { "content-type": "application/json" } });
    });
    const service = new DiagnosticAnalysisService(new OpenAiResponsesClient("synthetic-key",
      new OpenAI({ apiKey: "synthetic-key", maxRetries: 0, fetch })), "synthetic", 1000);
    const result = await service.analyze(input);
    expect(result.findings.map(item => item.relatedDtc)).toEqual([
      { code: "ABC123", moduleCode: "DME", moduleName: "Digital Motor Electronics" },
      { code: "C1A56:87-0B", moduleCode: "DME", moduleName: "Digital Motor Electronics" },
      { code: "ABC123", moduleCode: null, moduleName: "Módulo secundario" },
    ]);
    expect(JSON.stringify(result)).not.toContain("D001");
    expect(fetch).toHaveBeenCalledOnce();
    expect(prepareAnalysisReferences(input).report).toEqual(prepareAnalysisReferences(input).report);
  });

  it("restaura asociaciones con observaciones usando la misma tabla", () => {
    const prepared = prepareAnalysisReferences(input);
    const restored = JSON.parse(prepared.restore(JSON.stringify({ ...output, observationCorrelation: {
      status: "matches_found", summary: "Relación posible.", matches: [{ relatedDtc: "D003", observation: "Vibración.", possibleRelation: "Por comprobar.", confidence: "low" }],
    } })));
    expect(restored.observationCorrelation.matches[0].relatedDtc).toEqual({ code: "ABC123", moduleCode: null, moduleName: "Módulo secundario" });
  });
  it("rechaza input ambiguo antes de llamar al modelo", async () => {
    const generate = vi.fn();
    await expect(new DiagnosticAnalysisService({ generate }, "synthetic", 1000).analyze({ ...input, modules: [input.modules[0], input.modules[0]] }))
      .rejects.toMatchObject({ code: "AI_INPUT_INVALID" });
    expect(generate).not.toHaveBeenCalled();
  });
});
