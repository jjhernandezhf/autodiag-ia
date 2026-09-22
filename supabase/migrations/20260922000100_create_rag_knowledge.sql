begin;

create schema if not exists extensions;

do $migration$
declare
  vector_schema text;
begin
  select namespace.nspname
    into vector_schema
    from pg_catalog.pg_extension as installed_extension
    join pg_catalog.pg_namespace as namespace on namespace.oid = installed_extension.extnamespace
   where installed_extension.extname = 'vector';

  if vector_schema is null then
    execute 'create extension vector with schema extensions';
  elsif vector_schema <> 'extensions' then
    begin
      execute 'alter extension vector set schema extensions';
    exception
      when insufficient_privilege then
        raise exception using
          errcode = '42501',
          message = pg_catalog.format(
            'La extensión vector está instalada en el esquema %I y no pudo relocalizarse a extensions.',
            vector_schema
          ),
          hint = 'Ejecuta ALTER EXTENSION vector SET SCHEMA extensions con el propietario de la extensión antes de reintentar.';
    end;
  end if;

  if pg_catalog.to_regtype('extensions.vector') is null then
    raise exception 'La extensión vector no está disponible en el esquema extensions.';
  end if;
end;
$migration$;

create table public.knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  source_id varchar(120) not null,
  chunk_index integer not null,
  title varchar(200) not null,
  source_label varchar(200) not null,
  source_url text,
  content varchar(8000) not null,
  content_hash varchar(64) not null,
  record_hash varchar(64) not null,
  metadata jsonb not null default '{}'::jsonb,
  embedding extensions.vector(1536) not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint knowledge_chunks_source_id_valid check (source_id ~ '^[a-z0-9][a-z0-9-]*$'),
  constraint knowledge_chunks_chunk_index_nonnegative check (chunk_index >= 0),
  constraint knowledge_chunks_title_valid check (char_length(title) between 1 and 200 and title ~ '[^[:space:]]'),
  constraint knowledge_chunks_source_label_valid check (char_length(source_label) between 1 and 200 and source_label ~ '[^[:space:]]'),
  constraint knowledge_chunks_source_url_https check (source_url is null or source_url ~ '^https://'),
  constraint knowledge_chunks_content_valid check (char_length(content) between 80 and 8000 and content ~ '[^[:space:]]'),
  constraint knowledge_chunks_content_hash_valid check (content_hash ~ '^[0-9a-f]{64}$'),
  constraint knowledge_chunks_record_hash_valid check (record_hash ~ '^[0-9a-f]{64}$'),
  constraint knowledge_chunks_metadata_object check (jsonb_typeof(metadata) = 'object'),
  constraint knowledge_chunks_source_position_unique unique (source_id, chunk_index)
);

alter table public.knowledge_chunks enable row level security;

revoke all privileges on table public.knowledge_chunks from public, anon, authenticated;
grant select, insert, update, delete on table public.knowledge_chunks to service_role;

create function public.match_knowledge_chunks(
  query_embedding extensions.vector(1536),
  match_threshold double precision,
  match_count integer
)
returns table (
  id uuid,
  title text,
  source_label text,
  source_url text,
  content text,
  metadata jsonb,
  similarity double precision
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    chunks.id,
    chunks.title::text,
    chunks.source_label::text,
    chunks.source_url,
    chunks.content::text,
    chunks.metadata,
    (1 - (chunks.embedding operator(extensions.<=>) query_embedding))::double precision as similarity
  from public.knowledge_chunks as chunks
  where chunks.is_active = true
    and (1 - (chunks.embedding operator(extensions.<=>) query_embedding)) >= greatest(0, least(1, match_threshold))
  order by chunks.embedding operator(extensions.<=>) query_embedding
  limit least(10, greatest(1, match_count));
$$;

revoke all privileges on function public.match_knowledge_chunks(extensions.vector, double precision, integer)
  from public, anon, authenticated;
grant execute on function public.match_knowledge_chunks(extensions.vector, double precision, integer)
  to service_role;

comment on table public.knowledge_chunks is
  'Sanitized demonstration knowledge for backend-only semantic retrieval. Exact search is intentional for the MVP corpus.';
comment on function public.match_knowledge_chunks(extensions.vector, double precision, integer) is
  'Exact cosine similarity search over active knowledge chunks. Add HNSW or IVFFlat only when the corpus requires scaling.';

commit;
