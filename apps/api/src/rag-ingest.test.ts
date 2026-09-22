import { describe, expect, it, vi } from "vitest";

import { DEMONSTRATION_KNOWLEDGE_CORPUS, type KnowledgeChunk } from "./knowledge-corpus.js";
import { computeKnowledgeHashes, prepareKnowledgeCorpus, runRagIngestion } from "./rag-ingest.js";
import { RAG_EMBEDDING_DIMENSIONS } from "./rag-types.js";

const vector = Array.from({ length: RAG_EMBEDDING_DIMENSIONS }, () => 0);

function identity(chunk: Pick<KnowledgeChunk, "sourceId" | "chunkIndex">) {
  return `${chunk.sourceId}:${chunk.chunkIndex}`;
}

function existingFor(corpus: KnowledgeChunk[]) {
  return new Map(prepareKnowledgeCorpus(corpus).map((chunk) => [
    identity(chunk),
    { contentHash: chunk.contentHash, recordHash: chunk.recordHash },
  ]));
}

async function expectOneUpdate(current: KnowledgeChunk[], previousFirst: KnowledgeChunk) {
  const prepared = prepareKnowledgeCorpus(current);
  const existing = existingFor(current);
  existing.set(identity(prepared[0]!), computeKnowledgeHashes(previousFirst));
  const createEmbeddings = vi.fn(async () => [vector]);
  const upsert = vi.fn(async () => undefined);

  await expect(runRagIngestion({
    dryRun: false,
    corpus: current,
    embeddings: { createEmbeddings },
    repository: { findExisting: async () => existing, upsert },
  })).resolves.toEqual({ read: 16, valid: 16, inserted: 0, updated: 1, skipped: 15 });
  expect(createEmbeddings).toHaveBeenCalledWith([prepared[0]!.content]);
  expect(upsert).toHaveBeenCalledOnce();
  expect(upsert.mock.calls[0]![0][0]).toMatchObject({
    contentHash: prepared[0]!.contentHash,
    recordHash: prepared[0]!.recordHash,
    embedding: vector,
  });
}

describe("ingestión RAG", () => {
  it("calcula hashes deterministas del contenido y del registro completo", () => {
    const first = prepareKnowledgeCorpus(DEMONSTRATION_KNOWLEDGE_CORPUS);
    const second = prepareKnowledgeCorpus(DEMONSTRATION_KNOWLEDGE_CORPUS);
    expect(first.map((chunk) => chunk.contentHash)).toEqual(second.map((chunk) => chunk.contentHash));
    expect(first.map((chunk) => chunk.recordHash)).toEqual(second.map((chunk) => chunk.recordHash));
    expect(first.every((chunk) => /^[0-9a-f]{64}$/u.test(chunk.contentHash))).toBe(true);
    expect(first.every((chunk) => /^[0-9a-f]{64}$/u.test(chunk.recordHash))).toBe(true);
  });

  it("dry-run valida y cuenta sin generar embeddings ni acceder al repositorio", async () => {
    const createEmbeddings = vi.fn();
    const findExisting = vi.fn();
    const upsert = vi.fn();
    await expect(runRagIngestion({
      dryRun: true,
      embeddings: { createEmbeddings },
      repository: { findExisting, upsert },
    })).resolves.toEqual({ read: 16, valid: 16, inserted: 0, updated: 0, skipped: 0 });
    expect(createEmbeddings).not.toHaveBeenCalled();
    expect(findExisting).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("omite registros iguales y distingue inserciones de actualizaciones", async () => {
    const prepared = prepareKnowledgeCorpus(DEMONSTRATION_KNOWLEDGE_CORPUS);
    const existing = new Map([
      [identity(prepared[0]!), { contentHash: prepared[0]!.contentHash, recordHash: prepared[0]!.recordHash }],
      [identity(prepared[1]!), { contentHash: "0".repeat(64), recordHash: "0".repeat(64) }],
    ]);
    const vectors = Array.from({ length: prepared.length - 1 }, () => vector);
    const createEmbeddings = vi.fn(async () => vectors);
    const upsert = vi.fn(async () => undefined);
    await expect(runRagIngestion({
      dryRun: false,
      embeddings: { createEmbeddings },
      repository: { findExisting: async () => existing, upsert },
    })).resolves.toEqual({ read: 16, valid: 16, inserted: 14, updated: 1, skipped: 1 });
    expect(createEmbeddings).toHaveBeenCalledOnce();
    expect(createEmbeddings.mock.calls[0]?.[0]).toHaveLength(15);
    expect(upsert).toHaveBeenCalledOnce();
  });

  it.each([
    ["título", (chunk: KnowledgeChunk) => ({ ...chunk, title: `${chunk.title} revisado` })],
    ["etiqueta", (chunk: KnowledgeChunk) => ({ ...chunk, sourceLabel: `${chunk.sourceLabel} revisada` })],
    ["URL", (chunk: KnowledgeChunk) => ({ ...chunk, sourceUrl: "https://example.test/manual.pdf" })],
    ["metadata", (chunk: KnowledgeChunk) => ({ ...chunk, metadata: { ...chunk.metadata, revision: "dos" } })],
    ["contenido", (chunk: KnowledgeChunk) => ({ ...chunk, content: `${chunk.content} Nota técnica adicional.` })],
  ] satisfies Array<[string, (chunk: KnowledgeChunk) => KnowledgeChunk]>)(
    "actualiza exactamente un registro al cambiar %s",
    async (_field, mutate) => {
      const previousFirst = structuredClone(DEMONSTRATION_KNOWLEDGE_CORPUS[0]!);
      const current = DEMONSTRATION_KNOWLEDGE_CORPUS.map((chunk, index) =>
        index === 0 ? mutate(structuredClone(chunk)) : structuredClone(chunk)
      );
      await expectOneUpdate(current, previousFirst);
    },
  );

  it("ignora el orden de propiedades de metadata sin cambio semántico", async () => {
    const first = structuredClone(DEMONSTRATION_KNOWLEDGE_CORPUS[0]!);
    const previousFirst = { ...first, metadata: { sistema: "eléctrico", clase: "demostración" } };
    const currentFirst = { ...first, metadata: { clase: "demostración", sistema: "eléctrico" } };
    expect(computeKnowledgeHashes(previousFirst).recordHash).toBe(computeKnowledgeHashes(currentFirst).recordHash);
    const current = DEMONSTRATION_KNOWLEDGE_CORPUS.map((chunk, index) =>
      index === 0 ? currentFirst : structuredClone(chunk)
    );
    const createEmbeddings = vi.fn();
    const upsert = vi.fn();
    await expect(runRagIngestion({
      dryRun: false,
      corpus: current,
      embeddings: { createEmbeddings },
      repository: { findExisting: async () => existingFor(current), upsert },
    })).resolves.toEqual({ read: 16, valid: 16, inserted: 0, updated: 0, skipped: 16 });
    expect(createEmbeddings).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });
});
