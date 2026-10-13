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
    public readonly sessionEstablished = false,
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
  subscribe(listener: (event: SupportedAuthEvent, userId?: string | null) => void): () => void;
  signOutLocal(): Promise<void>;
}

interface BrowserAuthenticationDependencies {
  getClient?: () => SupabaseClient;
  fetch?: typeof fetch;
  providerOperationTimeoutMs?: number;
}

const CONFIGURATION_MESSAGE = "El acceso seguro no está configurado en este entorno.";
const CREDENTIALS_MESSAGE = "Usuario o contraseña incorrectos.";
const RATE_LIMIT_MESSAGE = "Demasiados intentos. Intenta nuevamente más tarde.";
const SESSION_MESSAGE = "Tu sesión ya no es válida. Inicia sesión nuevamente.";
const AVAILABILITY_MESSAGE = "No fue posible iniciar sesión. Intenta nuevamente.";
const PROVIDER_TIMEOUT_MESSAGE = "El servicio de autenticación no respondió a tiempo. Tu sesión no fue cerrada. Intenta nuevamente.";
const DEFAULT_PROVIDER_OPERATION_TIMEOUT_MS = 10_000;
const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

interface AuthenticationContext {
  userId: string;
  generation: number;
  accessToken: string;
}

interface RefreshOperation {
  userId: string;
  generation: number;
  promise: Promise<AuthenticationContext>;
  mutation: ProviderMutation<AuthenticationContext>;
  consumers: number;
  superseded: boolean;
}

interface ProviderMutation<T> {
  promise: Promise<T>;
  cancelIfPending: () => void;
  hasStarted: () => boolean;
}

function staleAuthenticationOperation() {
  return new DOMException("The authentication context changed.", "AbortError");
}

function providerTimeoutError() {
  return new BrowserAuthenticationError("AUTH_PROVIDER_UNAVAILABLE", PROVIDER_TIMEOUT_MESSAGE);
}

function waitForLogicalConsumer<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  onInactive: () => void,
) {
  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    };
    const finish = (callback: () => void, inactive: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (inactive) onInactive();
      callback();
    };
    const abort = () => finish(() => reject(staleAuthenticationOperation()), true);
    const timeout = setTimeout(
      () => finish(() => reject(providerTimeoutError()), true),
      timeoutMs,
    );

    promise.then(
      (value) => finish(() => resolve(value), false),
      (error: unknown) => finish(() => reject(error), false),
    );
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function parseSessionContext(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { access_token?: unknown; user?: { id?: unknown } | null };
  if (
    typeof candidate.access_token !== "string"
    || candidate.access_token.length === 0
    || !candidate.user
    || typeof candidate.user.id !== "string"
    || !USER_ID_PATTERN.test(candidate.user.id)
  ) return null;
  return { userId: candidate.user.id, accessToken: candidate.access_token };
}

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
  const providerOperationTimeoutMs = Number.isFinite(dependencies.providerOperationTimeoutMs)
    && (dependencies.providerOperationTimeoutMs ?? 0) > 0
    ? dependencies.providerOperationTimeoutMs!
    : DEFAULT_PROVIDER_OPERATION_TIMEOUT_MS;
  let authenticationGeneration = 0;
  let activeUserId: string | null = null;
  let refreshInFlight: RefreshOperation | null = null;
  let providerMutationTail = Promise.resolve();
  const supersededRefreshesByUser = new Map<string, number>();

  function enqueueProviderMutation<T>(operation: () => Promise<T>): ProviderMutation<T> {
    const previousMutation = providerMutationTail;
    let releaseMutation!: () => void;
    let cancelled = false;
    let started = false;
    const currentMutation = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    providerMutationTail = previousMutation.then(() => currentMutation);

    const promise = (async () => {
      await previousMutation;
      try {
        if (cancelled) throw staleAuthenticationOperation();
        started = true;
        return await operation();
      } finally {
        releaseMutation();
      }
    })();
    // A logical consumer may time out while the physical operation must keep
    // running. Observe the physical promise permanently to avoid late
    // unhandled rejections without releasing its queue slot early.
    void promise.then(() => undefined, () => undefined);
    return {
      promise,
      cancelIfPending: () => {
        if (!started) cancelled = true;
      },
      hasStarted: () => started,
    };
  }

  function supersedeRefreshInFlight() {
    const operation = refreshInFlight;
    if (!operation || operation.superseded) return;
    operation.superseded = true;
    operation.mutation.cancelIfPending();
    supersededRefreshesByUser.set(
      operation.userId,
      (supersededRefreshesByUser.get(operation.userId) ?? 0) + 1,
    );
    refreshInFlight = null;
  }

  function releaseSupersededRefresh(operation: RefreshOperation) {
    if (!operation.superseded) return;
    const remaining = (supersededRefreshesByUser.get(operation.userId) ?? 1) - 1;
    if (remaining > 0) supersededRefreshesByUser.set(operation.userId, remaining);
    else supersededRefreshesByUser.delete(operation.userId);
  }

  function invalidateAuthenticationContext() {
    supersedeRefreshInFlight();
    authenticationGeneration += 1;
    activeUserId = null;
  }

  function observeSession(value: unknown, forceNewGeneration = false): AuthenticationContext | null {
    const session = parseSessionContext(value);
    if (!session) return null;
    if (
      forceNewGeneration
      || activeUserId !== session.userId
    ) {
      supersedeRefreshInFlight();
      authenticationGeneration += 1;
    }
    activeUserId = session.userId;
    return { ...session, generation: authenticationGeneration };
  }

  function client() {
    try {
      return getClient();
    } catch (error) {
      throw configurationError(error);
    }
  }

  async function sessionContext() {
    let result;
    try {
      result = await client().auth.getSession();
    } catch (error) {
      if (error instanceof BrowserAuthenticationError) throw error;
      throw new BrowserAuthenticationError("AUTH_PROVIDER_UNAVAILABLE", AVAILABILITY_MESSAGE);
    }
    if (result.error) throw new BrowserAuthenticationError("AUTH_PROVIDER_UNAVAILABLE", AVAILABILITY_MESSAGE);
    if (!result.data.session) {
      invalidateAuthenticationContext();
      return null;
    }
    const parsed = parseSessionContext(result.data.session);
    if (!parsed) throw new BrowserAuthenticationError("AUTH_PROVIDER_UNAVAILABLE", AVAILABILITY_MESSAGE);
    if (activeUserId !== null && activeUserId !== parsed.userId) throw staleAuthenticationOperation();
    const context = observeSession(result.data.session);
    if (!context) throw new BrowserAuthenticationError("AUTH_PROVIDER_UNAVAILABLE", AVAILABILITY_MESSAGE);
    return context;
  }

  function isTransientRefreshError(error: unknown) {
    if (!error || typeof error !== "object") return true;
    const candidate = error as { name?: unknown; status?: unknown };
    if (candidate.name === "AuthRetryableFetchError" || candidate.name === "AuthUnknownError") return true;
    return typeof candidate.status !== "number"
      || candidate.status === 408
      || candidate.status === 429
      || candidate.status >= 500;
  }

  function assertCurrentAuthenticationContext(context: AuthenticationContext, signal?: AbortSignal) {
    if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    if (
      activeUserId !== context.userId
      || authenticationGeneration !== context.generation
    ) throw staleAuthenticationOperation();
  }

  async function refreshAccessToken(context: AuthenticationContext, signal?: AbortSignal) {
    if (
      refreshInFlight
      && refreshInFlight.userId === context.userId
      && refreshInFlight.generation === context.generation
    ) return waitForRefreshConsumer(refreshInFlight, signal);
    const mutation = enqueueProviderMutation(async () => {
        assertCurrentAuthenticationContext(context);
        let result;
        try {
          result = await client().auth.refreshSession();
        } catch {
          assertCurrentAuthenticationContext(context);
          throw new BrowserAuthenticationError("AUTH_PROVIDER_UNAVAILABLE", AVAILABILITY_MESSAGE);
        }
        assertCurrentAuthenticationContext(context);
        if (result.error) {
          throw new BrowserAuthenticationError(
            isTransientRefreshError(result.error) ? "AUTH_PROVIDER_UNAVAILABLE" : "AUTH_SESSION_INVALID",
            isTransientRefreshError(result.error) ? AVAILABILITY_MESSAGE : SESSION_MESSAGE,
          );
        }
        const refreshed = parseSessionContext(result.data.session);
        if (!refreshed) throw new BrowserAuthenticationError("AUTH_SESSION_INVALID", SESSION_MESSAGE);
        if (refreshed.userId !== context.userId) throw staleAuthenticationOperation();
        return { ...refreshed, generation: context.generation };
      });
    const operation = {
      userId: context.userId,
      generation: context.generation,
      promise: mutation.promise,
      mutation,
      consumers: 0,
      superseded: false,
    };
    refreshInFlight = operation;
    void mutation.promise.then(() => {
      if (refreshInFlight === operation) refreshInFlight = null;
      releaseSupersededRefresh(operation);
    }, () => {
      if (refreshInFlight === operation) refreshInFlight = null;
      releaseSupersededRefresh(operation);
    });
    return waitForRefreshConsumer(operation, signal);
  }

  async function waitForRefreshConsumer(operation: RefreshOperation, signal?: AbortSignal) {
    operation.consumers += 1;
    try {
      return await waitForLogicalConsumer(
        operation.promise,
        signal,
        providerOperationTimeoutMs,
        () => undefined,
      );
    } finally {
      operation.consumers -= 1;
      if (operation.consumers === 0 && !operation.mutation.hasStarted()) {
        operation.mutation.cancelIfPending();
        if (refreshInFlight === operation) refreshInFlight = null;
      }
    }
  }

  async function authenticatedRequest(
    input: RequestInfo | URL,
    init: RequestInit = {},
    initialContext?: AuthenticationContext,
  ) {
    const context = initialContext ?? await sessionContext();
    if (!context) throw new BrowserAuthenticationError("AUTH_SESSION_INVALID", SESSION_MESSAGE);

    const send = (token: string) => {
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${token}`);
      return request(input, { ...init, headers });
    };
    const response = await send(context.accessToken);
    if (response.status !== 401) return response;

    const refreshedContext = await refreshAccessToken(context, init.signal ?? undefined);
    if (init.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    if (
      activeUserId !== context.userId
      || authenticationGeneration !== context.generation
      || refreshedContext.userId !== context.userId
    ) throw staleAuthenticationOperation();
    const repeatedResponse = await send(refreshedContext.accessToken);
    if (repeatedResponse.status === 401) {
      throw new BrowserAuthenticationError("AUTH_SESSION_INVALID", SESSION_MESSAGE);
    }
    return repeatedResponse;
  }

  async function validateCurrentSession(signal?: AbortSignal): Promise<AuthIdentity | null> {
    const context = await sessionContext();
    if (!context) return null;

    let response: Response;
    try {
      response = await authenticatedRequest("/api/auth/me", { signal }, context);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      if (error instanceof BrowserAuthenticationError) throw error;
      throw new BrowserAuthenticationError("AUTH_PROVIDER_UNAVAILABLE", AVAILABILITY_MESSAGE);
    }
    const body = await readJson(response);
    if (response.status === 403) throw new BrowserAuthenticationError("AUTH_PROVIDER_UNAVAILABLE", AVAILABILITY_MESSAGE);
    if (!response.ok) throw new BrowserAuthenticationError("AUTH_PROVIDER_UNAVAILABLE", AVAILABILITY_MESSAGE);
    const identity = parseIdentity(body);
    if (!identity) throw new BrowserAuthenticationError("AUTH_PROVIDER_UNAVAILABLE", AVAILABILITY_MESSAGE);
    return identity;
  }

  return {
    initialize: validateCurrentSession,
    validateCurrentSession,

    async login(username, password, signal) {
      const loginGeneration = authenticationGeneration;
      const loginUserId = activeUserId;
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
      const setSessionMutation = enqueueProviderMutation(async () => {
        if (signal?.aborted) throw staleAuthenticationOperation();
        if (
          authenticationGeneration !== loginGeneration
          || activeUserId !== loginUserId
        ) throw staleAuthenticationOperation();
        return client().auth.setSession(tokens);
      });
      try {
        setSessionResult = await waitForLogicalConsumer(
          setSessionMutation.promise,
          signal,
          providerOperationTimeoutMs,
          setSessionMutation.cancelIfPending,
        );
      } catch (error) {
        if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
        if (
          authenticationGeneration !== loginGeneration
          || activeUserId !== loginUserId
        ) throw staleAuthenticationOperation();
        if (error instanceof BrowserAuthenticationError) throw error;
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        throw new BrowserAuthenticationError("AUTH_PROVIDER_UNAVAILABLE", AVAILABILITY_MESSAGE);
      }
      if (setSessionResult.error) throw new BrowserAuthenticationError("AUTH_PROVIDER_UNAVAILABLE", AVAILABILITY_MESSAGE);
      const establishedContext = observeSession(setSessionResult.data.session, true);
      if (!establishedContext) throw new BrowserAuthenticationError("AUTH_PROVIDER_UNAVAILABLE", AVAILABILITY_MESSAGE);

      try {
        const identity = await validateCurrentSession(signal);
        if (!identity) throw new BrowserAuthenticationError("AUTH_SESSION_INVALID", SESSION_MESSAGE);
        return identity;
      } catch (error) {
        if (error instanceof BrowserAuthenticationError && error.code === "AUTH_SESSION_INVALID") {
          invalidateAuthenticationContext();
          try {
            await client().auth.signOut({ scope: "local" });
          } catch {
            // Preserve the original controlled error; never expose SDK details.
          }
          throw error;
        }
        if (error instanceof BrowserAuthenticationError) {
          throw new BrowserAuthenticationError(error.code, error.message, true);
        }
        throw error;
      }
    },

    async authenticatedFetch(input, init = {}) {
      return authenticatedRequest(input, init);
    },

    subscribe(listener) {
      let subscription;
      try {
        const result = client().auth.onAuthStateChange((event: AuthChangeEvent, session) => {
          if (["INITIAL_SESSION", "SIGNED_IN", "SIGNED_OUT", "TOKEN_REFRESHED", "PASSWORD_RECOVERY"].includes(event)) {
            if (event === "SIGNED_OUT") invalidateAuthenticationContext();
            const parsedSession = parseSessionContext(session);
            if (
              event === "TOKEN_REFRESHED"
              && parsedSession
              && parsedSession.userId !== activeUserId
              && supersededRefreshesByUser.has(parsedSession.userId)
            ) return;
            if (event === "SIGNED_IN" && parsedSession) observeSession(session, true);
            else if (event === "TOKEN_REFRESHED" && parsedSession) {
              if (activeUserId === null || activeUserId === parsedSession.userId) observeSession(session);
            }
            listener(event as SupportedAuthEvent, parsedSession?.userId ?? null);
          }
        });
        subscription = result.data.subscription;
      } catch (error) {
        throw configurationError(error);
      }
      return () => subscription.unsubscribe();
    },

    async signOutLocal() {
      invalidateAuthenticationContext();
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
