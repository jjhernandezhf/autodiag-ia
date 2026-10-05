import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(new URL("../../../supabase/migrations/20260917000100_create_profiles.sql", import.meta.url), "utf8");
const sql = migration.toLowerCase().replace(/\s+/gu, " ");

describe("migración local de perfiles autorizados", () => {
  it("crea una relación uno a uno con auth.users y eliminación en cascada", () => {
    expect(sql).toContain("create table public.profiles (");
    expect(sql).toContain("id uuid primary key");
    expect(sql).toContain("foreign key (id) references auth.users (id) on delete cascade");
    expect(sql).not.toMatch(/(?:alter|insert into|update|delete from|create trigger[^;]*on) auth\.users/u);
    expect(sql).not.toMatch(/after insert|security definer|handle_new_user/u);
  });

  it("define columnas autorizadas sin contraseñas, correo ni tokens", () => {
    expect(sql).toContain('username text collate "c" not null');
    expect(sql).toContain("is_active boolean not null default true");
    expect(sql).toContain("created_at timestamptz not null default now()");
    expect(sql).toContain("updated_at timestamptz not null default now()");
    expect(sql).not.toMatch(/\b(?:password|password_hash|salt|email|refresh_token|access_token|provider_token)\b/u);
    expect(sql).toContain("before update on public.profiles");
    expect(sql).toContain("new.updated_at = now()");
    expect(sql).toContain("set search_path = ''");
  });

  it("impone minúsculas, longitud, formato ASCII y unicidad insensible a mayúsculas", () => {
    expect(sql).toContain("char_length(username) between 3 and 64");
    expect(sql).toContain("username = lower(username) and username = btrim(username)");
    expect(sql).toContain('create unique index profiles_username_lower_unique on public.profiles ((lower(username) collate "c"))');
    const pattern = migration.match(/username ~ '([^']+)'/u)?.[1];
    expect(pattern).toBe("^[a-z][a-z0-9]*([._-][a-z0-9]+)*$");
    const allowed = new RegExp(pattern!);
    for (const username of ["usuario.apellido", "usuario_2", "usuario-2", "abc", "a".repeat(64)]) {
      expect(allowed.test(username) && username.length >= 3 && username.length <= 64).toBe(true);
    }
    for (const username of ["", "ab", " Usuario.apellido", "usuario.apellido ", "Usuario.apellido", "usuario apellido", "usuario..apellido", "usuario.", "usuario@apellido", "usuário", "a".repeat(65)]) {
      expect(allowed.test(username) && username.length >= 3 && username.length <= 64).toBe(false);
    }
  });

  it("habilita RLS y exactamente una política de lectura del propio perfil", () => {
    expect(sql).toContain("alter table public.profiles enable row level security");
    expect(sql.match(/create policy /gu)).toHaveLength(1);
    expect(sql).toContain("create policy profiles_select_own on public.profiles for select to authenticated using ((select auth.uid()) = id)");
    expect(sql).not.toMatch(/using\s*\(true\)|with check|for (?:insert|update|delete|all)/u);
  });

  it("revoca permisos heredables y concede solo lectura a authenticated y administración al servidor", () => {
    expect(sql).toContain("revoke all privileges on table public.profiles from public, anon, authenticated");
    expect(sql).toContain("grant select on table public.profiles to authenticated");
    expect(sql).toContain("grant select, insert, update, delete on table public.profiles to service_role");
    const grants = sql.match(/grant [^;]+;/gu) ?? [];
    expect(grants.filter((grant) => /to (?:anon|public)\b/u.test(grant))).toHaveLength(0);
    expect(grants.filter((grant) => /to authenticated\b/u.test(grant))).toEqual(["grant select on table public.profiles to authenticated;"]);
    expect(sql).toContain("revoke all privileges on function public.update_profiles_updated_at() from public, anon, authenticated");
  });

  it("es posterior a la migración previa y conserva íntegramente su contenido", () => {
    const files = readdirSync(new URL("../../../supabase/migrations/", import.meta.url)).sort();
    expect(files).toEqual([
      "20260821000100_create_diagnostic_history.sql",
      "20260917000100_create_profiles.sql",
      "20260922000100_create_rag_knowledge.sql",
    ]);
    const previous = readFileSync(new URL("../../../supabase/migrations/20260821000100_create_diagnostic_history.sql", import.meta.url), "utf8").replaceAll("\r\n", "\n");
    expect(createHash("sha256").update(previous).digest("hex")).toBe("3973a689547ff3d1ffa1893a80536b0e9cccaa67014f2f8f84d331002ec8f13a");
    expect(sql.startsWith("begin;")).toBe(true);
    expect(sql.trim().endsWith("commit;")).toBe(true);
  });
});
