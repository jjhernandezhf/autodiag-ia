import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { AuthenticationError, createAuthenticationService } from "./auth-service.js";
import { SupabaseConfigurationError } from "./supabase-config.js";

const PROFILE = {
  id: "6a103df0-8e4d-4c51-89f5-7030c5443d89",
  username: "usuario.apellido",
  is_active: true,
};

interface ClientScenario {
  profile?: unknown;
  profileError?: unknown;
  user?: unknown;
  userError?: unknown;
  session?: unknown;
  signInError?: unknown;
  getUser?: unknown;
  getUserError?: unknown;
}

function createClients(scenario: ClientScenario = {}) {
  const operationOrder: string[] = [];
  const eq = vi.fn();
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn((field: string, value: string) => {
      eq(field, value);
      return query;
    }),
    maybeSingle: vi.fn(async () => ({
      data: scenario.profile === undefined ? PROFILE : scenario.profile,
      error: scenario.profileError ?? null,
    })),
  };
  const getUserById = vi.fn(async (id: string) => {
    operationOrder.push(`admin:${id}`);
    return {
      data: { user: scenario.user === undefined ? { id: PROFILE.id, email: "synthetic@example.invalid" } : scenario.user },
      error: scenario.userError ?? null,
    };
  });
  const getUser = vi.fn(async () => ({
    data: { user: scenario.getUser === undefined ? { id: PROFILE.id } : scenario.getUser },
    error: scenario.getUserError ?? null,
  }));
  const signInWithPassword = vi.fn(async () => {
    operationOrder.push("signin");
    return {
      data: {
        session: scenario.session === undefined
          ? { access_token: "synthetic-access-token", refresh_token: "synthetic-refresh-token" }
          : scenario.session,
      },
      error: scenario.signInError ?? null,
    };
  });
  const adminClient = {
    from: vi.fn(() => query),
    auth: { admin: { getUserById }, getUser },
  } as unknown as SupabaseClient;
  const publicClient = { auth: { signInWithPassword } } as unknown as SupabaseClient;
  return { adminClient, publicClient, eq, getUserById, getUser, signInWithPassword, operationOrder };
}

function expectAuthenticationError(error: unknown, code: string, status: number) {
  expect(error).toBeInstanceOf(AuthenticationError);
  expect(error).toMatchObject({ code, status });
}

describe("servicio de autenticación", () => {
  it("normaliza el username, resuelve el email solo internamente y devuelve exclusivamente tokens", async () => {
    const clients = createClients();
    const service = createAuthenticationService({
      getAdminClient: () => clients.adminClient,
      createPublicClient: () => clients.publicClient,
    });

    const result = await service.login({ nombre_usuario: "  Usuario.Apellido  ", password: "synthetic-password" });

    expect(clients.eq).toHaveBeenCalledWith("username", "usuario.apellido");
    expect(clients.getUserById).toHaveBeenCalledWith(PROFILE.id);
    expect(clients.signInWithPassword).toHaveBeenCalledWith({
      email: "synthetic@example.invalid",
      password: "synthetic-password",
    });
    expect(result).toEqual({ access_token: "synthetic-access-token", refresh_token: "synthetic-refresh-token" });
    expect(Object.keys(result)).toEqual(["access_token", "refresh_token"]);
    expect(JSON.stringify(result)).not.toMatch(/email|password|user|metadata/iu);
  });

  it.each([
    ["inexistente", { profile: null }],
    ["inactivo", { profile: { ...PROFILE, is_active: false } }],
    ["usuario Auth inexistente", { user: null, userError: { status: 404 } }],
    ["usuario Auth sin email", { user: { id: PROFILE.id, email: null } }],
    ["contraseña incorrecta", { signInError: { status: 400 } }],
  ])("devuelve el mismo error genérico para %s", async (_case, scenario) => {
    const clients = createClients(scenario);
    const service = createAuthenticationService({
      getAdminClient: () => clients.adminClient,
      createPublicClient: () => clients.publicClient,
    });

    const promise = service.login({ nombre_usuario: "usuario.apellido", password: "incorrecta" });
    await expect(promise).rejects.toThrow("Usuario o contraseña incorrectos.");
    await expect(promise).rejects.toMatchObject({
      code: "AUTH_CREDENTIALS_INVALID",
      status: 401,
      message: "Usuario o contraseña incorrectos.",
    });
  });

  it.each([
    {},
    { nombre_usuario: 123, password: "x" },
    { nombre_usuario: "usuario.apellido", password: "" },
    { nombre_usuario: "usuario.apellido", password: "x", unexpected: true },
  ])("rechaza solicitudes fuera del contrato sin consultar Supabase", async (input) => {
    const clients = createClients();
    const service = createAuthenticationService({ getAdminClient: () => clients.adminClient });

    const promise = service.login(input);
    await expect(promise).rejects.toMatchObject({
      code: "AUTH_REQUEST_INVALID",
      status: 400,
      message: "La solicitud de inicio de sesión no es válida.",
    });
    expect(clients.adminClient.from).not.toHaveBeenCalled();
  });

  it.each(["a b", "ab?", "a"])("oculta el motivo para username con formato inválido: %s", async (username) => {
    const clients = createClients();
    const service = createAuthenticationService({ getAdminClient: () => clients.adminClient });

    const promise = service.login({ nombre_usuario: username, password: "synthetic" });
    await expect(promise).rejects.toThrow("Usuario o contraseña incorrectos.");
    await expect(promise).rejects.toMatchObject({
      code: "AUTH_CREDENTIALS_INVALID",
      status: 401,
      message: "Usuario o contraseña incorrectos.",
    });
    expect(clients.adminClient.from).not.toHaveBeenCalled();
  });

  it("ejecuta la ruta dummy completa para un username inexistente y descarta una sesión inesperada", async () => {
    const clients = createClients({ profile: null });
    const service = createAuthenticationService({
      getAdminClient: () => clients.adminClient,
      createPublicClient: () => clients.publicClient,
    });

    await expect(service.login({ nombre_usuario: "no.existe", password: "synthetic" })).rejects.toMatchObject({
      code: "AUTH_CREDENTIALS_INVALID",
      status: 401,
      message: "Usuario o contraseña incorrectos.",
    });
    expect(clients.getUserById).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000000");
    expect(clients.signInWithPassword).toHaveBeenCalledWith({
      email: "autodiag-unavailable-user@example.invalid",
      password: "synthetic",
    });
    expect(clients.operationOrder).toEqual([
      "admin:00000000-0000-4000-8000-000000000000",
      "signin",
    ]);
  });

  it("un perfil inactivo usa exclusivamente la identidad dummy", async () => {
    const inactiveEmail = "inactive-user@example.invalid";
    const clients = createClients({
      profile: { ...PROFILE, is_active: false },
      user: { id: PROFILE.id, email: inactiveEmail },
    });
    const service = createAuthenticationService({
      getAdminClient: () => clients.adminClient,
      createPublicClient: () => clients.publicClient,
    });

    await expect(service.login({ nombre_usuario: PROFILE.username, password: "synthetic" })).rejects.toMatchObject({
      code: "AUTH_CREDENTIALS_INVALID",
      status: 401,
      message: "Usuario o contraseña incorrectos.",
    });
    expect(clients.getUserById).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000000");
    expect(clients.signInWithPassword).toHaveBeenCalledWith({
      email: "autodiag-unavailable-user@example.invalid",
      password: "synthetic",
    });
    expect(clients.signInWithPassword).not.toHaveBeenCalledWith(expect.objectContaining({ email: inactiveEmail }));
  });

  it("una contraseña incorrecta de un usuario existente conserva la ruta normal", async () => {
    const clients = createClients({ signInError: { status: 400 } });
    const service = createAuthenticationService({
      getAdminClient: () => clients.adminClient,
      createPublicClient: () => clients.publicClient,
    });

    await expect(service.login({ nombre_usuario: PROFILE.username, password: "incorrecta" })).rejects.toMatchObject({
      code: "AUTH_CREDENTIALS_INVALID",
      status: 401,
      message: "Usuario o contraseña incorrectos.",
    });
    expect(clients.getUserById).toHaveBeenCalledWith(PROFILE.id);
    expect(clients.signInWithPassword).toHaveBeenCalledWith({
      email: "synthetic@example.invalid",
      password: "incorrecta",
    });
    expect(clients.operationOrder).toEqual([`admin:${PROFILE.id}`, "signin"]);
  });

  it("un perfil activo sin usuario Auth completa la operación restante con la identidad dummy", async () => {
    const clients = createClients({ user: null, userError: { status: 404 } });
    const service = createAuthenticationService({
      getAdminClient: () => clients.adminClient,
      createPublicClient: () => clients.publicClient,
    });

    await expect(service.login({ nombre_usuario: PROFILE.username, password: "synthetic" })).rejects.toMatchObject({
      code: "AUTH_CREDENTIALS_INVALID",
      status: 401,
      message: "Usuario o contraseña incorrectos.",
    });
    expect(clients.getUserById).toHaveBeenCalledWith(PROFILE.id);
    expect(clients.signInWithPassword).toHaveBeenCalledWith({
      email: "autodiag-unavailable-user@example.invalid",
      password: "synthetic",
    });
    expect(clients.operationOrder).toEqual([`admin:${PROFILE.id}`, "signin"]);
  });

  it("crea un cliente público nuevo por cada intento", async () => {
    const clients = createClients();
    const createPublicClient = vi.fn(() => clients.publicClient);
    const service = createAuthenticationService({ getAdminClient: () => clients.adminClient, createPublicClient });

    await service.login({ nombre_usuario: "usuario.apellido", password: "uno" });
    await service.login({ nombre_usuario: "usuario.apellido", password: "dos" });

    expect(createPublicClient).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["base de datos", { profileError: { message: "private" } }],
    ["Auth administrativo", { userError: { status: 500 } }],
    ["login del proveedor", { signInError: { status: 500 } }],
    ["sesión incompleta", { session: { access_token: "only-access" } }],
  ])("normaliza un fallo interno de %s sin exponer detalles", async (_case, scenario) => {
    const clients = createClients(scenario);
    const service = createAuthenticationService({
      getAdminClient: () => clients.adminClient,
      createPublicClient: () => clients.publicClient,
    });

    const promise = service.login({ nombre_usuario: "usuario.apellido", password: "synthetic" });
    await expect(promise).rejects.toThrow("El servicio de autenticación no está disponible temporalmente.");
    await expect(promise).rejects.toMatchObject({
      code: "AUTH_PROVIDER_UNAVAILABLE",
      status: 503,
      message: "El servicio de autenticación no está disponible temporalmente.",
    });
  });

  it("distingue configuración ausente sin revelar variables", async () => {
    const service = createAuthenticationService({ getAdminClient: () => { throw new SupabaseConfigurationError(); } });
    const promise = service.login({ nombre_usuario: "usuario.apellido", password: "synthetic" });

    await expect(promise).rejects.toThrow("El acceso seguro no está configurado en este entorno.");
    await promise.catch((error) => {
      expectAuthenticationError(error, "AUTH_CONFIGURATION_UNAVAILABLE", 503);
      expect(String(error)).not.toMatch(/SUPABASE_|sb_secret_|service_role/iu);
    });
  });

  it("valida el token con getUser y adjunta solo UUID y username activos", async () => {
    const clients = createClients();
    const service = createAuthenticationService({ getAdminClient: () => clients.adminClient });

    await expect(service.authenticate("synthetic-access-token")).resolves.toEqual({
      id: PROFILE.id,
      username: PROFILE.username,
    });
    expect(clients.getUser).toHaveBeenCalledWith("synthetic-access-token");
    expect(clients.eq).toHaveBeenCalledWith("id", PROFILE.id);
  });

  it.each([
    ["token inválido", { getUser: null, getUserError: { status: 401 } }, "AUTH_SESSION_INVALID", 401, "La sesión no es válida."],
    ["token expirado", { getUser: null, getUserError: { status: 401, message: "expired" } }, "AUTH_SESSION_INVALID", 401, "La sesión no es válida."],
    ["perfil inexistente", { profile: null }, "AUTH_PROFILE_FORBIDDEN", 403, "El usuario no tiene acceso autorizado."],
    ["perfil inactivo", { profile: { ...PROFILE, is_active: false } }, "AUTH_PROFILE_FORBIDDEN", 403, "El usuario no tiene acceso autorizado."],
    ["error del proveedor", { getUserError: { status: 500 } }, "AUTH_PROVIDER_UNAVAILABLE", 503, "El servicio de autenticación no está disponible temporalmente."],
  ])("controla %s al autenticar", async (_case, scenario, code, status, message) => {
    const clients = createClients(scenario);
    const service = createAuthenticationService({ getAdminClient: () => clients.adminClient });
    await expect(service.authenticate("synthetic-token")).rejects.toMatchObject({ code, status, message });
  });
});
