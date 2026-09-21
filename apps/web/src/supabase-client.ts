import { createClient, type SupabaseClient, type SupabaseClientOptions } from "@supabase/supabase-js";

export interface SupabaseBrowserEnvironment {
  VITE_SUPABASE_URL?: unknown;
  VITE_SUPABASE_PUBLISHABLE_KEY?: unknown;
}

export class SupabaseBrowserConfigurationError extends Error {
  readonly code = "SUPABASE_BROWSER_CONFIGURATION_INVALID";

  constructor() {
    super("La configuración pública de autenticación no está disponible o no es válida.");
    this.name = "SupabaseBrowserConfigurationError";
  }
}

export class SupabaseBrowserClientError extends Error {
  readonly code = "SUPABASE_BROWSER_CLIENT_UNAVAILABLE";

  constructor() {
    super("No fue posible preparar el cliente de autenticación de esta pestaña.");
    this.name = "SupabaseBrowserClientError";
  }
}

export function loadSupabaseBrowserConfig(source: SupabaseBrowserEnvironment) {
  const rawUrl = source.VITE_SUPABASE_URL;
  const key = source.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (
    typeof rawUrl !== "string" || rawUrl.length > 2_048 || !/^https?:\/\//u.test(rawUrl) || rawUrl !== rawUrl.trim() ||
    typeof key !== "string" || key.length > 512 || !/^sb_publishable_[A-Za-z0-9_-]{16,}$/u.test(key)
  ) throw new SupabaseBrowserConfigurationError();

  try {
    const url = new URL(rawUrl);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      url.username || url.password || url.search || url.hash || url.pathname !== "/"
    ) throw new SupabaseBrowserConfigurationError();
    return { url: url.origin, publishableKey: key };
  } catch {
    throw new SupabaseBrowserConfigurationError();
  }
}

type ClientFactory = (
  url: string,
  key: string,
  options: SupabaseClientOptions<"public">,
) => SupabaseClient;

interface BrowserClientDependencies {
  readEnvironment?: () => SupabaseBrowserEnvironment;
  getStorage?: () => Storage;
  createClient?: ClientFactory;
}

function getTabStorage(): Storage {
  if (typeof window === "undefined") throw new SupabaseBrowserClientError();
  return window.sessionStorage;
}

function readBrowserEnvironment(): SupabaseBrowserEnvironment {
  return {
    VITE_SUPABASE_URL: import.meta.env.VITE_SUPABASE_URL,
    VITE_SUPABASE_PUBLISHABLE_KEY: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
  };
}

// A provider owns one lazy instance. The application uses only the default
// provider below; injected providers let tests avoid SDK/network initialization.
export function createSupabaseBrowserClientProvider(dependencies: BrowserClientDependencies = {}) {
  let client: SupabaseClient | undefined;
  const factory = dependencies.createClient ?? createClient;

  return (): SupabaseClient => {
    if (client) return client;
    const config = loadSupabaseBrowserConfig((dependencies.readEnvironment ?? readBrowserEnvironment)());
    try {
      const storage = (dependencies.getStorage ?? getTabStorage)();
      client = factory(config.url, config.publishableKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
          storage,
          // Implicit versus PKCE is deliberately deferred to password recovery.
        },
      });
      return client;
    } catch {
      throw new SupabaseBrowserClientError();
    }
  };
}

// No environment read, browser storage access or SDK client at import time.
export const getSupabaseBrowserClient = createSupabaseBrowserClientProvider();
