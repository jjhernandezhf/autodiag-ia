import { describe, expect, it } from "vitest";

import { createViteConfig } from "./vite.config";

describe("configuración de entorno de Vite", () => {
  it("aísla las pruebas de .env.local sin alterar desarrollo", () => {
    expect(createViteConfig("test").envDir).toBe(false);
    expect(createViteConfig("development").envDir).toBeUndefined();
  });
});
