import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { SupabaseClient } from "@supabase/supabase-js";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSupabaseAdminClientProvider, SupabaseAdminClientError } from "./supabase-admin-client.js";
import { createSupabasePublicClient, SupabasePublicClientError } from "./supabase-public-client.js";
import { SupabaseConfigurationError } from "./supabase-config.js";

const sdk = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("@supabase/supabase-js", () => sdk);

const PUBLIC_KEY = ["sb", "publishable", "synthetic_public_key_for_tests"].join("_");
const SECRET_KEY = ["sb", "secret", "synthetic_private_key_for_tests"].join("_");
const ENVIRONMENT = {
  SUPABASE_URL: "https://synthetic-project.example.test",
  SUPABASE_PUBLISHABLE_KEY: PUBLIC_KEY,
  SUPABASE_SECRET_KEY: SECRET_KEY,
};
const OPTIONS = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
const REPOSITORY_ROOT = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const WEB_SOURCE_ROOT = resolve(REPOSITORY_ROOT, "apps/web/src");
const API_ROOT = resolve(REPOSITORY_ROOT, "apps/api");
const WEB_TSCONFIG = resolve(REPOSITORY_ROOT, "apps/web/tsconfig.json");
const FRONTEND_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"]);
const IGNORED_DIRECTORIES = new Set(["node_modules", "dist", "coverage", ".vite"]);

interface FrontendBoundaryViolation {
  filePath: string;
  specifier: string;
  reason: string;
}

function canonicalPath(filePath: string): string {
  const resolved = resolve(filePath);
  const absolute = ts.sys.realpath && ts.sys.fileExists(resolved) ? ts.sys.realpath(resolved) : resolved;
  return ts.sys.useCaseSensitiveFileNames ? absolute : absolute.toLowerCase();
}

function isWithin(directory: string, candidate: string): boolean {
  const pathFromDirectory = relative(canonicalPath(directory), canonicalPath(candidate));
  return pathFromDirectory === "" ||
    (!pathFromDirectory.startsWith(`..${sep}`) && pathFromDirectory !== ".." && !isAbsolute(pathFromDirectory));
}

function loadWebCompilerOptions(): ts.CompilerOptions {
  const parsed = ts.getParsedCommandLineOfConfigFile(WEB_TSCONFIG, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    },
  });
  if (!parsed) throw new Error("No fue posible cargar la configuración TypeScript del frontend.");
  return parsed.options;
}

function collectFrontendSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const entryPath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) files.push(...collectFrontendSourceFiles(entryPath));
      continue;
    }
    if (entry.isFile() && FRONTEND_EXTENSIONS.has(extname(entry.name))) files.push(entryPath);
  }
  return files;
}

function collectModuleSpecifiers(filePath: string, source: string): string[] {
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
  const specifiers: string[] = [];
  const addStringLiteral = (node: ts.Node | undefined) => {
    if (node && ts.isStringLiteralLike(node)) specifiers.push(node.text);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      addStringLiteral(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      addStringLiteral(node.moduleReference.expression);
    } else if (ts.isCallExpression(node) && node.arguments.length === 1) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (isDynamicImport || isRequire) addStringLiteral(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

function inspectFrontendSource(
  filePath: string,
  source: string,
  compilerOptions: ts.CompilerOptions,
): FrontendBoundaryViolation[] {
  return collectModuleSpecifiers(filePath, source).flatMap((specifier) => {
    if (/^@autodiag\/api(?:\/|$)/u.test(specifier)) {
      return [{ filePath, specifier, reason: "dependencia del workspace @autodiag/api" }];
    }

    const normalizedSpecifier = specifier.replaceAll("\\", "/").split(/[?#]/u, 1)[0] ?? specifier;
    if (/(?:^|\/)supabase-(?:admin-client|config)(?:\.[cm]?[jt]sx?)?$/u.test(normalizedSpecifier)) {
      return [{ filePath, specifier, reason: "módulo privado de Supabase" }];
    }

    const resolvedModule = ts.resolveModuleName(specifier, filePath, compilerOptions, ts.sys).resolvedModule;
    const relativeCandidate = normalizedSpecifier.startsWith(".") || isAbsolute(normalizedSpecifier)
      ? resolve(dirname(filePath), normalizedSpecifier)
      : undefined;
    if (
      (resolvedModule && isWithin(API_ROOT, resolvedModule.resolvedFileName)) ||
      (relativeCandidate && isWithin(API_ROOT, relativeCandidate))
    ) {
      return [{ filePath, specifier, reason: "módulo resuelto dentro de apps/api" }];
    }
    return [];
  });
}

function frontendImport(fromFile: string, backendModule: string): string {
  let specifier = relative(dirname(fromFile), resolve(API_ROOT, "src", backendModule)).replaceAll("\\", "/");
  if (!specifier.startsWith(".")) specifier = `./${specifier}`;
  return specifier;
}

beforeEach(() => {
  sdk.createClient.mockReset();
  sdk.createClient.mockImplementation(() => ({ auth: {} } as unknown as SupabaseClient));
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Red prohibida en pruebas"); }));
});

afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("clientes Supabase backend desconectados", () => {
  it("importa ambos módulos sin credenciales ni creación de clientes", async () => {
    vi.resetModules();
    vi.stubEnv("SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_SECRET_KEY", "");
    vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "");
    const admin = await import("./supabase-admin-client.js");
    const publicModule = await import("./supabase-public-client.js");
    expect(sdk.createClient).not.toHaveBeenCalled();
    expect(() => admin.getSupabaseAdminClient()).toThrow("La configuración de autenticación del servidor no está disponible o no es válida.");
    expect(() => publicModule.createSupabasePublicClient()).toThrow("La configuración de autenticación del servidor no está disponible o no es válida.");
    expect(sdk.createClient).not.toHaveBeenCalled();
  });

  it("reutiliza el administrativo con clave secreta y sesiones desactivadas", () => {
    const readEnvironment = vi.fn(() => ENVIRONMENT);
    const getClient = createSupabaseAdminClientProvider({ readEnvironment });
    expect(readEnvironment).not.toHaveBeenCalled();
    const first = getClient();
    expect(getClient()).toBe(first);
    expect(readEnvironment).toHaveBeenCalledTimes(1);
    expect(sdk.createClient).toHaveBeenCalledTimes(1);
    expect(sdk.createClient).toHaveBeenCalledWith(ENVIRONMENT.SUPABASE_URL, SECRET_KEY, OPTIONS);
    expect(sdk.createClient.mock.calls[0]?.[2].auth).not.toHaveProperty("storage");
  });

  it("crea clientes públicos aislados con clave publicable y sin sesiones", () => {
    const first = createSupabasePublicClient(ENVIRONMENT);
    const second = createSupabasePublicClient(ENVIRONMENT);
    expect(first).not.toBe(second);
    expect(sdk.createClient).toHaveBeenCalledTimes(2);
    expect(sdk.createClient).toHaveBeenNthCalledWith(1, ENVIRONMENT.SUPABASE_URL, PUBLIC_KEY, OPTIONS);
    expect(sdk.createClient).toHaveBeenNthCalledWith(2, ENVIRONMENT.SUPABASE_URL, PUBLIC_KEY, OPTIONS);
    expect(sdk.createClient.mock.calls.every((call) => call[1] !== SECRET_KEY)).toBe(true);
    expect(sdk.createClient.mock.calls.every((call) => !Object.hasOwn(call[2].auth, "storage"))).toBe(true);
  });

  it("rechaza configuraciones ausentes o roles de clave incorrectos antes del SDK", () => {
    const getAdmin = createSupabaseAdminClientProvider({ readEnvironment: () => ({ ...ENVIRONMENT, SUPABASE_SECRET_KEY: PUBLIC_KEY }) });
    expect(() => getAdmin()).toThrow(SupabaseConfigurationError);
    expect(() => createSupabasePublicClient({ ...ENVIRONMENT, SUPABASE_PUBLISHABLE_KEY: SECRET_KEY })).toThrow(SupabaseConfigurationError);
    expect(() => createSupabasePublicClient({})).toThrow(SupabaseConfigurationError);
    expect(sdk.createClient).not.toHaveBeenCalled();
  });

  it("sanitiza errores SDK y no cachea un administrativo fallido", () => {
    sdk.createClient.mockImplementationOnce(() => { throw new Error(`Detalle interno ${SECRET_KEY}`); });
    const getAdmin = createSupabaseAdminClientProvider({ readEnvironment: () => ENVIRONMENT });
    expect(() => getAdmin()).toThrow(SupabaseAdminClientError);
    const client = getAdmin();
    expect(getAdmin()).toBe(client);
    expect(sdk.createClient).toHaveBeenCalledTimes(2);
    sdk.createClient.mockImplementationOnce(() => { throw new Error(`Detalle interno ${PUBLIC_KEY}`); });
    expect(() => createSupabasePublicClient(ENVIRONMENT)).toThrow(SupabasePublicClientError);
  });

  it("permite fábricas inyectadas sin construir el SDK real", () => {
    const factory = vi.fn(() => ({ auth: {} } as unknown as SupabaseClient));
    const getAdmin = createSupabaseAdminClientProvider({ readEnvironment: () => ENVIRONMENT, createClient: factory });
    getAdmin();
    createSupabasePublicClient(ENVIRONMENT, factory);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(sdk.createClient).not.toHaveBeenCalled();
  });

  it("mantiene el administrativo fuera de todo módulo frontend y de los puntos de entrada actuales", () => {
    const compilerOptions = loadWebCompilerOptions();
    const frontendFiles = collectFrontendSourceFiles(WEB_SOURCE_ROOT);
    expect(frontendFiles.map((file) => relative(WEB_SOURCE_ROOT, file))).toEqual(expect.arrayContaining([
      "App.tsx",
      "supabase-client.ts",
    ]));
    const violations = frontendFiles.flatMap((file) => {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/SUPABASE_SECRET_KEY|supabase-admin-client|supabase-config|service_role|sb_secret_/u);
      return inspectFrontendSource(file, source, compilerOptions);
    });
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);

    const webPackage = JSON.parse(readFileSync(resolve(REPOSITORY_ROOT, "apps/web/package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    expect({
      ...webPackage.dependencies,
      ...webPackage.devDependencies,
      ...webPackage.optionalDependencies,
    }).not.toHaveProperty("@autodiag/api");
    for (const file of ["index.ts", "app.ts"]) {
      expect(readFileSync(new URL(file, import.meta.url), "utf8")).not.toMatch(/supabase-(?:admin|public|config)/u);
    }
  });

  it("recorre subdirectorios y omite artefactos generados", () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "autodiag-boundary-"));
    try {
      const nestedDirectory = resolve(temporaryRoot, "auth/session");
      const ignoredDirectory = resolve(temporaryRoot, "dist/generated");
      mkdirSync(nestedDirectory, { recursive: true });
      mkdirSync(ignoredDirectory, { recursive: true });
      const nestedFile = resolve(nestedDirectory, "malicious.tsx");
      const ignoredFile = resolve(ignoredDirectory, "ignored.ts");
      const maliciousSource = `import backend from "${frontendImport(nestedFile, "index.js")}";`;
      writeFileSync(nestedFile, maliciousSource, "utf8");
      writeFileSync(ignoredFile, maliciousSource, "utf8");
      writeFileSync(resolve(temporaryRoot, "not-source.txt"), maliciousSource, "utf8");

      const files = collectFrontendSourceFiles(temporaryRoot);
      expect(files).toEqual([nestedFile]);
      expect(inspectFrontendSource(files[0]!, readFileSync(files[0]!, "utf8"), loadWebCompilerOptions())).toHaveLength(1);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: "import directo desde src",
      file: resolve(WEB_SOURCE_ROOT, "boundary-probe.ts"),
      source: (file: string) => `import { getSupabaseAdminClient } from "${frontendImport(file, "supabase-admin-client.js")}";`,
    },
    {
      name: "import de efecto lateral",
      file: resolve(WEB_SOURCE_ROOT, "boundary-side-effect.ts"),
      source: (file: string) => `import "${frontendImport(file, "index.js")}";`,
    },
    {
      name: "import desde un subdirectorio",
      file: resolve(WEB_SOURCE_ROOT, "auth/boundary-probe.ts"),
      source: (file: string) => `import config from "${frontendImport(file, "private-settings.js")}";`,
    },
    {
      name: "import desde dos niveles de subdirectorios",
      file: resolve(WEB_SOURCE_ROOT, "auth/session/boundary-probe.ts"),
      source: (file: string) => `import server from "${frontendImport(file, "index.js")}";`,
    },
    {
      name: "reexportacion del backend",
      file: resolve(WEB_SOURCE_ROOT, "auth/reexport.ts"),
      source: (file: string) => `export { getSupabaseAdminClient } from "${frontendImport(file, "supabase-admin-client.js")}";`,
    },
    {
      name: "import dinamico literal",
      file: resolve(WEB_SOURCE_ROOT, "features/lazy.ts"),
      source: (file: string) => `const backend = import("${frontendImport(file, "supabase-config.js")}");`,
    },
    {
      name: "require literal",
      file: resolve(WEB_SOURCE_ROOT, "legacy/loader.cts"),
      source: (file: string) => `const backend = require("${frontendImport(file, "supabase-public-client.js")}");`,
    },
    {
      name: "workspace API",
      file: resolve(WEB_SOURCE_ROOT, "auth/client.ts"),
      source: () => "import api from \"@autodiag/api\";",
    },
  ])("rechaza $name", ({ file, source }) => {
    const violations = inspectFrontendSource(file, source(file), loadWebCompilerOptions());
    expect(violations).toHaveLength(1);
  });

  it("rechaza un alias de TypeScript que resuelve dentro de apps/api", () => {
    const file = resolve(WEB_SOURCE_ROOT, "auth/aliased.ts");
    const compilerOptions: ts.CompilerOptions = {
      ...loadWebCompilerOptions(),
      baseUrl: REPOSITORY_ROOT,
      paths: { "@backend/*": ["apps/api/src/*"] },
    };
    const violations = inspectFrontendSource(
      file,
      'import client from "@backend/supabase-public-client.js";',
      compilerOptions,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toContain("apps/api");
  });

  it.each([
    ["React", 'import React from "react";'],
    ["SDK publico", 'import { createClient } from "@supabase/supabase-js";'],
    ["modulo frontend", 'import client from "./supabase-client";'],
    ["estilos y assets", 'import "./styles.css"; import logo from "./assets/logo.png";'],
    ["carpeta api-example", 'import helper from "../../../api-example/src/helper";'],
    ["cadena o comentario", 'const example = "import from apps/api"; // import x from "../../api/src/index"'],
  ])("permite %s", (_name, source) => {
    const file = resolve(WEB_SOURCE_ROOT, "auth/allowed.ts");
    expect(inspectFrontendSource(file, source, loadWebCompilerOptions())).toEqual([]);
  });
});
