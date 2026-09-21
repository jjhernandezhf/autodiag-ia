import { createClient, type SupabaseClient, type SupabaseClientOptions } from "@supabase/supabase-js";

import { loadSupabasePublicConfig } from "./supabase-config.js";

export class SupabasePublicClientError extends Error {
  readonly code = "SUPABASE_PUBLIC_CLIENT_UNAVAILABLE";

  constructor() {
    super("No fue posible preparar el cliente público de autenticación del servidor.");
    this.name = "SupabasePublicClientError";
  }
}

type ClientFactory = (url: string, key: string, options: SupabaseClientOptions<"public">) => SupabaseClient;

// Each future password attempt must call this factory, never share a client.
export function createSupabasePublicClient(
  source: NodeJS.ProcessEnv = process.env,
  factory: ClientFactory = createClient,
): SupabaseClient {
  const config = loadSupabasePublicConfig(source);
  try {
    return factory(config.url, config.publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  } catch {
    throw new SupabasePublicClientError();
  }
}
