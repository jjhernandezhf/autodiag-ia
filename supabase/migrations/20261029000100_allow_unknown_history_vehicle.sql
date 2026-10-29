begin;

-- Limited guidance preserves unknown vehicle facts as SQL NULL, never sentinels.
-- Existing range/length checks still constrain every non-null value.
alter table public.diagnostic_history
  alter column make drop not null,
  alter column model drop not null,
  alter column year drop not null;

-- No data rewrite, grants, policy, fingerprint or immutability changes.
commit;
