import { describe, expect, it } from "vitest";

import { loadEnv } from "./config.js";
import { createConfiguredRagService } from "./rag-runtime.js";

describe("activación RAG", () => {
  it("no crea clientes ni embeddings cuando RAG está desactivado", () => {
    const env = loadEnv({
      VIN_HMAC_SECRET: "synthetic-config-secret-with-32-bytes",
      OPENAI_API_KEY: "synthetic-key-never-used",
      RAG_ENABLED: "false",
    });
    expect(createConfiguredRagService(env)).toBeUndefined();
  });
});
