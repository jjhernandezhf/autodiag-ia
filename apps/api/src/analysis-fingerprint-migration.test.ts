import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const sql = readFileSync(
  new URL("../../../supabase/migrations/20261013000100_add_diagnostic_analysis_fingerprints.sql", import.meta.url),
  "utf8",
).toLowerCase();
const baseSql = readFileSync(
  new URL("../../../supabase/migrations/20260821000100_create_diagnostic_history.sql", import.meta.url),
  "utf8",
).toLowerCase();

describe("migración de huellas privadas", () => {
  it("agrega columnas anulables, formatos versionados e índice único parcial por usuario", () => {
    expect(sql).toMatch(/add column content_fingerprint varchar\(71\)(?!\s+not null)/u);
    expect(sql).toMatch(/add column analysis_fingerprint varchar\(76\)(?!\s+not null)/u);
    expect(sql).toContain("^pdf_v1_[0-9a-f]{64}$");
    expect(sql).toContain("^analysis_v1_[0-9a-f]{64}$");
    expect(sql).toMatch(/create unique index diagnostic_history_user_analysis_fingerprint_idx\s+on public\.diagnostic_history \(user_id, analysis_fingerprint\)\s+where analysis_fingerprint is not null/iu);
  });

  it("mantiene RLS forzada y excluye las huellas de la lectura directa authenticated", () => {
    expect(baseSql).toContain("alter table public.diagnostic_history enable row level security");
    expect(baseSql).toContain("alter table public.diagnostic_history force row level security");
    expect(sql).toContain("revoke select on table public.diagnostic_history from authenticated");
    const authenticatedGrant = /grant select \(([\s\S]*?)\) on public\.diagnostic_history to authenticated;/u.exec(sql)?.[1];
    expect(authenticatedGrant).toBeDefined();
    expect(authenticatedGrant).not.toMatch(/content_fingerprint|analysis_fingerprint/u);
    expect(sql).not.toMatch(/grant[\s\S]*(update|delete)/iu);
  });

  it("no modifica filas previas, debilita RLS ni concede escritura mutable", () => {
    expect(sql).not.toMatch(/\bupdate\b|\bdelete\b|drop\s+(table|column|policy)|disable\s+row\s+level\s+security/iu);
    expect(sql).not.toMatch(/grant\s+(insert|update|delete|all)/iu);
    expect(sql).not.toContain("service_role");
  });
});
