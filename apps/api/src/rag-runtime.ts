import type { loadEnv } from "./config.js";
import {
  OpenAiEmbeddingClient,
  RagRetrievalService,
  SupabaseKnowledgeMatchClient,
} from "./rag-service.js";
import { getSupabaseAdminClient } from "./supabase-admin-client.js";

type RuntimeEnvironment = ReturnType<typeof loadEnv>;

export function createConfiguredRagService(env: RuntimeEnvironment): RagRetrievalService | undefined {
  if (!env.RAG_ENABLED || !env.OPENAI_API_KEY) return undefined;
  try {
    return new RagRetrievalService(
      new OpenAiEmbeddingClient(env.OPENAI_API_KEY, env.OPENAI_EMBEDDING_MODEL, env.OPENAI_TIMEOUT_MS),
      new SupabaseKnowledgeMatchClient(getSupabaseAdminClient()),
      {
        embeddingModel: env.OPENAI_EMBEDDING_MODEL,
        matchCount: env.RAG_MATCH_COUNT,
        matchThreshold: env.RAG_MATCH_THRESHOLD,
        maxContextCharacters: env.RAG_MAX_CONTEXT_CHARACTERS,
        timeoutMs: env.OPENAI_TIMEOUT_MS,
      },
    );
  } catch {
    return undefined;
  }
}
