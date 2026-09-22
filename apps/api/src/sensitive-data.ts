import type { DiagnosticAnalysisInput } from "./ai-analysis-types.js";
import { containsVinCandidate } from "./text-normalization.js";

export type SensitiveTextContext = "free_text" | "structured_identifier" | "source_text" | "url";

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu;
const PROTECTED_VIN_PATTERN = /(?:vin_v1_[a-z0-9_-]+|\*{13}[A-HJ-NPR-Z0-9]{4})/iu;
const OPENAI_KEY_PATTERN = /\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}\b/u;
const SUPABASE_SECRET_PATTERN = /\bsb_secret_[A-Za-z0-9_-]{12,}\b/u;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/u;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/-]{16,}={0,2}\b/iu;
const PRIVATE_KEY_PATTERN = /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/u;
const PDF_FILENAME_PATTERN = /\b[^\s/\\?#]+\.pdf\b/iu;
const SECRET_ASSIGNMENT_PATTERN = /\b(?:api[_ -]?key|token|secret|password|authorization|contraseña|clave)\b\s*[:=]\s*\S+/iu;
const SENSITIVE_FIELD_NAME_PATTERN = /^(?:api[_ -]?key|token|access[_ -]?token|secret|password|authorization|contraseña|clave)$/iu;
const PHONE_CANDIDATE_PATTERN = /\+?\d(?:[\s().-]*\d){7,14}/gu;
const ISO_DATE_PATTERN = /\b\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])\b/gu;
const TECHNICAL_IDENTIFIER_PATTERN = /\b(?:ECU|PCM|TCM|BCM|ECM|ABS|SRS|PID|CAN)-\d{8,15}\b/giu;
const DISTANCE_MEASUREMENT_PATTERN = /\b\d{1,15}\s*(?:km|mi)\b/giu;

function withoutAllowedNumericTechnicalText(value: string, context: SensitiveTextContext) {
  if (context === "url") return value;
  return value
    .replace(ISO_DATE_PATTERN, " ")
    .replace(TECHNICAL_IDENTIFIER_PATTERN, " ")
    .replace(DISTANCE_MEASUREMENT_PATTERN, " ");
}

function containsPhoneCandidate(value: string) {
  PHONE_CANDIDATE_PATTERN.lastIndex = 0;
  for (const match of value.matchAll(PHONE_CANDIDATE_PATTERN)) {
    const digits = match[0].replace(/\D/gu, "");
    if (digits.length >= 8 && digits.length <= 15) return true;
  }
  return false;
}

export function isSensitiveFieldName(value: string) {
  return SENSITIVE_FIELD_NAME_PATTERN.test(value.trim());
}

export function containsSensitiveText(value: string, context: SensitiveTextContext) {
  return containsVinCandidate(value)
    || EMAIL_PATTERN.test(value)
    || PROTECTED_VIN_PATTERN.test(value)
    || OPENAI_KEY_PATTERN.test(value)
    || SUPABASE_SECRET_PATTERN.test(value)
    || JWT_PATTERN.test(value)
    || BEARER_PATTERN.test(value)
    || PRIVATE_KEY_PATTERN.test(value)
    || (context !== "url" && PDF_FILENAME_PATTERN.test(value))
    || SECRET_ASSIGNMENT_PATTERN.test(value)
    || (context !== "url" && containsPhoneCandidate(withoutAllowedNumericTechnicalText(value, context)));
}

export function containsSensitiveValue(value: unknown, context: SensitiveTextContext): boolean {
  if (typeof value === "string") return containsSensitiveText(value, context);
  if (Array.isArray(value)) return value.some((item) => containsSensitiveValue(item, context));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).some(([key, item]) =>
      isSensitiveFieldName(key) || containsSensitiveValue(item, context)
    );
  }
  return false;
}

export function containsSensitiveDiagnosticReport(
  report: Omit<DiagnosticAnalysisInput, "observations">,
) {
  return containsSensitiveText(report.vehicle.make, "structured_identifier")
    || containsSensitiveText(report.vehicle.model, "structured_identifier")
    || report.modules.some((module) =>
      (module.code !== null && containsSensitiveText(module.code, "structured_identifier"))
      || containsSensitiveText(module.name, "structured_identifier")
      || module.dtcs.some((dtc) =>
        containsSensitiveText(dtc.code, "structured_identifier")
        || containsSensitiveText(dtc.description, "free_text")
      )
    );
}

export function normalizeSafeHttpsUrl(value: string): string | undefined {
  if (value.length > 2_048) return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" || url.username || url.password ||
      containsSensitiveText(url.href, "url")
    ) return undefined;
    for (const [name, parameterValue] of url.searchParams) {
      if (isSensitiveFieldName(name) || containsSensitiveText(parameterValue, "free_text")) return undefined;
    }
    return url.href;
  } catch {
    return undefined;
  }
}
