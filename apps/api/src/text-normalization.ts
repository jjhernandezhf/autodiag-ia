import { createHmac } from "node:crypto";

import type { DtcClassification, DtcStatus } from "./report-types.js";
import { cleanText, normalizeForMatch } from "../../../shared/technical-text.mjs";
export { cleanText, normalizeForMatch } from "../../../shared/technical-text.mjs";

export function nullIfMissing(value: string | undefined) {
  if (value === undefined) return null;
  const cleaned = cleanText(value);
  return cleaned === "" || cleaned === "--" ? null : cleaned;
}

export function normalizeDtcStatus(value: string | null): Exclude<DtcStatus, "multiple_observed"> {
  if (!value) return "unknown";
  const normalized = normalizeForMatch(value);
  if (/^oddtcs?$/u.test(normalized)) return "on_demand";
  if (/^cmdtcs?$/u.test(normalized)) return "continuous_memory";
  if (normalized === "activo / static") return "current";
  if (normalized === "dtc provisional") return "provisional";
  if (["corriente", "actual", "current", "presente"].includes(normalized)) return "current";
  if (/^confirmed\s*\/\s*test\s*failed$/u.test(normalized) || /^confirmed\s*\/\s*testfailed$/u.test(normalized)) {
    return "confirmed";
  }
  if (["almacenado", "guardado", "stored"].includes(normalized)) return "stored";
  if (["pendiente", "pending"].includes(normalized)) return "pending";
  if (["permanente", "permanent", "dtc permanente"].includes(normalized)) return "permanent";
  if (["intermitente", "intermittent"].includes(normalized)) return "intermittent";
  if (["historial", "historico", "history"].includes(normalized)) return "history";
  return "unknown";
}

export function classifyDtcStatus(status: DtcStatus): DtcClassification {
  if (status === "history") return "historical";
  if (status === "unknown") return "unknown";
  return "actionable";
}

export function matchesModuleIdentity(system: { code: string | null; name: string }, dtc: { moduleCode: string | null; moduleName: string }) {
  return system.code === dtc.moduleCode && system.name === dtc.moduleName;
}

export function normalizeVin(value: string) {
  const normalized = cleanText(value).toUpperCase();
  return /^[A-HJ-NPR-Z0-9]{17}$/u.test(normalized) ? normalized : null;
}

export function containsVinCandidate(value: string) {
  return /(?:^|[^\p{L}\p{N}])[A-HJ-NPR-Z0-9]{17}(?=$|[^\p{L}\p{N}])/iu.test(value);
}

export function protectVin(vin: string | null, secret: string) {
  if (!vin) return { vinMasked: null, vinPseudonym: null };
  return {
    vinMasked: `${"*".repeat(13)}${vin.slice(-4)}`,
    vinPseudonym: `vin_v1_${createHmac("sha256", secret).update(vin).digest("hex")}`,
  };
}

export function parseModuleIdentity(value: string) {
  const raw = cleanText(value);
  const openingIndex = raw.indexOf("(");

  if (openingIndex > 0) {
    let depth = 0;
    let closingIndex = -1;
    for (let index = openingIndex; index < raw.length; index += 1) {
      if (raw[index] === "(") depth += 1;
      if (raw[index] === ")") depth -= 1;
      if (depth === 0) {
        closingIndex = index;
        break;
      }
    }

    const codeCandidate = cleanText(raw.slice(0, openingIndex));
    if (closingIndex === raw.length - 1 && /^[\p{L}\p{N}_/'-]+$/u.test(codeCandidate)) {
      return {
        code: codeCandidate.toUpperCase(),
        name: cleanText(raw.slice(openingIndex + 1, closingIndex)),
      };
    }
  }

  const standaloneCode = /^[A-Z0-9_/'-]{2,16}$/u.test(raw) ? raw.toUpperCase() : null;
  return { code: standaloneCode, name: raw };
}
