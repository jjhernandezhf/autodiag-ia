import {
  BrowserAuthenticationError,
  type BrowserAuthenticationService,
} from "./auth-service";

export type ApiErrorType =
  | "network"
  | "timeout"
  | "unauthorized"
  | "forbidden"
  | "rate_limited"
  | "server"
  | "invalid_response"
  | "validation"
  | "aborted";

export class ApiRequestError extends Error {
  constructor(
    public readonly type: ApiErrorType,
    message: string,
    public readonly retryable: boolean,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export const API_UNAVAILABLE_MESSAGE =
  "No fue posible comunicarse con el servidor. Tu sesión continúa activa. Puedes reintentar en unos segundos.";

const INVALID_RESPONSE_MESSAGE =
  "El servidor devolvió una respuesta no válida. Tu sesión continúa activa. Puedes reintentar.";
const AUTHENTICATION_MESSAGE = "Tu sesión ya no es válida. Inicia sesión nuevamente.";
const AUTHORIZATION_MESSAGE = "No tienes permiso para realizar esta acción.";
const RATE_LIMIT_MESSAGE = "El servidor está procesando demasiadas solicitudes. Intenta nuevamente en unos segundos.";
const VALIDATION_MESSAGE = "La solicitud no pudo completarse con los datos enviados.";
const DEFAULT_TIMEOUT_MS = 30_000;
const RETRY_DELAY_MS = 150;

interface ApiClientDependencies {
  fetch?: typeof fetch;
}

export interface JsonRequestOptions<T> {
  authenticated?: boolean;
  init?: RequestInit;
  timeoutMs?: number;
  retry?: "none" | "once";
  parse: (value: unknown) => T | null;
  invalidResponseMessage?: string;
  errorMessage?: (value: unknown, status: number) => string | undefined;
}

export interface BrowserApiClient {
  requestJson<T>(input: RequestInfo | URL, options: JsonRequestOptions<T>): Promise<T>;
  checkHealth(signal?: AbortSignal): Promise<void>;
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

function createAbortError() {
  return new DOMException("The operation was aborted.", "AbortError");
}

function classifyStatus(status: number, publicMessage?: string) {
  if (status === 401) return new ApiRequestError("unauthorized", AUTHENTICATION_MESSAGE, false, status);
  if (status === 403) return new ApiRequestError("forbidden", AUTHORIZATION_MESSAGE, false, status);
  if (status === 408 || status === 504) return new ApiRequestError("timeout", API_UNAVAILABLE_MESSAGE, true, status);
  if (status === 429) return new ApiRequestError("rate_limited", publicMessage ?? RATE_LIMIT_MESSAGE, true, status);
  if (status >= 500 && status <= 599) {
    return new ApiRequestError("server", API_UNAVAILABLE_MESSAGE, true, status);
  }
  return new ApiRequestError("validation", publicMessage ?? VALIDATION_MESSAGE, false, status);
}

function classifyThrownError(error: unknown, timedOut: boolean, parentSignal?: AbortSignal) {
  if (parentSignal?.aborted) return new ApiRequestError("aborted", "", false);
  if (timedOut) return new ApiRequestError("timeout", API_UNAVAILABLE_MESSAGE, true);
  if (error instanceof ApiRequestError) return error;
  if (error instanceof BrowserAuthenticationError) {
    return error.code === "AUTH_SESSION_INVALID"
      ? new ApiRequestError("unauthorized", AUTHENTICATION_MESSAGE, false, 401)
      : new ApiRequestError("network", API_UNAVAILABLE_MESSAGE, true);
  }
  if (isAbortError(error)) return new ApiRequestError("aborted", "", false);
  return new ApiRequestError("network", API_UNAVAILABLE_MESSAGE, true);
}

function delay(signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, RETRY_DELAY_MS);
    const abort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      reject(createAbortError());
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export function createBrowserApiClient(
  authenticationService: BrowserAuthenticationService,
  dependencies: ApiClientDependencies = {},
): BrowserApiClient {
  const publicFetch = dependencies.fetch ?? ((input, init) => fetch(input, init));

  async function execute<T>(input: RequestInfo | URL, options: JsonRequestOptions<T>) {
    const init = options.init ?? {};
    const parentSignal = init.signal ?? undefined;
    if (parentSignal?.aborted) throw new ApiRequestError("aborted", "", false);
    const controller = new AbortController();
    let timedOut = false;
    let rejectCancellation!: (reason: ApiRequestError) => void;
    const cancellation = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    const abortFromParent = () => {
      rejectCancellation(new ApiRequestError("aborted", "", false));
      controller.abort(parentSignal?.reason);
    };
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      rejectCancellation(new ApiRequestError("timeout", API_UNAVAILABLE_MESSAGE, true));
      controller.abort();
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    try {
      const operation = (async () => {
        let response: Response;
        try {
          const requestInit = { ...init, signal: controller.signal };
          response = await (options.authenticated !== false
            ? authenticationService.authenticatedFetch(input, requestInit)
            : publicFetch(input, requestInit));
        } catch (error) {
          throw classifyThrownError(error, timedOut, parentSignal);
        }

        let body: unknown;
        try {
          body = await response.json();
        } catch (error) {
          if (timedOut || parentSignal?.aborted) throw classifyThrownError(error, timedOut, parentSignal);
          throw new ApiRequestError("invalid_response", INVALID_RESPONSE_MESSAGE, true, response.status);
        }
        if (!response.ok) {
          throw classifyStatus(response.status, options.errorMessage?.(body, response.status));
        }
        const parsed = options.parse(body);
        if (parsed === null) {
          throw new ApiRequestError(
            "invalid_response",
            options.invalidResponseMessage ?? INVALID_RESPONSE_MESSAGE,
            true,
            response.status,
          );
        }
        return parsed;
      })();
      return await Promise.race([operation, cancellation]);
    } finally {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", abortFromParent);
    }
  }

  async function requestJson<T>(input: RequestInfo | URL, options: JsonRequestOptions<T>): Promise<T> {
    const init = options.init ?? {};
    const parentSignal = init.signal ?? undefined;
    const maxAttempts = options.retry === "once" ? 2 : 1;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        return await execute(input, options);
      } catch (error) {
        const classified = error instanceof ApiRequestError
          ? error
          : classifyThrownError(error, false, parentSignal);
        const mayRetry = attempt === 0
          && maxAttempts === 2
          && (classified.type === "network" || classified.type === "server")
          && !parentSignal?.aborted;
        if (!mayRetry) throw classified;
        try {
          await delay(parentSignal);
        } catch (delayError) {
          throw classifyThrownError(delayError, false, parentSignal);
        }
      }
    }

    throw new ApiRequestError("network", API_UNAVAILABLE_MESSAGE, true);
  }

  return {
    requestJson,
    async checkHealth(signal) {
      await requestJson("/api/health", {
        authenticated: false,
        init: { signal },
        timeoutMs: 5_000,
        retry: "once",
        parse: (value) => (
          value !== null
          && typeof value === "object"
          && Object.keys(value).length === 1
          && (value as { status?: unknown }).status === "ok"
            ? undefined
            : null
        ),
      });
    },
  };
}
