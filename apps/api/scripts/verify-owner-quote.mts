// Explicit operator tool. No env loading here; use Node --env-file only when authorized.
import assert from "node:assert/strict";
import { loadEnv } from "../src/config.js";
import { loadSupabaseAdminConfig } from "../src/supabase-config.js";
import { getSupabaseAdminClient } from "../src/supabase-admin-client.js";
import { ACTIVE_KNOWLEDGE_CORPUS, DEMONSTRATION_KNOWLEDGE_CORPUS } from "../src/knowledge-corpus.js";
import { OWNER_MANUAL_QUOTE as quote, OWNER_QUOTE_VERSION } from "../src/owner-manual-quote.js";
import { prepareKnowledgeCorpus, runRagIngestion, type RagIngestionRepository } from "../src/rag-ingest.js";
import { OpenAiEmbeddingClient, RagRetrievalService, SupabaseKnowledgeMatchClient } from "../src/rag-service.js";
import { diagnosticAnalysisInputSchema } from "../src/ai-analysis-types.js";

let phase = "configuration";
async function main() {
  const mode = process.argv[2];
  assert(process.argv.length === 3 && ["--check", "--execute"].includes(mode!));
  const config = loadEnv(), adminConfig = loadSupabaseAdminConfig();
  assert(config.OPENAI_EMBEDDING_MODEL === "text-embedding-3-small");
  phase = "public_destination";
  const site = "https://autodiag-ia.onrender.com";
  const html = await fetch(site, { signal: AbortSignal.timeout(15000) }).then(r => { assert(r.ok); return r.text(); });
  const assets = [...html.matchAll(/src="(\/assets\/[^"\s]+\.js)"/g)].map(m => m[1]!);
  assert(assets.length > 0 && assets.length <= 5);
  let matched = false;
  for (const asset of assets) {
    const body = await fetch(new URL(asset, site), { signal: AbortSignal.timeout(15000) }).then(r => { assert(r.ok); return r.text(); });
    assert(body.length < 5_000_000);
    matched ||= body.includes(adminConfig.url);
  }
  phase = "destination_comparison";
  assert(matched, "Destination does not match public application");
  phase = "inventory";
  const client = getSupabaseAdminClient();
  const prepared = prepareKnowledgeCorpus(ACTIVE_KNOWLEDGE_CORPUS);
  const original = prepareKnowledgeCorpus(DEMONSTRATION_KNOWLEDGE_CORPUS);
  const inventory = async () => {
    const { data, error, count } = await client.from("knowledge_chunks")
      .select("source_id,chunk_index,is_active,content_hash,record_hash", { count: "exact" }).limit(100);
    assert(!error && data && count === data.length && (count === 16 || count === 17));
    assert(new Set(data.map(r => `${r.source_id}:${r.chunk_index}`)).size === count);
    for (const c of original) {
      const row = data.find(r => r.source_id === c.sourceId && r.chunk_index === c.chunkIndex);
      assert(row && row.is_active && row.content_hash === c.contentHash && row.record_hash === c.recordHash);
    }
    const extra = data.filter(r => !original.some(c => c.sourceId === r.source_id && c.chunkIndex === r.chunk_index));
    assert(extra.length <= 1);
    if (extra.length) {
      const c = prepared.at(-1)!; const row = extra[0]!;
      assert(row.source_id === c.sourceId && row.chunk_index === 0 && row.is_active &&
        row.content_hash === c.contentHash && row.record_hash === c.recordHash);
    }
    return data;
  };
  const before = await inventory();
  console.log(JSON.stringify({ destinationMatchesPublicApp: true, originalRecordsMatch: 16,
    quoteAlreadyStored: before.length === 17, productionCommitVerified: false, mode }));
  if (mode === "--check") return;
  phase = "embedding_configuration";
  assert(config.OPENAI_API_KEY);
  let texts = 0;
  const underlying = new OpenAiEmbeddingClient(config.OPENAI_API_KEY, config.OPENAI_EMBEDDING_MODEL, config.OPENAI_TIMEOUT_MS);
  const embeddings = { createEmbeddings: async (input: string[], signal?: AbortSignal) => {
    assert(texts + input.length <= 3, "Embedding budget exceeded"); texts += input.length;
    return underlying.createEmbeddings(input, signal);
  } };
  const repository: RagIngestionRepository = {
    findExisting: async () => new Map((await inventory()).map(r => [`${r.source_id}:${r.chunk_index}`,
      { contentHash: r.content_hash, recordHash: r.record_hash }])),
    upsert: async chunks => {
      assert(chunks.length === 1 && chunks[0]!.sourceId === quote.sourceId && chunks[0]!.chunkIndex === 0);
      const c = chunks[0]!;
      // Insert only. A concurrent insertion is an error, never overwrite another row.
      const { error } = await client.from("knowledge_chunks").insert({ source_id: c.sourceId,
        chunk_index: c.chunkIndex, title: c.title, source_label: c.sourceLabel, source_url: c.sourceUrl,
        content: c.content, metadata: c.metadata, content_hash: c.contentHash, record_hash: c.recordHash,
        embedding: c.embedding, is_active: true });
      assert(!error, "Quote insert failed");
    },
  };
  try {
    phase = "ingestion";
    const counts = await runRagIngestion({ dryRun: false, corpus: ACTIVE_KNOWLEDGE_CORPUS, embeddings, repository });
    console.log(JSON.stringify({ ingestion: counts, corpusVersion: OWNER_QUOTE_VERSION, textsSubmitted: texts }));
    phase = "stored_verification";
    await inventory();
    const { data, error } = await client.from("knowledge_chunks").select("id,embedding,metadata,is_active")
      .eq("source_id", quote.sourceId).eq("chunk_index", 0).single();
    assert(!error && data?.is_active);
    const vector = typeof data.embedding === "string" ? JSON.parse(data.embedding) : data.embedding;
    assert(Array.isArray(vector) && vector.length === 1536 && vector.every(Number.isFinite));
    console.log(JSON.stringify({ stored: true, activeInDatabase: true, embeddingDimensions: vector.length,
      admission: data.metadata.reviewStatus }));
    const input = diagnosticAnalysisInputSchema.parse({ vehicle: { make: "Mazda", model: "Mazda3", year: 2019 },
      modules: [{ code: "BCM", name: "Body Control Module", dtcs: [{ code: "C1A56:87-0B",
        description: "Descripción no disponible; no se interpreta el código.", status: "current", alsoHistorical: false }] }],
      observations: "¿El sistema TPMS sustituye la inspección periódica de los neumáticos por parte del propietario?" });
    const service = new RagRetrievalService(embeddings, new SupabaseKnowledgeMatchClient(client), {
      embeddingModel: config.OPENAI_EMBEDDING_MODEL, matchCount: config.RAG_MATCH_COUNT,
      matchThreshold: config.RAG_MATCH_THRESHOLD, maxContextCharacters: config.RAG_MAX_CONTEXT_CHARACTERS,
      timeoutMs: config.OPENAI_TIMEOUT_MS });
    phase = "retrieval";
    const result = await service.retrieve(input, AbortSignal.timeout(config.OPENAI_TIMEOUT_MS));
    console.log(JSON.stringify({ retrievalStatus: result.metadata.status,
      quoteRetrieved: result.metadata.sources.some(s => s.id === data.id),
      returnedSources: result.metadata.sources.length, textsSubmitted: texts,
      threshold: config.RAG_MATCH_THRESHOLD, matchCount: config.RAG_MATCH_COUNT,
      diagnosticGenerations: 0, tokensAndCost: "not exposed by existing embedding adapter" }));
  } finally { console.log(JSON.stringify({ textsSubmitted: texts, maximum: 3 })); }
}
main().catch(() => { console.error(JSON.stringify({ error: "OWNER_QUOTE_CHECK_FAILED", phase })); process.exitCode = 1; });
