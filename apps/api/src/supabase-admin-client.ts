import { createClient, type SupabaseClient, type SupabaseClientOptions } from "@supabase/supabase-js";

import { loadSupabaseAdminConfig } from "./supabase-config.js";

export class SupabaseAdminClientError extends Error {
  readonly code = "SUPABASE_ADMIN_CLIENT_UNAVAILABLE";

  constructor() {
    super("No fue posible preparar el cliente administrativo de autenticación.");
    this.name = "SupabaseAdminClientError";
  }
}

interface AdminClientDependencies {
  readEnvironment?: () => NodeJS.ProcessEnv;
  createClient?: (url: string, key: string, options: SupabaseClientOptions<"public">) => SupabaseClient;
}

export function createSupabaseAdminClientProvider(dependencies: AdminClientDependencies = {}) {
  let client: SupabaseClient | undefined;
  const factory = dependencies.createClient ?? createClient;
  return (): SupabaseClient => {
    if (client) return client;
    const config = loadSupabaseAdminConfig((dependencies.readEnvironment ?? (() => process.env))());
    try {
      client = factory(config.url, config.secretKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });
      return client;
    } catch {
      throw new SupabaseAdminClientError();
    }
  };
}

// Server-only administrative access, never a per-user/session client.
// No client, credential read or operation is performed during import.
export const getSupabaseAdminClient = createSupabaseAdminClientProvider();
