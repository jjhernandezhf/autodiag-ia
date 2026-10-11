begin;

create table public.diagnostic_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  created_at timestamptz not null default now(),
  report_reference uuid,
  make varchar(80) not null,
  model varchar(120) not null,
  year integer not null,
  odometer_value numeric,
  odometer_unit varchar(2),
  vin_hmac varchar(71),
  vin_last4 varchar(4),
  dtc_codes text[] not null,
  dtc_count integer not null,
  rag_status varchar(16) not null,
  extraction_snapshot jsonb not null,
  analysis_snapshot jsonb not null,
  rag_snapshot jsonb not null,
  analysis_model varchar(100) not null,
  embedding_model varchar(100),
  schema_version integer not null default 1,
  constraint diagnostic_history_user_fk
    foreign key (user_id) references auth.users (id) on delete cascade,
  constraint diagnostic_history_make_length
    check (char_length(make) between 1 and 80 and make ~ '[^[:space:]]'),
  constraint diagnostic_history_model_length
    check (char_length(model) between 1 and 120 and model ~ '[^[:space:]]'),
  constraint diagnostic_history_year_range check (year between 1886 and 9999),
  constraint diagnostic_history_odometer_coherent check (
    (odometer_value is null and odometer_unit is null)
    or (odometer_value >= 0 and odometer_unit in ('km', 'mi'))
  ),
  constraint diagnostic_history_vin_coherent check (
    (vin_hmac is null and vin_last4 is null)
    or (
      vin_hmac ~ '^vin_v1_[0-9a-f]{64}$'
      and vin_last4 ~ '^[A-HJ-NPR-Z0-9]{4}$'
    )
  ),
  constraint diagnostic_history_dtc_count check (
    dtc_count >= 0
    and dtc_count = coalesce(array_length(dtc_codes, 1), 0)
  ),
  constraint diagnostic_history_dtc_codes_nonempty check (
    array_position(dtc_codes, null) is null
  ),
  constraint diagnostic_history_rag_status check (
    rag_status in ('used', 'disabled', 'not_configured', 'no_matches', 'unavailable')
  ),
  constraint diagnostic_history_snapshots_are_objects check (
    jsonb_typeof(extraction_snapshot) = 'object'
    and jsonb_typeof(analysis_snapshot) = 'object'
    and jsonb_typeof(rag_snapshot) = 'object'
  ),
  constraint diagnostic_history_analysis_model_length
    check (char_length(analysis_model) between 1 and 100 and analysis_model ~ '[^[:space:]]'),
  constraint diagnostic_history_embedding_model_length
    check (
      embedding_model is null
      or (char_length(embedding_model) between 1 and 100 and embedding_model ~ '[^[:space:]]')
    ),
  constraint diagnostic_history_schema_version check (schema_version = 1)
);

create index diagnostic_history_user_created_id_idx
  on public.diagnostic_history (user_id, created_at desc, id desc);

create unique index diagnostic_history_user_report_reference_idx
  on public.diagnostic_history (user_id, report_reference)
  where report_reference is not null;

alter table public.diagnostic_history enable row level security;
alter table public.diagnostic_history force row level security;

create policy diagnostic_history_select_own
  on public.diagnostic_history
  for select
  to authenticated
  using ((select auth.uid()) is not null and (select auth.uid()) = user_id);

revoke all privileges on table public.diagnostic_history from public, anon, authenticated;
grant select on table public.diagnostic_history to authenticated;
grant select, insert on table public.diagnostic_history to service_role;

comment on table public.diagnostic_history is
  'Immutable, sanitized diagnostic snapshots. Backend writes with service_role; authenticated users read only their own rows through RLS.';

commit;
