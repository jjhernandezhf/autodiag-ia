begin;

-- SECURITY INVOKER + FORCE RLS intentionally relies on the existing server-only
-- service_role BYPASSRLS attribute. Fail closed on incompatible installations.
do $$ begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role' and rolbypassrls) then
    raise exception 'automation requires the existing service_role BYPASSRLS role';
  end if;
end $$;

create table public.automation_events (
  event_id text primary key check (event_id ~ '^automation_v1_[0-9a-f]{64}$'),
  status text not null default 'received' check (status in ('received','completed','failed')),
  received_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  failure_code text check (failure_code in ('WORKFLOW_FAILED')),
  check ((status = 'received' and completed_at is null and failure_code is null)
    or (status = 'completed' and completed_at is not null and failure_code is null)
    or (status = 'failed' and completed_at is null and failure_code is not null))
);
alter table public.automation_events enable row level security;
alter table public.automation_events force row level security;
revoke all on public.automation_events from public, anon, authenticated, service_role;
grant select, insert, update on public.automation_events to service_role;

create function public.automation_event_transition(p_event_id text, p_operation text)
returns text language plpgsql security invoker set search_path = '' as $$
declare current_status text;
begin
  if p_event_id is null or p_event_id !~ '^automation_v1_[0-9a-f]{64}$'
     or p_operation is null or p_operation not in ('register','complete','fail','recover') then
    raise exception 'AUTOMATION_INVALID';
  end if;
  if p_operation = 'register' then
    insert into public.automation_events(event_id) values(p_event_id) on conflict (event_id) do nothing;
  end if;
  select status into current_status from public.automation_events where event_id = p_event_id for update;
  if not found then raise exception 'AUTOMATION_NOT_FOUND'; end if;
  if current_status = 'received' and p_operation = 'complete' then
    update public.automation_events set status = 'completed', completed_at = now(), updated_at = now() where event_id = p_event_id;
    current_status := 'completed';
  elsif current_status = 'received' and p_operation = 'fail' then
    update public.automation_events set status = 'failed', failure_code = 'WORKFLOW_FAILED', updated_at = now() where event_id = p_event_id;
    current_status := 'failed';
  elsif current_status = 'failed' and p_operation = 'recover' then
    update public.automation_events set status = 'received', failure_code = null, updated_at = now() where event_id = p_event_id;
    current_status := 'received';
  end if;
  return current_status;
end $$;
revoke all on function public.automation_event_transition(text,text) from public, anon, authenticated;
grant execute on function public.automation_event_transition(text,text) to service_role;
comment on table public.automation_events is 'Minimal opaque receipt ledger; no automatic purge. Completion is the only MVP effect.';
commit;
