import { z } from "zod";

export class SupabaseConfigurationError extends Error {
  readonly code = "SUPABASE_CONFIGURATION_INVALID";

  constructor() {
    super("La configuración de autenticación del servidor no está disponible o no es válida.");
    this.name = "SupabaseConfigurationError";
  }
}

const baseUrlSchema = z.string().max(2_048).refine((value) => {
  if (value !== value.trim() || !/^https?:\/\//u.test(value)) return false;
  try {
    const url = new URL(value);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return (url.protocol === "https:" || (url.protocol === "http:" && loopback)) &&
      !url.username && !url.password && !url.search && !url.hash && url.pathname === "/";
  } catch {
    return false;
  }
}).transform((value) => new URL(value).origin);

const adminConfigSchema = z.object({
  url: baseUrlSchema,
  secretKey: z.string().max(512).regex(/^sb_secret_[A-Za-z0-9_-]{16,}$/u),
}).strict();

const publicConfigSchema = z.object({
  url: baseUrlSchema,
  publishableKey: z.string().max(512).regex(/^sb_publishable_[A-Za-z0-9_-]{16,}$/u),
}).strict();

export type SupabaseAdminConfig = z.infer<typeof adminConfigSchema>;
export type SupabasePublicConfig = z.infer<typeof publicConfigSchema>;

// Independent, on-demand contracts: existing API startup needs no Supabase keys.
// Never propagate Zod issues, rejected values or the environment object.
export function loadSupabaseAdminConfig(source: NodeJS.ProcessEnv = process.env): SupabaseAdminConfig {
  const result = adminConfigSchema.safeParse({ url: source.SUPABASE_URL, secretKey: source.SUPABASE_SECRET_KEY });
  if (!result.success) throw new SupabaseConfigurationError();
  return result.data;
}

export function loadSupabasePublicConfig(source: NodeJS.ProcessEnv = process.env): SupabasePublicConfig {
  const result = publicConfigSchema.safeParse({ url: source.SUPABASE_URL, publishableKey: source.SUPABASE_PUBLISHABLE_KEY });
  if (!result.success) throw new SupabaseConfigurationError();
  return result.data;
}
