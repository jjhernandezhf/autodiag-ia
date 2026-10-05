import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { SupabaseClient } from "@supabase/supabase-js";

import { loadEnv } from "./config.js";
import {
  DEMONSTRATION_KNOWLEDGE_CORPUS,
  validateKnowledgeCorpus,
  type KnowledgeChunk,
} from "./knowledge-corpus.js";
import { OpenAiEmbeddingClient, type EmbeddingClient } from "./rag-service.js";
import { RAG_EMBEDDING_DIMENSIONS } from "./rag-types.js";
import { normalizeSafeHttpsUrl } from "./sensitive-data.js";
import { getSupabaseAdminClient } from "./supabase-admin-client.js";

export interface RagIngestionCounts {
  read: number;
  valid: number;
  inserted: number;
  updated: number;
  skipped: number;
}

export interface PreparedChunk extends KnowledgeChunk {
  contentHash: string;
  recordHash: string;
}

interface ExistingHashes {
  contentHash: string;
  recordHash: string;
}

export interface RagIngestionRepository {
  findExisting(chunks: PreparedChunk[]): Promise<Map<string, ExistingHashes>>;
  upsert(chunks: Array<PreparedChunk & { embedding: number[] }>): Promise<void>;
}

function identity(chunk: Pick<KnowledgeChunk, "sourceId" | "chunkIndex">) {
  return `${chunk.sourceId}:${chunk.chunkIndex}`;
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("RAG_RECORD_SERIALIZATION_INVALID");
  return encoded;
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function computeKnowledgeHashes(chunk: KnowledgeChunk) {
  const sourceUrl = chunk.sourceUrl === undefined ? null : normalizeSafeHttpsUrl(chunk.sourceUrl);
  if (chunk.sourceUrl !== undefined && sourceUrl === undefined) throw new Error("RAG_SOURCE_URL_INVALID");
  return {
    contentHash: sha256(chunk.content),
    recordHash: sha256(stableSerialize({
      sourceId: chunk.sourceId,
      chunkIndex: chunk.chunkIndex,
      title: chunk.title,
      sourceLabel: chunk.sourceLabel,
      sourceUrl,
      content: chunk.content,
      metadata: chunk.metadata,
    })),
  };
}

export function prepareKnowledgeCorpus(value: unknown): PreparedChunk[] {
  return validateKnowledgeCorpus(value).map((chunk) => {
    const sourceUrl = chunk.sourceUrl === undefined ? undefined : normalizeSafeHttpsUrl(chunk.sourceUrl);
    return {
      ...chunk,
      ...(sourceUrl === undefined ? {} : { sourceUrl }),
      ...computeKnowledgeHashes(chunk),
    };
  });
}

export class SupabaseRagIngestionRepository implements RagIngestionRepository {
  constructor(private readonly client: SupabaseClient) {}

  async findExisting(chunks: PreparedChunk[]) {
    const sourceIds = [...new Set(chunks.map((chunk) => chunk.sourceId))];
    const { data, error } = await this.client
      .from("knowledge_chunks")
      .select("source_id,chunk_index,content_hash,record_hash")
      .in("source_id", sourceIds);
    if (error || !Array.isArray(data)) throw new Error("RAG_TABLE_UNAVAILABLE");
    const result = new Map<string, ExistingHashes>();
    for (const row of data as Array<{
      source_id: unknown;
      chunk_index: unknown;
      content_hash: unknown;
      record_hash: unknown;
    }>) {
      if (
        typeof row.source_id === "string" && Number.isInteger(row.chunk_index) &&
        typeof row.content_hash === "string" && typeof row.record_hash === "string"
      ) {
        result.set(`${row.source_id}:${row.chunk_index}`, {
          contentHash: row.content_hash,
          recordHash: row.record_hash,
        });
      }
    }
    return result;
  }

  async upsert(chunks: Array<PreparedChunk & { embedding: number[] }>) {
    const rows = chunks.map((chunk) => ({
      source_id: chunk.sourceId,
      chunk_index: chunk.chunkIndex,
      title: chunk.title,
      source_label: chunk.sourceLabel,
      source_url: chunk.sourceUrl ?? null,
      content: chunk.content,
      content_hash: chunk.contentHash,
      record_hash: chunk.recordHash,
      metadata: chunk.metadata,
      embedding: chunk.embedding,
      is_active: true,
      updated_at: new Date().toISOString(),
    }));
    const { error } = await this.client.from("knowledge_chunks").upsert(rows, {
      onConflict: "source_id,chunk_index",
    });
    if (error) throw new Error("RAG_TABLE_UNAVAILABLE");
  }
}

export async function runRagIngestion(options: {
  dryRun: boolean;
  corpus?: unknown;
  embeddings?: EmbeddingClient;
  repository?: RagIngestionRepository;
}): Promise<RagIngestionCounts> {
  const source = options.corpus ?? DEMONSTRATION_KNOWLEDGE_CORPUS;
  const read = Array.isArray(source) ? source.length : 0;
  const prepared = prepareKnowledgeCorpus(source);
  const base = { read, valid: prepared.length, inserted: 0, updated: 0, skipped: 0 };
  if (options.dryRun) return base;
  if (!options.embeddings || !options.repository) throw new Error("RAG_CONFIGURATION_MISSING");

  const existing = await options.repository.findExisting(prepared);
  const changed = prepared.filter((chunk) => existing.get(identity(chunk))?.recordHash !== chunk.recordHash);
  const skipped = prepared.length - changed.length;
  if (changed.length === 0) return { ...base, skipped };

  const vectors = await options.embeddings.createEmbeddings(changed.map((chunk) => chunk.content));
  if (
    vectors.length !== changed.length ||
    vectors.some((vector) => vector.length !== RAG_EMBEDDING_DIMENSIONS || vector.some((value) => !Number.isFinite(value)))
  ) {
    throw new Error("RAG_EMBEDDING_INVALID");
  }
  await options.repository.upsert(changed.map((chunk, index) => ({ ...chunk, embedding: vectors[index]! })));
  const inserted = changed.filter((chunk) => !existing.has(identity(chunk))).length;
  return { ...base, inserted, updated: changed.length - inserted, skipped };
}

async function runCli() {
  const dryRun = process.argv.slice(2).includes("--dry-run");
  const env = loadEnv();
  if (dryRun) {
    console.log(JSON.stringify(await runRagIngestion({ dryRun: true })));
    return;
  }
  if (!env.OPENAI_API_KEY) throw new Error("RAG_CONFIGURATION_MISSING");
  const counts = await runRagIngestion({
    dryRun: false,
    embeddings: new OpenAiEmbeddingClient(env.OPENAI_API_KEY, env.OPENAI_EMBEDDING_MODEL, env.OPENAI_TIMEOUT_MS),
    repository: new SupabaseRagIngestionRepository(getSupabaseAdminClient()),
  });
  console.log(JSON.stringify(counts));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch(() => {
    console.error("La ingestión RAG no pudo completarse. Revisa la configuración, la extensión y la tabla.");
    process.exitCode = 1;
  });
}
