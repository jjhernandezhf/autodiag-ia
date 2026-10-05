import { describe, expect, it } from "vitest";

import {
  DEMONSTRATION_KNOWLEDGE_CORPUS,
  DEMO_SOURCE_LABEL,
  validateKnowledgeCorpus,
} from "./knowledge-corpus.js";

describe("corpus demostrativo RAG", () => {
  it("valida entre 12 y 20 chunks originales con atribución honesta", () => {
    const corpus = validateKnowledgeCorpus(DEMONSTRATION_KNOWLEDGE_CORPUS);
    expect(corpus).toHaveLength(16);
    expect(new Set(corpus.map((chunk) => `${chunk.sourceId}:${chunk.chunkIndex}`)).size).toBe(16);
    expect(corpus.every((chunk) => chunk.sourceLabel === DEMO_SOURCE_LABEL)).toBe(true);
    expect(JSON.stringify(corpus)).not.toMatch(/mazda|autel|sae|manual del fabricante/iu);
  });

  it("rechaza identidades duplicadas y campos desconocidos", () => {
    const duplicate = [
      ...DEMONSTRATION_KNOWLEDGE_CORPUS,
      DEMONSTRATION_KNOWLEDGE_CORPUS[0],
    ];
    expect(() => validateKnowledgeCorpus(duplicate)).toThrow(/duplicados/u);
    const withUnknown = DEMONSTRATION_KNOWLEDGE_CORPUS.map((chunk, index) =>
      index === 0 ? { ...chunk, vin: "SYNTHETIC" } : chunk
    );
    expect(() => validateKnowledgeCorpus(withUnknown)).toThrow();
  });

  it.each([
    ["título", { title: "reporte-cliente.pdf" }],
    ["etiqueta", { sourceLabel: "Contacto 55551234" }],
    ["contenido", { content: `Comprobación técnica ${"sb_secret_syntheticValue123456"} que debe rechazarse por privacidad.` }],
    ["metadata", { metadata: { API_KEY: "synthetic-value" } }],
  ])("rechaza contenido sensible en %s", (_field, override) => {
    const contaminated = DEMONSTRATION_KNOWLEDGE_CORPUS.map((chunk, index) =>
      index === 0 ? { ...chunk, ...override } : chunk
    );
    expect(() => validateKnowledgeCorpus(contaminated)).toThrow(/sensible/iu);
  });
});
