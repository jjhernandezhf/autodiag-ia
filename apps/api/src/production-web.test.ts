import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { serveCompiledWeb } from "./production-web.js";

const secret = "production-web-synthetic-secret-at-least-32-bytes";
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "autodiag-web-test-"));
  mkdirSync(join(directory, "assets"));
  writeFileSync(join(directory, "index.html"), "<!doctype html><title>Synthetic web</title>");
  writeFileSync(join(directory, "assets", "app.js"), "/* synthetic asset */");
  writeFileSync(join(directory, "assets", ".env"), "synthetic-private-marker");
  writeFileSync(join(directory, "assets", "app.js.map"), "synthetic-private-marker");
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
function app() {
  const instance = createApp({ vinHmacSecret: secret });
  serveCompiledWeb(instance, directory);
  return instance;
}

describe("web de producción bajo el mismo origen", () => {
  it("sirve index, HEAD y assets reales, sin cache compartida", async () => {
    const instance = app();
    const root = await request(instance).get("/");
    expect(root.status).toBe(200);
    expect(root.text).toContain("Synthetic web");
    expect(root.headers["cache-control"]).toBe("no-store");
    expect((await request(instance).head("/")).status).toBe(200);
    const asset = await request(instance).get("/assets/app.js");
    expect(asset.status).toBe(200);
    expect(asset.text).toBe("/* synthetic asset */");
  });

  it("solo hace fallback para navegación HTML válida sin extensión", async () => {
    const instance = app();
    expect((await request(instance).get("/history/detail").set("Accept", "text/html").set("Sec-Fetch-Mode", "navigate")).status).toBe(200);
    for (const headers of [
      { Accept: "application/json" }, { Accept: "*/*" }, { Accept: "text/html;q=0" },
      { Accept: "text/html", "Sec-Fetch-Mode": "cors" },
      { Accept: "text/html", "Sec-Fetch-Dest": "script" },
    ]) {
      expect((await request(instance).get("/history/detail").set(headers)).status).toBe(404);
    }
  });

  it.each(["/assets/missing.js", "/assets/missing", "/favicon.ico", "/assets/.env", "/assets/app.js.map",
    "/.env", "/apps/web/.env.local", "/src/index.ts", "/node_modules", "/package.json", "/docs", "/assets/%2e%2e/package.json"])("no entrega HTML ni archivos privados: %s", async (path) => {
    const response = await request(app()).get(path).set("Accept", "text/html");
    expect(response.status).toBe(404);
    expect(response.type).toBe("application/json");
    expect(response.text).not.toContain("Synthetic web");
    expect(response.text).not.toContain("synthetic-private-marker");
  });

  it("mantiene health, errores API y autenticación sin fallback HTML", async () => {
    const instance = app();
    const health = await request(instance).get("/api/health");
    expect(health.body).toEqual({ status: "ok" });
    expect(health.headers["cache-control"]).toBe("no-store");
    for (const path of ["/api", "/api/missing", "/API/missing"]) {
      const missing = await request(instance).get(path).set("Accept", "text/html");
      expect(missing.status).toBe(404);
      expect(missing.body.error.code).toBe("NOT_FOUND");
    }
    expect((await request(instance).get("/api/history")).status).toBe(401);
    expect((await request(instance).post("/api/reports/upload")).status).toBe(401);
    expect((await request(instance).post("/api/auth/login").send({})).status).toBe(400);
  });

  it("no sirve HTML para otros métodos", async () => {
    const instance = app();
    expect((await request(instance).post("/").set("Accept", "text/html")).status).toBe(404);
    expect((await request(instance).put("/history").set("Accept", "text/html")).status).toBe(404);
  });

  it("falla con mensaje seguro si falta el artefacto; desarrollo no lo necesita", async () => {
    rmSync(join(directory, "index.html"));
    expect(() => app()).toThrow("El build web no está disponible.");
    const development = createApp({ vinHmacSecret: secret });
    expect((await request(development).get("/api/health")).status).toBe(200);
  });
});
