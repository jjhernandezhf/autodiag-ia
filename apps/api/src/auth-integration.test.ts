import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "./app.js";
import {
  AuthenticationError,
  type AuthenticatedIdentity,
  type AuthenticationService,
  type LoginTokens,
} from "./auth-service.js";

const TEST_SECRET = "synthetic-auth-secret-with-at-least-32-bytes";
const IDENTITY: AuthenticatedIdentity = {
  id: "6a103df0-8e4d-4c51-89f5-7030c5443d89",
  username: "usuario.apellido",
};
const TOKENS: LoginTokens = {
  access_token: "synthetic-access-token",
  refresh_token: "synthetic-refresh-token",
};

function createAuthApp(overrides: Partial<AuthenticationService> = {}) {
  const service: AuthenticationService = {
    login: overrides.login ?? (async () => TOKENS),
    authenticate: overrides.authenticate ?? (async () => IDENTITY),
  };
  return { app: createApp({ vinHmacSecret: TEST_SECRET, authenticationService: service }), service };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("endpoints de autenticación", () => {
  it("mantiene /health público y permite login sin Authorization", async () => {
    const login = vi.fn(async () => TOKENS);
    const { app } = createAuthApp({ login });

    const health = await request(app).get("/health");
    const response = await request(app)
      .post("/api/auth/login")
      .send({ nombre_usuario: "usuario.apellido", password: "synthetic" });

    expect(health.status).toBe(200);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(TOKENS);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers.pragma).toBe("no-cache");
    expect(login).toHaveBeenCalledWith({ nombre_usuario: "usuario.apellido", password: "synthetic" });
  });

  it("no registra el body, contraseña ni tokens", async () => {
    const spies = ["log", "info", "warn", "error"].map((method) =>
      vi.spyOn(console, method as "log").mockImplementation(() => undefined));
    const { app } = createAuthApp();

    const response = await request(app)
      .post("/api/auth/login")
      .send({ nombre_usuario: "usuario.apellido", password: "synthetic-password" });

    expect(response.status).toBe(200);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("rechaza JSON mal formado antes del servicio y conserva headers privados", async () => {
    const login = vi.fn(async () => TOKENS);
    const { app } = createAuthApp({ login });
    const response = await request(app)
      .post("/api/auth/login")
      .set("Content-Type", "application/json")
      .send("{");

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: { code: "AUTH_REQUEST_INVALID", message: "La solicitud de inicio de sesión no es válida." },
    });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers.pragma).toBe("no-cache");
    expect(login).not.toHaveBeenCalled();
  });

  it.each([
    ["credenciales", new AuthenticationError("AUTH_CREDENTIALS_INVALID", "Usuario o contraseña incorrectos.", 401)],
    ["solicitud", new AuthenticationError("AUTH_REQUEST_INVALID", "La solicitud de inicio de sesión no es válida.", 400)],
    ["proveedor", new AuthenticationError("AUTH_PROVIDER_UNAVAILABLE", "El servicio de autenticación no está disponible temporalmente.", 503)],
  ])("devuelve un error controlado de %s sin detalles internos", async (_case, error) => {
    const { app } = createAuthApp({ login: async () => { throw error; } });
    const response = await request(app).post("/api/auth/login").send({
      nombre_usuario: "usuario.apellido",
      password: "private-value",
    });

    expect(response.status).toBe(error.status);
    expect(response.body).toEqual({ error: { code: error.code, message: error.message } });
    expect(JSON.stringify(response.body)).not.toContain("private-value");
  });

  it.each([
    [undefined],
    ["Basic synthetic"],
    ["Bearer"],
    ["Bearer synthetic extra"],
    ["bearer synthetic"],
  ])("rechaza Authorization ausente o mal formado: %s", async (authorization) => {
    const authenticate = vi.fn(async () => IDENTITY);
    const { app } = createAuthApp({ authenticate });
    const pending = request(app).get("/api/auth/me");
    if (authorization) pending.set("Authorization", authorization);
    const response = await pending;

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("AUTH_SESSION_INVALID");
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("valida Bearer y /api/auth/me devuelve solo UUID y username", async () => {
    const authenticate = vi.fn(async () => IDENTITY);
    const { app } = createAuthApp({ authenticate });
    const response = await request(app)
      .get("/api/auth/me")
      .set("Authorization", "Bearer synthetic-access-token");

    expect(response.status).toBe(200);
    expect(response.body).toEqual(IDENTITY);
    expect(Object.keys(response.body)).toEqual(["id", "username"]);
    expect(authenticate).toHaveBeenCalledWith("synthetic-access-token");
  });

  it.each([
    [new AuthenticationError("AUTH_SESSION_INVALID", "La sesión no es válida.", 401), 401],
    [new AuthenticationError("AUTH_PROFILE_FORBIDDEN", "El usuario no tiene acceso autorizado.", 403), 403],
    [new AuthenticationError("AUTH_PROVIDER_UNAVAILABLE", "El servicio de autenticación no está disponible temporalmente.", 503), 503],
  ])("propaga de forma controlada la validación del middleware", async (error, status) => {
    const { app } = createAuthApp({ authenticate: async () => { throw error; } });
    const response = await request(app).get("/api/auth/me").set("Authorization", "Bearer synthetic");

    expect(response.status).toBe(status);
    expect(response.body).toEqual({ error: { code: error.code, message: error.message } });
  });

  it("protege upload y analyze, pero un token válido permite alcanzar sus contratos", async () => {
    const authenticate = vi.fn(async () => IDENTITY);
    const { app } = createAuthApp({ authenticate });

    const uploadWithoutToken = await request(app).post("/api/reports/upload");
    const analyzeWithoutToken = await request(app).post("/api/reports/analyze").send({});
    const uploadWithToken = await request(app)
      .post("/api/reports/upload")
      .set("Authorization", "Bearer synthetic-access-token");
    const analyzeWithToken = await request(app)
      .post("/api/reports/analyze")
      .set("Authorization", "Bearer synthetic-access-token")
      .send({});

    expect(uploadWithoutToken.status).toBe(401);
    expect(analyzeWithoutToken.status).toBe(401);
    expect(uploadWithToken.status).toBe(400);
    expect(uploadWithToken.body.error.code).toBe("FILE_REQUIRED");
    expect(analyzeWithToken.status).toBe(400);
    expect(analyzeWithToken.body.error.code).toBe("AI_INPUT_INVALID");
    expect(authenticate).toHaveBeenCalledTimes(2);
  });
});

describe("rate limit de login", () => {
  const invalidCredentials = new AuthenticationError(
    "AUTH_CREDENTIALS_INVALID",
    "Usuario o contraseña incorrectos.",
    401,
  );

  it("cuenta intentos fallidos, conserva headers estándar y responde 429 genérico", async () => {
    const login = vi.fn(async () => { throw invalidCredentials; });
    const { app } = createAuthApp({ login });

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await request(app).post("/api/auth/login").send({ nombre_usuario: "no.existe", password: "x" });
      expect(response.status).toBe(401);
      expect(response.headers).toHaveProperty("ratelimit-limit");
      expect(response.headers).toHaveProperty("ratelimit-remaining");
      expect(response.headers).toHaveProperty("ratelimit-reset");
    }
    const limited = await request(app).post("/api/auth/login").send({ nombre_usuario: "otro.usuario", password: "y" });

    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({
      error: { code: "AUTH_RATE_LIMITED", message: "Demasiados intentos. Intenta nuevamente más tarde." },
    });
    expect(limited.headers["cache-control"]).toBe("no-store");
    expect(limited.headers.pragma).toBe("no-cache");
    expect(JSON.stringify(limited.body)).not.toMatch(/no\.existe|otro\.usuario/iu);
    expect(login).toHaveBeenCalledTimes(10);
  });

  it("no penaliza permanentemente un login exitoso", async () => {
    const login = vi.fn(async (input: unknown) => {
      const password = (input as { password?: string }).password;
      if (password === "correcta") return TOKENS;
      throw invalidCredentials;
    });
    const { app } = createAuthApp({ login });

    for (let attempt = 0; attempt < 9; attempt += 1) {
      expect((await request(app).post("/api/auth/login").send({ nombre_usuario: "usuario.apellido", password: "mal" })).status).toBe(401);
    }
    expect((await request(app).post("/api/auth/login").send({ nombre_usuario: "usuario.apellido", password: "correcta" })).status).toBe(200);
    expect((await request(app).post("/api/auth/login").send({ nombre_usuario: "usuario.apellido", password: "mal" })).status).toBe(401);
    expect((await request(app).post("/api/auth/login").send({ nombre_usuario: "usuario.apellido", password: "mal" })).status).toBe(429);
  });

  it("mantiene un almacén aislado por instancia de aplicación", async () => {
    const login = vi.fn(async () => { throw invalidCredentials; });
    const first = createAuthApp({ login }).app;
    const second = createAuthApp({ login }).app;

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await request(first).post("/api/auth/login").send({ nombre_usuario: "usuario.apellido", password: "mal" });
    }
    expect((await request(first).post("/api/auth/login").send({ nombre_usuario: "usuario.apellido", password: "mal" })).status).toBe(429);
    expect((await request(second).post("/api/auth/login").send({ nombre_usuario: "usuario.apellido", password: "mal" })).status).toBe(401);
  });
});
