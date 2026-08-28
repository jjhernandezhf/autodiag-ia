import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../../../supabase/migrations/20260821000100_create_diagnostic_history.sql", import.meta.url),
  "utf8",
).toLowerCase();

const TABLES = [
  "diagnostic_reports",
  "diagnostic_modules",
  "diagnostic_dtcs",
  "diagnostic_ai_analyses",
  "diagnostic_findings",
  "diagnostic_finding_causes",
  "diagnostic_finding_checks",
  "diagnostic_finding_warnings",
  "diagnostic_analysis_warnings",
];

describe("migración de historial diagnóstico", () => {
  it("crea todas las tablas normalizadas con UUID, relaciones y cascadas", () => {
    for (const table of TABLES) {
      expect(migration).toContain(`create table public.${table}`);
    }
    expect(migration.match(/id uuid primary key default gen_random_uuid\(\)/gu)).toHaveLength(TABLES.length);
    expect(migration.match(/foreign key \([^)]+\) references public\.[^(]+ \([^)]+\) on delete cascade/gu)).toHaveLength(9);
    expect(migration).toContain("created_at timestamptz not null default now()");
  });

  it("incluye restricciones e índices acordes con los contratos vigentes", () => {
    for (const constraint of [
      "diagnostic_reports_year_range",
      "diagnostic_dtcs_status_allowed",
      "diagnostic_dtcs_classification_allowed",
      "diagnostic_findings_priority_allowed",
      "diagnostic_findings_confidence_allowed",
      "diagnostic_ai_analyses_confirmation_required",
      "position_nonnegative",
    ]) {
      expect(migration).toContain(constraint);
    }
    for (const index of [
      "diagnostic_reports_created_at_idx",
      "diagnostic_reports_make_idx",
      "diagnostic_reports_model_idx",
      "diagnostic_reports_year_idx",
      "diagnostic_dtcs_code_idx",
      "diagnostic_dtcs_classification_idx",
      "diagnostic_dtcs_position_idx",
      "diagnostic_findings_related_dtc_idx",
      "diagnostic_findings_priority_idx",
      "diagnostic_findings_confidence_idx",
    ]) {
      expect(migration).toContain(`create index ${index}`);
    }
    expect(migration).not.toContain("if not exists");
    expect(migration).toContain("status_original varchar(120)");
    expect(migration).toContain("classification varchar(12) not null");
    expect(migration).toContain("related_dtc_id uuid");
    expect(migration).toContain("foreign key (related_dtc_id) references public.diagnostic_dtcs (id) on delete cascade");
  });

  it("habilita RLS en cada tabla sin crear políticas públicas", () => {
    for (const table of TABLES) {
      expect(migration).toContain(`alter table public.${table} enable row level security`);
    }
    expect(migration.match(/enable row level security/gu)).toHaveLength(TABLES.length);
    expect(migration).not.toMatch(/create\s+policy/gu);
    expect(migration).toContain("from anon, authenticated");
    expect(migration).toContain("to service_role");
  });
});
