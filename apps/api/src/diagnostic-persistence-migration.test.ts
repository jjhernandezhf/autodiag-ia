import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../../../supabase/migrations/20260821000100_create_diagnostic_history.sql", import.meta.url),
  "utf8",
).replaceAll("\r\n", "\n");
const sql = migration.toLowerCase();

describe("migración del historial seguro", () => {
  it("crea un registro principal inmutable relacionado con auth.users", () => {
    expect(sql).toContain("create table public.diagnostic_history");
    expect(sql).toContain("user_id uuid not null");
    expect(sql).toContain("foreign key (user_id) references auth.users (id) on delete cascade");
    expect(sql).toContain("created_at timestamptz not null default now()");
    expect(sql).not.toMatch(/create table public\.diagnostic_(?:modules|dtcs|ai_analyses|findings)/u);
    expect(sql).not.toMatch(/grant[^;]*(?:update|delete)[^;]*to service_role/u);
  });

  it("incluye escalares, VIN protegido y snapshots JSONB sin límite de año obsoleto", () => {
    for (const column of [
      "report_reference uuid",
      "odometer_value numeric",
      "odometer_unit varchar(2)",
      "vin_hmac varchar(71)",
      "vin_last4 varchar(4)",
      "dtc_codes text[] not null",
      "extraction_snapshot jsonb not null",
      "analysis_snapshot jsonb not null",
      "rag_snapshot jsonb not null",
      "analysis_model varchar(100) not null",
      "embedding_model varchar(100)",
      "schema_version integer not null default 1",
    ]) expect(sql).toContain(column);
    expect(sql).toContain("year between 1886 and 9999");
    expect(sql).not.toMatch(/year\s*<=\s*2027|between 1886 and 2027/u);
    expect(sql).toContain("jsonb_typeof(extraction_snapshot) = 'object'");
  });

  it("habilita RLS y permite a authenticated leer únicamente filas propias", () => {
    expect(sql).toContain("alter table public.diagnostic_history enable row level security");
    expect(sql).toContain("alter table public.diagnostic_history force row level security");
    expect(sql).toMatch(/create policy diagnostic_history_select_own[\s\S]*for select[\s\S]*to authenticated[\s\S]*auth\.uid\(\)[\s\S]*= user_id/u);
    expect(sql).not.toMatch(/create policy[^;]*for (?:insert|update|delete)/u);
  });

  it("revoca anon y escritura directa de authenticated", () => {
    expect(sql).toContain("revoke all privileges on table public.diagnostic_history from public, anon, authenticated");
    expect(sql).toContain("grant select on table public.diagnostic_history to authenticated");
    expect(sql).toContain("grant select, insert on table public.diagnostic_history to service_role");
    const authenticatedGrants = sql.match(/grant[^;]+to authenticated;/gu) ?? [];
    expect(authenticatedGrants).toEqual(["grant select on table public.diagnostic_history to authenticated;"]);
    expect(sql).not.toMatch(/grant[^;]+to anon/u);
  });

  it("crea índices para paginación estable y referencia por usuario", () => {
    expect(sql).toContain("on public.diagnostic_history (user_id, created_at desc, id desc)");
    expect(sql).toContain("on public.diagnostic_history (user_id, report_reference)");
  });
});
