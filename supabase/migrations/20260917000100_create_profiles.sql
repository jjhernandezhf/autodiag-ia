begin;

create table public.profiles (
  id uuid primary key,
  username text collate "C" not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_auth_user_fk
    foreign key (id) references auth.users (id) on delete cascade,
  constraint profiles_username_length check (char_length(username) between 3 and 64),
  constraint profiles_username_normalized check (username = lower(username) and username = btrim(username)),
  constraint profiles_username_format check (username ~ '^[a-z][a-z0-9]*([._-][a-z0-9]+)*$')
);

create unique index profiles_username_lower_unique on public.profiles ((lower(username) collate "C"));

-- Maintain timestamps only; this never creates users or profiles.
create function public.update_profiles_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

revoke all privileges on function public.update_profiles_updated_at() from public, anon, authenticated;
grant execute on function public.update_profiles_updated_at() to service_role;

create trigger profiles_updated_at
before update on public.profiles
for each row execute function public.update_profiles_updated_at();

alter table public.profiles enable row level security;

revoke all privileges on table public.profiles from public, anon, authenticated;
grant select on table public.profiles to authenticated;
grant select, insert, update, delete on table public.profiles to service_role;

create policy profiles_select_own
on public.profiles
for select
to authenticated
using ((select auth.uid()) = id);

comment on table public.profiles is
  'Private authorized profiles. Users and profiles are provisioned administratively; no public registration.';

commit;
