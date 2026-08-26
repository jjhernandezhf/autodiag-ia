begin;

create table public.diagnostic_reports (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  make varchar(80) not null,
  model varchar(120) not null,
  year integer not null,
  extraction_status varchar(16) not null,
  analysis_status varchar(16) not null,
  constraint diagnostic_reports_make_length check (char_length(make) <= 80 and make ~ '[^[:space:]]'),
  constraint diagnostic_reports_model_length check (char_length(model) <= 120 and model ~ '[^[:space:]]'),
  constraint diagnostic_reports_year_range check (year between 1886 and 2027),
  constraint diagnostic_reports_extraction_status check (extraction_status = 'completed'),
  constraint diagnostic_reports_analysis_status check (analysis_status = 'completed')
);

create table public.diagnostic_modules (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null,
  code varchar(32),
  name varchar(160) not null,
  position integer not null,
  constraint diagnostic_modules_report_fk
    foreign key (report_id) references public.diagnostic_reports (id) on delete cascade,
  constraint diagnostic_modules_code_length
    check (code is null or (char_length(code) <= 32 and code ~ '[^[:space:]]')),
  constraint diagnostic_modules_name_length check (char_length(name) <= 160 and name ~ '[^[:space:]]'),
  constraint diagnostic_modules_position_nonnegative check (position >= 0),
  constraint diagnostic_modules_report_position_unique unique (report_id, position)
);

create table public.diagnostic_dtcs (
  id uuid primary key default gen_random_uuid(),
  module_id uuid not null,
  code varchar(32) not null,
  description varchar(1000) not null,
  status varchar(16) not null,
  position integer not null,
  constraint diagnostic_dtcs_module_fk
    foreign key (module_id) references public.diagnostic_modules (id) on delete cascade,
  constraint diagnostic_dtcs_code_length check (char_length(code) <= 32 and code ~ '[^[:space:]]'),
  constraint diagnostic_dtcs_description_length
    check (char_length(description) <= 1000 and description ~ '[^[:space:]]'),
  constraint diagnostic_dtcs_status_allowed
    check (status in ('current', 'stored', 'pending', 'permanent', 'history', 'unknown')),
  constraint diagnostic_dtcs_position_nonnegative check (position >= 0),
  constraint diagnostic_dtcs_module_position_unique unique (module_id, position)
);

create table public.diagnostic_ai_analyses (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null,
  created_at timestamptz not null default now(),
  technical_summary varchar(1500) not null,
  confidence varchar(8) not null,
  requires_technician_confirmation boolean not null default true,
  constraint diagnostic_ai_analyses_report_fk
    foreign key (report_id) references public.diagnostic_reports (id) on delete cascade,
  constraint diagnostic_ai_analyses_report_unique unique (report_id),
  constraint diagnostic_ai_analyses_summary_length
    check (char_length(technical_summary) <= 1500 and technical_summary ~ '[^[:space:]]'),
  constraint diagnostic_ai_analyses_confidence_allowed check (confidence in ('high', 'medium', 'low')),
  constraint diagnostic_ai_analyses_confirmation_required check (requires_technician_confirmation = true)
);

create table public.diagnostic_findings (
  id uuid primary key default gen_random_uuid(),
  analysis_id uuid not null,
  related_dtc_code varchar(32),
  priority varchar(8) not null,
  simple_explanation varchar(1000) not null,
  confidence varchar(8) not null,
  position integer not null,
  constraint diagnostic_findings_analysis_fk
    foreign key (analysis_id) references public.diagnostic_ai_analyses (id) on delete cascade,
  constraint diagnostic_findings_related_dtc_length
    check (
      related_dtc_code is null
      or (char_length(related_dtc_code) <= 32 and related_dtc_code ~ '[^[:space:]]')
    ),
  constraint diagnostic_findings_priority_allowed check (priority in ('critical', 'high', 'medium', 'low')),
  constraint diagnostic_findings_explanation_length
    check (char_length(simple_explanation) <= 1000 and simple_explanation ~ '[^[:space:]]'),
  constraint diagnostic_findings_confidence_allowed check (confidence in ('high', 'medium', 'low')),
  constraint diagnostic_findings_position_nonnegative check (position >= 0),
  constraint diagnostic_findings_analysis_position_unique unique (analysis_id, position)
);

create table public.diagnostic_finding_causes (
  id uuid primary key default gen_random_uuid(),
  finding_id uuid not null,
  value varchar(500) not null,
  position integer not null,
  constraint diagnostic_finding_causes_finding_fk
    foreign key (finding_id) references public.diagnostic_findings (id) on delete cascade,
  constraint diagnostic_finding_causes_value_length check (char_length(value) <= 500 and value ~ '[^[:space:]]'),
  constraint diagnostic_finding_causes_position_nonnegative check (position >= 0),
  constraint diagnostic_finding_causes_finding_position_unique unique (finding_id, position)
);

create table public.diagnostic_finding_checks (
  id uuid primary key default gen_random_uuid(),
  finding_id uuid not null,
  value varchar(500) not null,
  position integer not null,
  constraint diagnostic_finding_checks_finding_fk
    foreign key (finding_id) references public.diagnostic_findings (id) on delete cascade,
  constraint diagnostic_finding_checks_value_length check (char_length(value) <= 500 and value ~ '[^[:space:]]'),
  constraint diagnostic_finding_checks_position_nonnegative check (position >= 0),
  constraint diagnostic_finding_checks_finding_position_unique unique (finding_id, position)
);

create table public.diagnostic_finding_warnings (
  id uuid primary key default gen_random_uuid(),
  finding_id uuid not null,
  value varchar(500) not null,
  position integer not null,
  constraint diagnostic_finding_warnings_finding_fk
    foreign key (finding_id) references public.diagnostic_findings (id) on delete cascade,
  constraint diagnostic_finding_warnings_value_length check (char_length(value) <= 500 and value ~ '[^[:space:]]'),
  constraint diagnostic_finding_warnings_position_nonnegative check (position >= 0),
  constraint diagnostic_finding_warnings_finding_position_unique unique (finding_id, position)
);

create table public.diagnostic_analysis_warnings (
  id uuid primary key default gen_random_uuid(),
  analysis_id uuid not null,
  value varchar(500) not null,
  position integer not null,
  constraint diagnostic_analysis_warnings_analysis_fk
    foreign key (analysis_id) references public.diagnostic_ai_analyses (id) on delete cascade,
  constraint diagnostic_analysis_warnings_value_length check (char_length(value) <= 500 and value ~ '[^[:space:]]'),
  constraint diagnostic_analysis_warnings_position_nonnegative check (position >= 0),
  constraint diagnostic_analysis_warnings_analysis_position_unique unique (analysis_id, position)
);

create index diagnostic_reports_created_at_idx on public.diagnostic_reports (created_at desc);
create index diagnostic_reports_make_idx on public.diagnostic_reports (make);
create index diagnostic_reports_model_idx on public.diagnostic_reports (model);
create index diagnostic_reports_year_idx on public.diagnostic_reports (year);
create index diagnostic_dtcs_code_idx on public.diagnostic_dtcs (code);
create index diagnostic_ai_analyses_confidence_idx on public.diagnostic_ai_analyses (confidence);
create index diagnostic_findings_priority_idx on public.diagnostic_findings (priority);
create index diagnostic_findings_confidence_idx on public.diagnostic_findings (confidence);

alter table public.diagnostic_reports enable row level security;
alter table public.diagnostic_modules enable row level security;
alter table public.diagnostic_dtcs enable row level security;
alter table public.diagnostic_ai_analyses enable row level security;
alter table public.diagnostic_findings enable row level security;
alter table public.diagnostic_finding_causes enable row level security;
alter table public.diagnostic_finding_checks enable row level security;
alter table public.diagnostic_finding_warnings enable row level security;
alter table public.diagnostic_analysis_warnings enable row level security;

-- These tables are backend-only. Keep service-role credentials exclusively on the
-- server; anon and authenticated receive no table privileges and no RLS policies.
revoke all privileges on table
  public.diagnostic_reports,
  public.diagnostic_modules,
  public.diagnostic_dtcs,
  public.diagnostic_ai_analyses,
  public.diagnostic_findings,
  public.diagnostic_finding_causes,
  public.diagnostic_finding_checks,
  public.diagnostic_finding_warnings,
  public.diagnostic_analysis_warnings
from anon, authenticated;

grant select, insert, update, delete on table
  public.diagnostic_reports,
  public.diagnostic_modules,
  public.diagnostic_dtcs,
  public.diagnostic_ai_analyses,
  public.diagnostic_findings,
  public.diagnostic_finding_causes,
  public.diagnostic_finding_checks,
  public.diagnostic_finding_warnings,
  public.diagnostic_analysis_warnings
to service_role;

comment on table public.diagnostic_reports is
  'Sanitized diagnostic history. Access is restricted to the backend service role.';

commit;
