import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { OWNER_MANUAL_QUOTE as quote, OWNER_QUOTE_VERSION } from "./owner-manual-quote.js";
import { ACTIVE_KNOWLEDGE_CORPUS, ACTIVE_KNOWLEDGE_CORPUS_VERSION, DEMONSTRATION_KNOWLEDGE_CORPUS } from "./knowledge-corpus.js";
import { prepareKnowledgeCorpus, runRagIngestion } from "./rag-ingest.js";
import { RagRetrievalService, formatRagEvidence } from "./rag-service.js";
import { ragMetadataSchema } from "./rag-types.js";
import { isRagProvenance, describeRagProvenance } from "../../web/src/rag-provenance.js";
import { createAnalysisFingerprint } from "./analysis-fingerprint.js";
import type { DiagnosticAnalysisInput } from "./ai-analysis-types.js";

const input: DiagnosticAnalysisInput = { vehicle: { make: "Mazda", model: "Mazda3", year: 2019 },
  modules: [{ code: "BCM", name: "Body Control Module", dtcs: [{ code: "C1A56:87-0B",
    description: "Descripción sintética no interpretada", status: "current", alsoHistorical: false }] }],
  observations: "¿El TPMS sustituye la inspección periódica de los neumáticos?" };
const row = { id: "12345678-1234-4234-8234-123456789abc", title: quote.title,
  source_label: quote.sourceLabel, source_url: quote.sourceUrl, content: quote.content,
  metadata: quote.metadata, similarity: 0.9 };
function service(rows: unknown[]) {
  return new RagRetrievalService({ createEmbeddings: vi.fn(async () => [Array(1536).fill(0.1)]) },
    { matchKnowledge: vi.fn(async () => rows) }, { embeddingModel: "text-embedding-3-small",
      matchCount: 5, matchThreshold: 0.7, maxContextCharacters: 6000, timeoutMs: 1000 });
}
describe("single owner quotation admission", () => {
  it("preserves 16 originals, admits only one new quote and separates fingerprints", async () => {
    expect(ACTIVE_KNOWLEDGE_CORPUS.slice(0, 16)).toEqual(DEMONSTRATION_KNOWLEDGE_CORPUS);
    expect(prepareKnowledgeCorpus(ACTIVE_KNOWLEDGE_CORPUS)).toHaveLength(17);
    expect(ACTIVE_KNOWLEDGE_CORPUS_VERSION).toBe(OWNER_QUOTE_VERSION);
    const base = { contentFingerprint: "pdf_v1_" + "a".repeat(64), input, extraction: {},
      analysisModel: "fixture", embeddingModel: "text-embedding-3-small", promptVersion: "unchanged",
      outputSchemaVersion: "unchanged", corpusVersion: "demonstration_corpus_v1",
      rag: { enabled: true, matchCount: 5, matchThreshold: 0.7, maxContextCharacters: 6000 } };
    expect(createAnalysisFingerprint(base, "synthetic-key"))
      .not.toBe(createAnalysisFingerprint({ ...base, corpusVersion: OWNER_QUOTE_VERSION }, "synthetic-key"));
    const embeddings = { createEmbeddings: vi.fn() }, repository = { findExisting: vi.fn(), upsert: vi.fn() };
    expect(await runRagIngestion({ dryRun: true, corpus: ACTIVE_KNOWLEDGE_CORPUS, embeddings, repository }))
      .toMatchObject({ read: 17, valid: 17, inserted: 0, updated: 0 });
    expect(embeddings.createEmbeddings).not.toHaveBeenCalled(); expect(repository.upsert).not.toHaveBeenCalled();
  });
  it("keeps verification/admission distinct through context, snapshot and PDF presentation", async () => {
    const result = await service([row]).retrieve(input);
    expect(result.metadata.status).toBe("used");
    expect(formatRagEvidence(result.evidence)).toContain("Sin revisión profesional ni licencia verificada");
    const snapshot = ragMetadataSchema.parse(JSON.parse(JSON.stringify(result.metadata)));
    const provenance = snapshot.sources[0]!.provenance!;
    expect(isRagProvenance(provenance, () => false)).toBe(true);
    expect(describeRagProvenance(provenance)).toContain("demostración experimental");
    expect(describeRagProvenance(provenance)).toContain("Sin revisión profesional ni licencia verificada");
    expect(quote.metadata.reviewStatus).not.toBe("approved");
  });
  it.each(["content", "metadata", "mixed", "partial", "service_manual"])("rejects altered %s completely", async kind => {
    const chunk = structuredClone(quote);
    if (kind === "content") chunk.content += " Procedimiento adicional.";
    if (kind === "metadata") chunk.metadata.reviewStatus = "pending_technical_review";
    if (kind === "mixed") Object.assign(chunk.metadata, { sourceModelYear: null });
    if (kind === "partial") chunk.metadata.provenance = "null";
    if (kind === "service_manual") chunk.metadata.provenance = chunk.metadata.provenance.replace("owner_manual", "service_manual");
    expect(() => prepareKnowledgeCorpus([...DEMONSTRATION_KNOWLEDGE_CORPUS, chunk])).toThrow();
    expect((await service([{ ...row, content: chunk.content, metadata: chunk.metadata }]).retrieve(input)).evidence).toEqual([]);
  });
  it("excludes incompatible vehicles and the three pending summaries", async () => {
    expect((await service([row]).retrieve({ ...input, vehicle: { ...input.vehicle, year: 2020 } })).evidence).toEqual([]);
    const pending = JSON.parse(readFileSync(new URL("../../../docs/conocimiento-candidato/mazda3-2019-tpms.propuesta.json", import.meta.url), "utf8"));
    expect(() => prepareKnowledgeCorpus([...DEMONSTRATION_KNOWLEDGE_CORPUS, ...pending.chunks])).toThrow();
  });
});
