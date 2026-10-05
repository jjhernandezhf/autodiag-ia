import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { RAG_EMBEDDING_DIMENSIONS } from "./rag-types.js";

const sql = readFileSync(
  new URL("../../../supabase/migrations/20260922000100_create_rag_knowledge.sql", import.meta.url),
  "utf8",
);

describe("migración pgvector RAG", () => {
  it("instala la extensión ausente y crea la tabla con vector coherente de 1536 dimensiones", () => {
    expect(RAG_EMBEDDING_DIMENSIONS).toBe(1_536);
    expect(sql).toMatch(/if vector_schema is null then\s+execute 'create extension vector with schema extensions'/iu);
    expect(sql).toMatch(/create table public\.knowledge_chunks/iu);
    expect(sql).toMatch(/embedding extensions\.vector\(1536\) not null/iu);
    expect(sql).toMatch(/record_hash varchar\(64\) not null/iu);
    expect(sql).toMatch(/unique \(source_id, chunk_index\)/iu);
  });

  it("continúa sin relocalizar cuando vector ya está en extensions", () => {
    expect(sql).toMatch(/elsif vector_schema <> 'extensions' then/iu);
    expect(sql).not.toMatch(/elsif vector_schema = 'extensions'/iu);
    expect(sql).toMatch(/pg_catalog\.to_regtype\('extensions\.vector'\) is null/iu);
  });

  it("relocaliza vector desde otro esquema y aborta de forma explícita si faltan permisos", () => {
    expect(sql).toMatch(/execute 'alter extension vector set schema extensions'/iu);
    expect(sql).toMatch(/when insufficient_privilege then/iu);
    expect(sql).toMatch(/errcode = '42501'/iu);
    expect(sql).toMatch(/message = pg_catalog\.format[\s\S]*vector_schema/iu);
    expect(sql).toMatch(/ALTER EXTENSION vector SET SCHEMA extensions/iu);
  });

  it("habilita RLS y reserva tabla y RPC al service_role", () => {
    expect(sql).toMatch(/alter table public\.knowledge_chunks enable row level security/iu);
    expect(sql).toMatch(/revoke all privileges on table public\.knowledge_chunks from public, anon, authenticated/iu);
    expect(sql).toMatch(/grant select, insert, update, delete on table public\.knowledge_chunks to service_role/iu);
    expect(sql).toMatch(/security invoker/iu);
    expect(sql).toMatch(/set search_path = ''/iu);
    expect(sql).toMatch(/revoke all privileges on function public\.match_knowledge_chunks[\s\S]*from public, anon, authenticated/iu);
    expect(sql).toMatch(/grant execute on function public\.match_knowledge_chunks[\s\S]*to service_role/iu);
  });

  it("limita la búsqueda a chunks activos con similitud coseno exacta", () => {
    expect(sql).toMatch(/where chunks\.is_active = true/iu);
    expect(sql).toMatch(/operator\(extensions\.<=>\)/iu);
    expect(sql).toMatch(/greatest\(0, least\(1, match_threshold\)\)/iu);
    expect(sql).toMatch(/limit least\(10, greatest\(1, match_count\)\)/iu);
    expect(sql).not.toMatch(/create index[\s\S]*(?:ivfflat|hnsw)/iu);
  });
});
