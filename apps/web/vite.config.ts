import { defineConfig, type UserConfig } from "vite";
import react from "@vitejs/plugin-react";

export function createViteConfig(mode: string): UserConfig {
  return {
    // Unit tests must not load the developer's real apps/web/.env.local.
    envDir: mode === "test" ? false : undefined,
    plugins: [react()],
    server: {
      proxy: {
        "/api": "http://localhost:3000",
      },
    },
  };
}

export default defineConfig(({ mode }) => createViteConfig(mode));
