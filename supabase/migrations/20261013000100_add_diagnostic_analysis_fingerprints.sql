begin;

alter table public.diagnostic_history
  add column content_fingerprint varchar(71),
  add column analysis_fingerprint varchar(76),
  add constraint diagnostic_history_content_fingerprint_valid
    check (content_fingerprint is null or content_fingerprint ~ '^pdf_v1_[0-9a-f]{64}$'),
  add constraint diagnostic_history_analysis_fingerprint_valid
    check (analysis_fingerprint is null or analysis_fingerprint ~ '^analysis_v1_[0-9a-f]{64}$'),
  add constraint diagnostic_history_fingerprints_coherent
    check (
      (content_fingerprint is null and analysis_fingerprint is null)
      or (content_fingerprint is not null and analysis_fingerprint is not null)
    );

create unique index diagnostic_history_user_analysis_fingerprint_idx
  on public.diagnostic_history (user_id, analysis_fingerprint)
  where analysis_fingerprint is not null;

revoke select on table public.diagnostic_history from authenticated;
grant select (
  id,
  user_id,
  created_at,
  report_reference,
  make,
  model,
  year,
  odometer_value,
  odometer_unit,
  vin_hmac,
  vin_last4,
  dtc_codes,
  dtc_count,
  rag_status,
  extraction_snapshot,
  analysis_snapshot,
  rag_snapshot,
  analysis_model,
  embedding_model,
  schema_version
) on public.diagnostic_history to authenticated;

comment on column public.diagnostic_history.content_fingerprint is
  'Private, user-bound HMAC of PDF bytes. Never exposed through public history DTOs.';
comment on column public.diagnostic_history.analysis_fingerprint is
  'Private, versioned HMAC of analysis inputs and technical configuration.';

commit;
