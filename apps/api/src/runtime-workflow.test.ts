import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

interface PackageManifest {
  scripts?: Record<string, string>;
}

function readManifest(url: URL): PackageManifest {
  return JSON.parse(readFileSync(url, "utf8")) as PackageManifest;
}

describe("flujo local de desarrollo", () => {
  it("carga el entorno raíz en la API y conserva el arranque conjunto e individual", () => {
    const rootManifest = readManifest(new URL("../../../package.json", import.meta.url));
    const apiManifest = readManifest(new URL("../package.json", import.meta.url));
    const webManifest = readManifest(new URL("../../web/package.json", import.meta.url));

    expect(apiManifest.scripts?.dev).toBe("tsx watch --env-file=../../.env src/index.ts");
    expect(webManifest.scripts?.dev).toBe("vite");
    expect(rootManifest.scripts?.dev).toBe(
      "concurrently --kill-others --names web,api --prefix-colors cyan,magenta \"npm run dev --workspace @autodiag/web\" \"npm run dev --workspace @autodiag/api\"",
    );
  });
});
