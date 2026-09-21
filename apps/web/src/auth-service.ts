import type { AuthChangeEvent, SupabaseClient } from "@supabase/supabase-js";

import {
  getSupabaseBrowserClient,
  SupabaseBrowserClientError,
  SupabaseBrowserConfigurationError,
} from "./supabase-client";

export interface AuthIdentity {
  id: string;
  username: string;
}

export type SupportedAuthEvent = "INITIAL_SESSION" | "SIGNED_IN" | "SIGNED_OUT" | "TOKEN_REFRESHED" | "PASSWORD_RECOVERY";

export type BrowserAuthenticationErrorCode =
  | "AUTH_CONFIGURATION_UNAVAILABLE"
  | "AUTH_CREDENTIALS_INVALID"
  | "AUTH_RATE_LIMITED"
  | "AUTH_SESSION_INVALID"
  | "AUTH_PROVIDER_UNAVAILABLE";

export class BrowserAuthenticationError extends Error {
  constructor(
    public readonly code: BrowserAuthenticationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BrowserAuthenticationError";
  }
}

export interface BrowserAuthenticationService {
  initialize(signal?: AbortSignal): Promise<AuthIdentity | null>;
  login(username: string, password: string, signal?: AbortSignal): Promise<AuthIdentity>;
  validateCurrentSession(signal?: AbortSignal): Promise<AuthIdentity | null>;
  authenticatedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  subscribe(listener: (event: SupportedAuthEvent) => void): () => void;
  signOutLocal(): Promise<void>;
}

interface BrowserAuthenticationDependencies {
  getClient?: () => SupabaseClient;
  fetch?: typeof fetch;
}

const CONFIGURATION_MESSAGE = "El acceso seguro no está configurado en este entorno.";
const CREDENTIALS_MESSAGE = "Usuario o contraseña incorrectos.";
const RATE_LIMIT_MESSAGE = "Demasiados intentos. Intenta nuevamente más tarde.";
const SESSION_MESSAGE = "Tu sesión ya no es válida. Inicia sesión nuevamente.";
const AVAILABILITY_MESSAGE = "No fue posible iniciar sesión. Intenta nuevamente.";

function configurationError(error: unknown) {
  if (error instanceof BrowserAuthenticationError) return error;
  return error instanceof SupabaseBrowserConfigurationError || error instanceof SupabaseBrowserClientError
    ? new BrowserAuthenticationError("AUTH_CONFIGURATION_UNAVAILABLE", CONFIGURATION_MESSAGE)
    : new BrowserAuthenticationError("AUTH_PROVIDER_UNAVAILABLE", AVAILABILITY_MESSAGE);
}

function parseIdentity(value: unknown): AuthIdentity | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).sort().join(",") !== "id,username" ||
    typeof candidate.id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(candidate.id) ||
    typeof candidate.username !== "string" ||
    !/^[a-z][a-z0-9]*([._-][a-z0-9]+)*$/u.test(candidate.username) ||
    candidate.username.length < 3 || candidate.username.length > 64
  ) return null;
  return { id: candidate.id, username: candidate.username };
}

function parseTokens(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).sort().join(",") !== "access_token,refresh_token" ||
    typeof candidate.access_token !== "string" || !candidate.access_token ||
    typeof candidate.refresh_token !== "string" || !candidate.refresh_token
  ) return null;
  return { access_token: candidate.access_token, refresh_token: candidate.refresh_token };
}

async function readJson(response: Response) {
  try {
    return await response.json() as unknown;
  } catch {
    return null;
  }
}

function errorCode(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const error = (value as { error?: unknown }).error;
  if (!error || typeof error !== "object") return undefined;
  return typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : undefined;
}

export function createBrowserAuthenticationService(
  dependencies: BrowserAuthenticationDependencies = {},
): BrowserAuthenticationService {
  const getClient = dependencies.getClient ?? getSupabaseBrowserClient;
  const request = dependencies.fetch ?? ((input, init) => fetch(input, init));

  function client() {
    try {
      return getClient();
    } catch (error) {
      throw configurationError(error);
    }
  }

  async function sessionAccessToken() {
    let result;
    try {
      result = await client().auth.getSession();
    } catch (error) {
      if (error instanceof BrowserAuthenticationError) throw error;
      throw new BrowserAuthenticationError("AUTH_PROVIDER_UNAVAILABLE", AVAILABILITY_MESSAGE);
    }
    if (result.error) throw new BrowserAuthenticationError("AUTH_PROVIDER_UNAVAILABLE", AVAILABILITY_MESSAGE);
    return result.data.session?.access_token ?? null;
  }

  async function validateCurrentSession(signal?: AbortSignal): Promise<AuthIdentity | null> {
    const accessToken = await sessionAccessToken();
    if (!accessToken) return null;

    let response: Response;
    try {
      response = await request("/api/auth/me", {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      throw new BrowserAuthenticationError("AUTH_PROVIDER_UNAVAILABLE", AVAILABILITY_MESSAGE);
    }
    const body = await readJson(response);
    if (response.status === 401 || response.status === 403) {
      throw new BrowserAuthenticationError("AUTH_SESSION_INVALID", SESSION_MESSAGE);
    }
    if (!response.ok) throw new BrowserAuthenticationError("AUTH_PROVIDER_UNAVAILABLE", AVAILABILITY_MESSAGE);
    const identity = parseIdentity(body);
    if (!identity) throw new BrowserAuthenticationError("AUTH_PROVIDER_UNAVAILABLE", AVAILABILITY_MESSAGE);
    return identity;
  }

  return {
    initialize: validateCurrentSession,
    validateCurrentSession,

    async login(username, password, signal) {
      let response: Response;
      try {
        response = await request("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ nombre_usuario: username, password }),
          signal,
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        throw new BrowserAuthenticationError("AUTH_PROVIDER_UNAVAILABLE", AVAILABILITY_MESSAGE);
      }
      const body = await readJson(response);
      if (!response.ok) {
        const code = errorCode(body);
        if (response.status === 401 || code === "AUTH_CREDENTIALS_INVALID") {
          throw new BrowserAuthenticationError("AUTH_CREDENTIALS_INVALID", CREDENTIALS_MESSAGE);
        }
        if (response.status === 429 || code === "AUTH_RATE_LIMITED") {
          throw new BrowserAuthenticationError("AUTH_RATE_LIMITED", RATE_LIMIT_MESSAGE);
        }
        if (code === "AUTH_CONFIGURATION_UNAVAILABLE") {
          throw new BrowserAuthenticationError("AUTH_CONFIGURATION_UNAVAILABLE", CONFIGURATION_MESSAGE);
        }
        throw new BrowserAuthenticationError("AUTH_PROVIDER_UNAVAILABLE", AVAILABILITY_MESSAGE);
      }

      const tokens = parseTokens(body);
      if (!tokens) throw new BrowserAuthenticationError("AUTH_PROVIDER_UNAVAILABLE", AVAILABILITY_MESSAGE);
      let setSessionResult;
      try {
        setSessionResult = await client().auth.setSession(tokens);
      } catch {
        throw new BrowserAuthenticationError("AUTH_PROVIDER_UNAVAILABLE", AVAILABILITY_MESSAGE);
      }
      if (setSessionResult.error) throw new BrowserAuthenticationError("AUTH_PROVIDER_UNAVAILABLE", AVAILABILITY_MESSAGE);

      try {
        const identity = await validateCurrentSession(signal);
        if (!identity) throw new BrowserAuthenticationError("AUTH_SESSION_INVALID", SESSION_MESSAGE);
        return identity;
      } catch (error) {
        try {
          await client().auth.signOut({ scope: "local" });
        } catch {
          // Preserve the original controlled error; never expose SDK details.
        }
        throw error;
      }
    },

    async authenticatedFetch(input, init = {}) {
      const accessToken = await sessionAccessToken();
      if (!accessToken) throw new BrowserAuthenticationError("AUTH_SESSION_INVALID", SESSION_MESSAGE);
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${accessToken}`);
      return request(input, { ...init, headers });
    },

    subscribe(listener) {
      let subscription;
      try {
        const result = client().auth.onAuthStateChange((event: AuthChangeEvent) => {
          if (["INITIAL_SESSION", "SIGNED_IN", "SIGNED_OUT", "TOKEN_REFRESHED", "PASSWORD_RECOVERY"].includes(event)) {
            listener(event as SupportedAuthEvent);
          }
        });
        subscription = result.data.subscription;
      } catch (error) {
        throw configurationError(error);
      }
      return () => subscription.unsubscribe();
    },

    async signOutLocal() {
      try {
        const result = await client().auth.signOut({ scope: "local" });
        if (result.error) throw result.error;
      } catch (error) {
        if (error instanceof BrowserAuthenticationError) throw error;
        throw new BrowserAuthenticationError("AUTH_PROVIDER_UNAVAILABLE", "No fue posible cerrar la sesión. Intenta nuevamente.");
      }
    },
  };
}

export const browserAuthenticationService = createBrowserAuthenticationService();
