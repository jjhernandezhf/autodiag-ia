import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (name: string) => readFileSync(new URL(`../../../supabase/migrations/${name}`, import.meta.url), "utf8")
  .replace(/--[^\n]*/gu, "").replace(/\s+/gu, " ").trim().toLowerCase();
const sql = read("20261016000100_correct_diagnostic_history_uniqueness.sql");

describe("unicidad correctiva del historial", () => {
  it("sustituye exactamente el índice antiguo y conserva la protección legacy", () => {
    expect(read("20260821000100_create_diagnostic_history.sql")).toContain("create unique index diagnostic_history_user_report_reference_idx on public.diagnostic_history (user_id, report_reference) where report_reference is not null;");
    expect(sql.match(/drop index [^;]+;/gu)).toEqual(["drop index public.diagnostic_history_user_report_reference_idx;"]);
    expect(sql).toContain("create unique index diagnostic_history_user_report_reference_idx on public.diagnostic_history (user_id, report_reference) where report_reference is not null and analysis_fingerprint is null;");
    expect(sql).toContain("create index diagnostic_history_user_report_reference_lookup_idx on public.diagnostic_history (user_id, report_reference) where report_reference is not null;");
  });

  it("preserva el índice de fingerprints, datos, RLS y permisos", () => {
    expect(read("20261013000100_add_diagnostic_analysis_fingerprints.sql")).toContain("create unique index diagnostic_history_user_analysis_fingerprint_idx on public.diagnostic_history (user_id, analysis_fingerprint) where analysis_fingerprint is not null;");
    expect(sql).not.toMatch(/\b(?:delete|insert|update|truncate|grant|revoke|policy|alter table|cascade)\b/u);
    expect(sql).not.toContain("drop index public.diagnostic_history_user_analysis_fingerprint_idx");
    expect(sql.startsWith("begin;")).toBe(true);
    expect(sql.endsWith("commit;")).toBe(true);
  });
});
