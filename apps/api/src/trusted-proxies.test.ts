import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { createApp } from "./app.js";
import { AuthenticationError } from "./auth-service.js";
import { loadEnv } from "./config.js";
import { resolveTrustedProxyIps } from "./trusted-proxies.js";

const secret = "synthetic-proxy-config-secret-at-least-32-bytes";
const loopbackFixture = ["127.0.0.1", "::1"]; // Test transport only, not Render topology.
function fixture(trustedProxyIps?: string[]) {
  const login = vi.fn(async (input: unknown) => {
    if ((input as { nombre_usuario: string }).nombre_usuario !== "valid.user") {
      throw new AuthenticationError("AUTH_CREDENTIALS_INVALID", "Credenciales no válidas.", 401);
    }
    return { access_token: "synthetic-access-token", refresh_token: "synthetic-refresh-token" };
  });
  const app = createApp({ vinHmacSecret: secret, trustedProxyIps, authenticationService: {
    login, authenticate: async () => { throw new Error("must not authenticate"); },
  } });
  return { app, login };
}
function attempt(app: ReturnType<typeof createApp>, chain?: string, valid = false) {
  const pending = request(app).post("/api/auth/login");
  if (chain !== undefined) pending.set("X-Forwarded-For", chain);
  return pending.send({ nombre_usuario: valid ? "valid.user" : "invalid.user", password: "synthetic-password" });
}
afterEach(() => vi.restoreAllMocks());

describe("configuración explícita de proxies", () => {
  it.each([undefined, "", "   "])("sin configuración %s no confía en cabeceras", (value) => {
    expect(loadEnv({ VIN_HMAC_SECRET: secret, TRUSTED_PROXY_IPS: value }).TRUSTED_PROXY_IPS).toEqual([]);
    expect(fixture().app.get("trust proxy")).toBe(false);
    expect(fixture([]).app.get("trust proxy")).toBe(false);
  });
  it("propaga lista validada desde entorno hasta Express y normaliza mapped IPv4", () => {
    const config = loadEnv({ VIN_HMAC_SECRET: secret, TRUSTED_PROXY_IPS: " 127.0.0.1, ::1, 2001:db8::10 " });
    const { app } = fixture(config.TRUSTED_PROXY_IPS);
    expect(app.get("trust proxy")).toEqual(["127.0.0.1", "::1", "2001:db8::10"]);
    const trust = app.get("trust proxy fn");
    expect(trust("::ffff:127.0.0.1", 0)).toBe(true);
    expect(trust("2001:db8::10", 0)).toBe(true);
    expect(trust("192.0.2.10", 0)).toBe(false);
  });
  it.each(["true", "false", "1", "loopback", "uniquelocal", "0.0.0.0/0", "192.0.2.0/24", "::/0",
    "proxy.example", "127.0.0.1:1234", "[::1]", "fe80::1%eth0", "127.0.0.1,", ",", "x".repeat(2049),
    Array(33).fill("192.0.2.1").join(",")])("rechaza configuración %s sin reflejarla", (value) => {
    try {
      loadEnv({ VIN_HMAC_SECRET: secret, TRUSTED_PROXY_IPS: value });
      expect.fail("must reject invalid proxy configuration");
    } catch (error) {
      expect(error).toBeInstanceOf(ZodError);
      expect((error as ZodError).issues).toEqual([{ code: "custom", path: ["TRUSTED_PROXY_IPS"],
        message: "TRUSTED_PROXY_IPS requiere hasta 32 IP exactas IPv4/IPv6; no admite CIDR, nombres o saltos." }]);
    }
    expect(() => resolveTrustedProxyIps([value])).toThrow();
  });
  it("no admite booleans, números u objetos en el resolver", () => {
    for (const value of [true, false, 1, null, {}]) expect(() => resolveTrustedProxyIps(value)).toThrow();
  });
});

describe("login y límites conservados detrás de proxy verificado", () => {
  it("agotar A no bloquea B y añadir falsas IP a la izquierda no permite evadir el límite", async () => {
    const { app, login } = fixture(loopbackFixture);
    const diagnostics = vi.spyOn(console, "error");
    for (let i = 0; i < 10; i++) expect((await attempt(app, `198.51.100.${i + 1}, 192.0.2.1`)).status).toBe(401);
    const blocked = await attempt(app, "203.0.113.99, 192.0.2.1", true);
    expect(blocked.status).toBe(429);
    expect(blocked.headers["cache-control"]).toBe("no-store");
    expect(blocked.body.error.code).toBe("AUTH_RATE_LIMITED");
    expect(blocked.headers["ratelimit-policy"]).toBe("10;w=900");
    expect(login).toHaveBeenCalledTimes(10);
    expect((await attempt(app, "192.0.2.2", true)).status).toBe(200);
    expect(login).toHaveBeenCalledTimes(11);
    expect(diagnostics).not.toHaveBeenCalled();
  });
  it("una cadena de proxies exactos se recorre hasta el primer salto no confiable", async () => {
    const { app } = fixture([...loopbackFixture, "2001:db8:ffff::1"]);
    for (let i = 0; i < 10; i++) {
      expect((await attempt(app, `203.0.113.${i + 1}, 192.0.2.1, 2001:db8:ffff::1`)).status).toBe(401);
    }
    expect((await attempt(app, "203.0.113.100, 192.0.2.1, 2001:db8:ffff::1")).status).toBe(429);
    expect((await attempt(app, "192.0.2.2, 2001:db8:ffff::1", true)).status).toBe(200);
  });
  it.each([undefined, ["192.0.2.250"]])("el peer directo no confiable no impone IP: %s", async (trusted) => {
    const diagnostics = vi.spyOn(console, "error").mockImplementation(() => {});
    const { app } = fixture(trusted);
    for (let i = 0; i < 10; i++) expect((await attempt(app, `192.0.2.${i + 1}`)).status).toBe(401);
    expect((await attempt(app, "198.51.100.1", true)).status).toBe(429);
    // With default false the library's diagnostic remains active, not suppressed.
    if (trusted === undefined) expect(diagnostics.mock.calls.some(([error]) => error?.code === "ERR_ERL_UNEXPECTED_X_FORWARDED_FOR")).toBe(true);
  });
  it("IPv4 y mapped IPv4 comparten cupo, B conserva el suyo", async () => {
    const { app } = fixture(loopbackFixture);
    for (let i = 0; i < 10; i++) expect((await attempt(app, i % 2 ? "::ffff:192.0.2.1" : "192.0.2.1")).status).toBe(401);
    expect((await attempt(app, "::ffff:c000:201")).status).toBe(429);
    expect((await attempt(app, "192.0.2.2", true)).status).toBe(200);
  });
  it("mantiene agrupación IPv6 predeterminada /56 y no mezcla otra red", async () => {
    const { app } = fixture(loopbackFixture);
    for (let i = 1; i <= 10; i++) expect((await attempt(app, `2001:db8:1234:5600::${i}`)).status).toBe(401);
    expect((await attempt(app, "2001:0db8:1234:56ff:0:0:0:abcd")).status).toBe(429);
    expect((await attempt(app, "2001:db8:1234:5700::1", true)).status).toBe(200);
  });
  it.each([undefined, "", "unknown", "192.0.2.1,,198.51.100.1", "192.0.2.1:123", "[2001:db8::1]",
    "fe80::1%eth0", "127.0.0.1", "invalid, 192.0.2.1", Array(33).fill("192.0.2.1").join(","), "x".repeat(2049)])("rechaza cadena ausente/inválida del peer confiable antes de login: %s", async (chain) => {
    const { app, login } = fixture(loopbackFixture);
    const diagnostics = vi.spyOn(console, "error");
    const response = await attempt(app, chain);
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: { code: "AUTH_REQUEST_INVALID", message: "La cadena de proxy de inicio de sesión no es válida." } });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(login).not.toHaveBeenCalled();
    expect(diagnostics).not.toHaveBeenCalled();
  });
  it("conserva login directo normal sin cabeceras y no penaliza éxitos", async () => {
    const { app } = fixture();
    for (let i = 0; i < 11; i++) expect((await attempt(app, undefined, true)).status).toBe(200);
  });
});
