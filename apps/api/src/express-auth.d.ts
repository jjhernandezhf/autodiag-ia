import type { AuthenticatedIdentity } from "./auth-service.js";

declare global {
  namespace Express {
    interface Request {
      usuario?: AuthenticatedIdentity;
    }
  }
}

export {};
