import { realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Express, Request, Response } from "express";

export const COMPILED_WEB_DIRECTORY = fileURLToPath(new URL("../../web/dist/", import.meta.url));
const assetExtensions = new Set([".js", ".css", ".png", ".jpg", ".jpeg", ".svg", ".webp", ".gif", ".ico", ".woff", ".woff2", ".ttf", ".avif"]);

export function serveCompiledWeb(app: Express, directory = COMPILED_WEB_DIRECTORY) {
  let root: string;
  let index: string;
  const confinedFile = (path: string) => {
    const target = realpathSync(resolve(root, path));
    const part = relative(root, target);
    if (!part || part.startsWith("..") || isAbsolute(part) || !statSync(target).isFile()) throw new Error("Invalid web asset");
    return target;
  };
  try {
    root = realpathSync(directory);
    index = confinedFile("index.html");
  } catch {
    // Fail startup rather than expose paths or start an API-only deployment by accident.
    throw new Error("El build web no está disponible. Compila ambos workspaces antes de iniciar producción.");
  }
  app.use((request, response) => {
    response.set("Cache-Control", "no-store");
    const notFound = () => response.status(404).json({ error: { code: "NOT_FOUND", message: "El recurso solicitado no existe." } });
    let path: string;
    try { path = decodeURIComponent(request.path); } catch { notFound(); return; }
    const segments = path.split("/").filter(Boolean);
    if (/^\/api(?:\/|$)/iu.test(path) || !["GET", "HEAD"].includes(request.method) ||
      path.includes("\\") || path.includes("\0") || segments.some((segment) => segment.startsWith(".")) ||
      /^(?:src|apps|node_modules|supabase|docs)$/iu.test(segments[0] ?? "")) {
      notFound(); return;
    }
    const send = (file: string) => response.sendFile(file, { cacheControl: false, dotfiles: "deny" }, (error) => {
      if (error && !response.headersSent && !response.destroyed) notFound();
    });
    if (segments[0] === "assets") {
      if (!assetExtensions.has(extname(path))) { notFound(); return; }
      try { send(confinedFile(path.slice(1))); } catch { notFound(); }
      return;
    }
    if (path === "/" || path === "/index.html" || isNavigation(request, path)) { send(index); return; }
    notFound();
  });
}

function isNavigation(request: Request, path: string) {
  return !extname(path) && /(?:^|,)\s*text\/html(?:\s*;|\s*,|$)/iu.test(request.get("Accept") ?? "") &&
    request.accepts("html") !== false &&
    (!request.get("Sec-Fetch-Mode") || request.get("Sec-Fetch-Mode") === "navigate") &&
    (!request.get("Sec-Fetch-Dest") || request.get("Sec-Fetch-Dest") === "document");
}

export function preventPrivateCaching(_request: Request, response: Response, next: () => void) {
  response.set("Cache-Control", "no-store");
  next();
}
