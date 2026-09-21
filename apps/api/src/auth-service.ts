import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { getSupabaseAdminClient } from "./supabase-admin-client.js";
import { SupabaseConfigurationError } from "./supabase-config.js";
import { createSupabasePublicClient } from "./supabase-public-client.js";

const usernameSchema = z.string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(64)
  .regex(/^[a-z][a-z0-9]*([._-][a-z0-9]+)*$/u);

const passwordSchema = z.string().min(1).max(256);
const loginRequestEnvelopeSchema = z.object({
  nombre_usuario: z.string(),
  password: passwordSchema,
}).strict();
export const loginRequestSchema = loginRequestEnvelopeSchema.extend({ nombre_usuario: usernameSchema });

const profileSchema = z.object({
  id: z.string().uuid(),
  username: usernameSchema,
  is_active: z.boolean(),
}).strict();

export interface AuthenticatedIdentity {
  id: string;
  username: string;
}

export interface LoginTokens {
  access_token: string;
  refresh_token: string;
}

export type AuthenticationErrorCode =
  | "AUTH_REQUEST_INVALID"
  | "AUTH_CREDENTIALS_INVALID"
  | "AUTH_SESSION_INVALID"
  | "AUTH_PROFILE_FORBIDDEN"
  | "AUTH_CONFIGURATION_UNAVAILABLE"
  | "AUTH_PROVIDER_UNAVAILABLE";

export class AuthenticationError extends Error {
  constructor(
    public readonly code: AuthenticationErrorCode,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "AuthenticationError";
  }
}

export interface AuthenticationService {
  login(input: unknown): Promise<LoginTokens>;
  authenticate(accessToken: string): Promise<AuthenticatedIdentity>;
}

interface AuthenticationDependencies {
  getAdminClient?: () => SupabaseClient;
  createPublicClient?: () => SupabaseClient;
}

const INVALID_CREDENTIALS_MESSAGE = "Usuario o contraseña incorrectos.";
const INVALID_SESSION_MESSAGE = "La sesión no es válida.";
const PROFILE_FORBIDDEN_MESSAGE = "El usuario no tiene acceso autorizado.";
const PROVIDER_UNAVAILABLE_MESSAGE = "El servicio de autenticación no está disponible temporalmente.";
const CONFIGURATION_UNAVAILABLE_MESSAGE = "El acceso seguro no está configurado en este entorno.";
const DUMMY_AUTH_USER_ID = "00000000-0000-4000-8000-000000000000";
const DUMMY_AUTH_EMAIL = "autodiag-unavailable-user@example.invalid";

function unavailableError(error: unknown) {
  return error instanceof SupabaseConfigurationError
    ? new AuthenticationError("AUTH_CONFIGURATION_UNAVAILABLE", CONFIGURATION_UNAVAILABLE_MESSAGE, 503)
    : new AuthenticationError("AUTH_PROVIDER_UNAVAILABLE", PROVIDER_UNAVAILABLE_MESSAGE, 503);
}

function hasExpectedAuthFailureStatus(error: unknown) {
  if (!error || typeof error !== "object" || !("status" in error)) return false;
  const status = (error as { status?: unknown }).status;
  return status === 400 || status === 401 || status === 403 || status === 404;
}

function parseProfile(value: unknown) {
  const parsed = profileSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function createAuthenticationService(
  dependencies: AuthenticationDependencies = {},
): AuthenticationService {
  const getAdminClient = dependencies.getAdminClient ?? getSupabaseAdminClient;
  const createPublicClient = dependencies.createPublicClient ?? (() => createSupabasePublicClient());

  return {
    async login(input) {
      const parsedInput = loginRequestEnvelopeSchema.safeParse(input);
      if (!parsedInput.success) {
        throw new AuthenticationError(
          "AUTH_REQUEST_INVALID",
          "La solicitud de inicio de sesión no es válida.",
          400,
        );
      }
      const parsedUsername = usernameSchema.safeParse(parsedInput.data.nombre_usuario);
      if (!parsedUsername.success) {
        throw new AuthenticationError("AUTH_CREDENTIALS_INVALID", INVALID_CREDENTIALS_MESSAGE, 401);
      }

      let adminClient: SupabaseClient;
      try {
        adminClient = getAdminClient();
      } catch (error) {
        throw unavailableError(error);
      }

      let profileResult: Awaited<ReturnType<ReturnType<ReturnType<typeof adminClient.from>["select"]>["maybeSingle"]>>;
      try {
        profileResult = await adminClient
          .from("profiles")
          .select("id, username, is_active")
          .eq("username", parsedUsername.data)
          .maybeSingle();
      } catch {
        throw new AuthenticationError("AUTH_PROVIDER_UNAVAILABLE", PROVIDER_UNAVAILABLE_MESSAGE, 503);
      }

      if (profileResult.error) {
        throw new AuthenticationError("AUTH_PROVIDER_UNAVAILABLE", PROVIDER_UNAVAILABLE_MESSAGE, 503);
      }
      const profile = parseProfile(profileResult.data);
      const hasActiveProfile = profile?.is_active === true;

      let authUserResult;
      try {
        authUserResult = await adminClient.auth.admin.getUserById(
          hasActiveProfile ? profile.id : DUMMY_AUTH_USER_ID,
        );
      } catch {
        throw new AuthenticationError("AUTH_PROVIDER_UNAVAILABLE", PROVIDER_UNAVAILABLE_MESSAGE, 503);
      }
      if (authUserResult.error && !hasExpectedAuthFailureStatus(authUserResult.error)) {
        throw new AuthenticationError("AUTH_PROVIDER_UNAVAILABLE", PROVIDER_UNAVAILABLE_MESSAGE, 503);
      }
      const resolvedEmail = authUserResult.error ? null : authUserResult.data.user?.email;
      const hasUsableAuthUser = hasActiveProfile && typeof resolvedEmail === "string" && resolvedEmail.length > 0;
      const email = hasUsableAuthUser ? resolvedEmail : DUMMY_AUTH_EMAIL;

      let publicClient: SupabaseClient;
      try {
        publicClient = createPublicClient();
      } catch (error) {
        throw unavailableError(error);
      }

      let signInResult;
      try {
        signInResult = await publicClient.auth.signInWithPassword({
          email,
          password: parsedInput.data.password,
        });
      } catch {
        throw new AuthenticationError("AUTH_PROVIDER_UNAVAILABLE", PROVIDER_UNAVAILABLE_MESSAGE, 503);
      }
      if (signInResult.error && !hasExpectedAuthFailureStatus(signInResult.error)) {
        throw new AuthenticationError("AUTH_PROVIDER_UNAVAILABLE", PROVIDER_UNAVAILABLE_MESSAGE, 503);
      }
      if (!hasUsableAuthUser || signInResult.error) {
        throw new AuthenticationError("AUTH_CREDENTIALS_INVALID", INVALID_CREDENTIALS_MESSAGE, 401);
      }

      const accessToken = signInResult.data.session?.access_token;
      const refreshToken = signInResult.data.session?.refresh_token;
      if (typeof accessToken !== "string" || !accessToken || typeof refreshToken !== "string" || !refreshToken) {
        throw new AuthenticationError("AUTH_PROVIDER_UNAVAILABLE", PROVIDER_UNAVAILABLE_MESSAGE, 503);
      }
      return { access_token: accessToken, refresh_token: refreshToken };
    },

    async authenticate(accessToken) {
      let adminClient: SupabaseClient;
      try {
        adminClient = getAdminClient();
      } catch (error) {
        throw unavailableError(error);
      }

      let userResult;
      try {
        userResult = await adminClient.auth.getUser(accessToken);
      } catch {
        throw new AuthenticationError("AUTH_PROVIDER_UNAVAILABLE", PROVIDER_UNAVAILABLE_MESSAGE, 503);
      }
      if (userResult.error || !userResult.data.user) {
        if (!userResult.error || hasExpectedAuthFailureStatus(userResult.error)) {
          throw new AuthenticationError("AUTH_SESSION_INVALID", INVALID_SESSION_MESSAGE, 401);
        }
        throw new AuthenticationError("AUTH_PROVIDER_UNAVAILABLE", PROVIDER_UNAVAILABLE_MESSAGE, 503);
      }

      let profileResult;
      try {
        profileResult = await adminClient
          .from("profiles")
          .select("id, username, is_active")
          .eq("id", userResult.data.user.id)
          .maybeSingle();
      } catch {
        throw new AuthenticationError("AUTH_PROVIDER_UNAVAILABLE", PROVIDER_UNAVAILABLE_MESSAGE, 503);
      }
      if (profileResult.error) {
        throw new AuthenticationError("AUTH_PROVIDER_UNAVAILABLE", PROVIDER_UNAVAILABLE_MESSAGE, 503);
      }
      const profile = parseProfile(profileResult.data);
      if (!profile || !profile.is_active || profile.id !== userResult.data.user.id) {
        throw new AuthenticationError("AUTH_PROFILE_FORBIDDEN", PROFILE_FORBIDDEN_MESSAGE, 403);
      }

      return { id: profile.id, username: profile.username };
    },
  };
}
