import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import { DIAGNOSTIC_PROMPT_VERSION } from "./ai-analysis-service.js";

import {
  canonicalSerialize,
  createAnalysisFingerprint,
  createPdfContentToken,
  verifyPdfContentToken,
} from "./analysis-fingerprint.js";

const SECRET = "synthetic-fingerprint-secret-at-least-32-bytes";
const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const input = {
  vehicle: { make: "Marca Sintética", model: "Modelo Sintético", year: 2025 },
  modules: [{
    code: "PCM",
    name: "Módulo sintético",
    dtcs: [{ code: "P0300", description: "Fallo sintético", status: "current" as const, alsoHistorical: false }],
  }],
};

function fingerprintInput(overrides: Record<string, unknown> = {}) {
  return {
    contentFingerprint: `pdf_v1_${"a".repeat(64)}`,
    input,
    extraction: { status: "completed", vehicle: { make: "Marca Sintética" }, dtcs: [{ code: "P0300" }] },
    analysisModel: "gpt-synthetic",
    promptVersion: "prompt_v1",
    outputSchemaVersion: "schema_v1",
    embeddingModel: "embedding-synthetic",
    corpusVersion: "corpus_v1",
    rag: { enabled: true, matchCount: 4, matchThreshold: 0.7, maxContextCharacters: 6_000 },
    ...overrides,
  };
}

describe("huella privada del PDF", () => {
  it("separa el contexto de tipos de prueba DTC de generaciones anteriores sin cambiar el historial público", () => {
    expect(DIAGNOSTIC_PROMPT_VERSION).toBe("diagnostic_prompt_v7_progressive_review");
    const current = createAnalysisFingerprint(fingerprintInput({ promptVersion: DIAGNOSTIC_PROMPT_VERSION }), SECRET);
    const previous = createAnalysisFingerprint(fingerprintInput({ promptVersion: "diagnostic_prompt_v3_dtc_test_context" }), SECRET);
    expect(current).not.toBe(previous);
    expect(current).not.toBe(createAnalysisFingerprint(fingerprintInput({ promptVersion: "diagnostic_prompt_v4_observed_states_review" }), SECRET));
    expect(current).not.toBe(createAnalysisFingerprint(fingerprintInput({ promptVersion: "diagnostic_prompt_v6_limited_guidance" }), SECRET));
    expect(current).not.toBe(createAnalysisFingerprint(fingerprintInput({ promptVersion: DIAGNOSTIC_PROMPT_VERSION, pipelineVersion: "analysis_pipeline_v4_limited_guidance" }), SECRET));
    expect(current).not.toBe(createAnalysisFingerprint(fingerprintInput({ promptVersion: DIAGNOSTIC_PROMPT_VERSION, pipelineVersion: "analysis_pipeline_v5_progressive_review" }), SECRET));
    expect(createAnalysisFingerprint(fingerprintInput({ promptVersion: DIAGNOSTIC_PROMPT_VERSION }), SECRET)).toBe(current);
  });
  it("produce el mismo token para los mismos bytes y otro para contenido diferente", () => {
    const first = createPdfContentToken(Buffer.from("%PDF-synthetic-a"), SECRET, USER_A);
    const repeated = createPdfContentToken(Buffer.from("%PDF-synthetic-a"), SECRET, USER_A);
    const different = createPdfContentToken(Buffer.from("%PDF-synthetic-b"), SECRET, USER_A);

    expect(repeated).toBe(first);
    expect(different).not.toBe(first);
    expect(verifyPdfContentToken(first, SECRET, USER_A)).toMatch(/^pdf_v1_[0-9a-f]{64}$/u);
    expect(first).not.toContain(createHash("sha256").update("%PDF-synthetic-a").digest("hex"));
  });

  it("aísla usuarios y rechaza tokens alterados o reasignados", () => {
    const token = createPdfContentToken(Buffer.from("%PDF-synthetic"), SECRET, USER_A);
    expect(() => verifyPdfContentToken(token, SECRET, USER_B)).toThrow("CONTENT_TOKEN_INVALID");
    const replacement = token.endsWith("0") ? "1" : "0";
    expect(() => verifyPdfContentToken(`${token.slice(0, -1)}${replacement}`, SECRET, USER_A))
      .toThrow("CONTENT_TOKEN_INVALID");
  });
});

describe("huella canónica del análisis", () => {
  it("separa low del default sin invalidar las huellas anteriores al omitir esfuerzo", () => {
    const base = fingerprintInput({ analysisModel: "gpt-6.1-sol" });
    const previous = createAnalysisFingerprint(base, SECRET);
    expect(createAnalysisFingerprint({ ...base, reasoningEffort: undefined }, SECRET)).toBe(previous);
    const low = createAnalysisFingerprint({ ...base, reasoningEffort: "low" }, SECRET);
    expect(low).not.toBe(previous);
    expect(createAnalysisFingerprint({ ...base, reasoningEffort: "low" }, SECRET)).toBe(low);
    expect(createAnalysisFingerprint(base, SECRET)).toBe(previous);
  });

  it("es estable ante el orden de propiedades pero cambia con cada versión o entrada relevante", () => {
    const base = fingerprintInput();
    const expected = createAnalysisFingerprint(base, SECRET);
    expect(canonicalSerialize({ b: 2, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":2}');
    expect(createAnalysisFingerprint({ ...base, rag: { ...base.rag } }, SECRET)).toBe(expected);

    const variants = [
      fingerprintInput({ contentFingerprint: `pdf_v1_${"b".repeat(64)}` }),
      fingerprintInput({ input: { ...input, observations: "Ruido sintético" } }),
      fingerprintInput({ extraction: { status: "completed", dtcs: [{ code: "P0301" }] } }),
      fingerprintInput({ analysisModel: "gpt-synthetic-v2" }),
      fingerprintInput({ promptVersion: "prompt_v2" }),
      fingerprintInput({ outputSchemaVersion: "schema_v2" }),
      fingerprintInput({ embeddingModel: "embedding-v2" }),
      fingerprintInput({ corpusVersion: "corpus_v2" }),
      fingerprintInput({ rag: { ...base.rag, matchCount: 5 } }),
      fingerprintInput({ rag: { ...base.rag, matchThreshold: 0.8 } }),
      fingerprintInput({ rag: { ...base.rag, maxContextCharacters: 5_000 } }),
      fingerprintInput({ pipelineVersion: "pipeline_v2" }),
    ];
    for (const variant of variants) expect(createAnalysisFingerprint(variant, SECRET)).not.toBe(expected);
    const oneSpace = fingerprintInput({ input: { ...input, observations: "Ruido leve" } });
    const twoSpaces = fingerprintInput({ input: { ...input, observations: "Ruido  leve" } });
    expect(createAnalysisFingerprint(oneSpace, SECRET)).not.toBe(createAnalysisFingerprint(twoSpaces, SECRET));
  });
});
