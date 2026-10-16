begin;

-- Replace only the upload uniqueness index defined by the original migration.
-- Fingerprinted variants are already unique by (user_id, analysis_fingerprint).
drop index public.diagnostic_history_user_report_reference_idx;

create unique index diagnostic_history_user_report_reference_idx
  on public.diagnostic_history (user_id, report_reference)
  where report_reference is not null and analysis_fingerprint is null;

create index diagnostic_history_user_report_reference_lookup_idx
  on public.diagnostic_history (user_id, report_reference)
  where report_reference is not null;

commit;
