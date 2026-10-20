import { isIP } from "node:net";
import type { RequestHandler } from "express";

const MAX_PROXY_IPS = 32;
const MAX_FORWARDED_ADDRESSES = 32; // Resource bound, not an assumed provider topology.
function validIp(value: string) {
  return value.length <= 64 && !value.includes("%") && isIP(value) !== 0;
}

function normalizeIp(ip: string) {
  if (isIP(ip) === 4) return ip;
  const ipv6 = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/u.exec(ipv6);
  if (!mapped) return ipv6;
  const high = Number.parseInt(mapped[1]!, 16), low = Number.parseInt(mapped[2]!, 16);
  return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
}

export function resolveTrustedProxyIps(input: unknown = undefined): string[] {
  if (input === undefined || (typeof input === "string" && !input.trim())) return [];
  const entries = typeof input === "string" && input.length <= 2048 ? input.split(",") : input;
  if (!Array.isArray(entries) || entries.length > MAX_PROXY_IPS ||
    entries.some((ip: unknown) => typeof ip !== "string" || !validIp(ip.trim()))) {
    throw new Error("TRUSTED_PROXY_IPS debe contener como máximo 32 IP exactas IPv4/IPv6, sin CIDR, nombres ni saltos.");
  }
  return [...new Set((entries as string[]).map(ip => normalizeIp(ip.trim())))];
}

// Express owns chain traversal and mapped IPv4 handling. No custom rate-limit key.
export const validateLoginProxyChain: RequestHandler = (request, response, next) => {
  const trust = request.app.get("trust proxy fn") as (ip: string, hop: number) => boolean;
  const peer = request.socket.remoteAddress;
  if (!peer || !trust(peer, 0)) { next(); return; }
  const raw = request.headers["x-forwarded-for"];
  const addresses = typeof raw === "string" && raw.length <= 2048 ? raw.split(",").map(ip => ip.trim()) : [];
  const invalid = () => response.status(400).json({ error: { code: "AUTH_REQUEST_INVALID", message: "La cadena de proxy de inicio de sesión no es válida." } });
  if (!addresses.length || addresses.length > MAX_FORWARDED_ADDRESSES || addresses.some(ip => !validIp(ip))) {
    invalid(); return;
  }
  // Normalize equivalent mapped IPv4 forms before Express resolves req.ip. Keep
  // its right-to-left trust traversal and the limiter's default key/validations.
  request.headers["x-forwarded-for"] = addresses.map(normalizeIp).join(", ");
  if (!request.ip || !validIp(request.ip) || trust(request.ip, 0)) {
    invalid();
    return;
  }
  next();
};
