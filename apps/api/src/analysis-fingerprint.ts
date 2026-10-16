import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import type { DiagnosticAnalysisInput } from "./ai-analysis-types.js";
import type { AnalysisReasoningEffort } from "./analysis-generation.js";

export const ANALYSIS_PIPELINE_VERSION = "analysis_pipeline_v1";
export const PDF_CONTENT_FINGERPRINT_VERSION = "pdf_v1";
export const ANALYSIS_FINGERPRINT_VERSION = "analysis_v1";

const CONTENT_KEY_DOMAIN = "autodiag-ia/pdf-content-fingerprint/key/v1";
const TOKEN_KEY_DOMAIN = "autodiag-ia/pdf-content-token/key/v1";
const ANALYSIS_KEY_DOMAIN = "autodiag-ia/analysis-fingerprint/key/v1";
const tokenSchema = z.string().regex(/^pdf_v1_[0-9a-f]{64}\.[0-9a-f]{64}$/u);

export class AnalysisFingerprintError extends Error {
  constructor() {
    super("CONTENT_TOKEN_INVALID");
    this.name = "AnalysisFingerprintError";
  }
}

function deriveKey(secret: string, domain: string) {
  return createHmac("sha256", secret).update(domain, "utf8").digest();
}

function hmacHex(key: Buffer, ...parts: Array<string | Buffer>) {
  const hmac = createHmac("sha256", key);
  for (const part of parts) hmac.update(part);
  return hmac.digest("hex");
}

export function createPdfContentToken(pdf: Buffer, secret: string, userId: string) {
  const contentKey = deriveKey(secret, CONTENT_KEY_DOMAIN);
  const tokenKey = deriveKey(secret, TOKEN_KEY_DOMAIN);
  const contentDigest = hmacHex(contentKey, userId, "\0", pdf);
  const contentFingerprint = `${PDF_CONTENT_FINGERPRINT_VERSION}_${contentDigest}`;
  const authenticator = hmacHex(tokenKey, userId, "\0", contentFingerprint);
  return `${contentFingerprint}.${authenticator}`;
}

export function verifyPdfContentToken(token: unknown, secret: string, userId: string) {
  const parsed = tokenSchema.safeParse(token);
  if (!parsed.success) throw new AnalysisFingerprintError();
  const separator = parsed.data.lastIndexOf(".");
  const contentFingerprint = parsed.data.slice(0, separator);
  const received = Buffer.from(parsed.data.slice(separator + 1), "hex");
  const expected = Buffer.from(
    hmacHex(deriveKey(secret, TOKEN_KEY_DOMAIN), userId, "\0", contentFingerprint),
    "hex",
  );
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new AnalysisFingerprintError();
  }
  return contentFingerprint;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function canonicalSerialize(value: unknown) {
  return JSON.stringify(canonicalize(value));
}

export interface AnalysisFingerprintInput {
  contentFingerprint: string;
  input: DiagnosticAnalysisInput;
  extraction: unknown;
  analysisModel: string;
  reasoningEffort?: AnalysisReasoningEffort;
  promptVersion: string;
  outputSchemaVersion: string;
  embeddingModel: string;
  corpusVersion: string;
  rag: {
    enabled: boolean;
    matchCount: number;
    matchThreshold: number;
    maxContextCharacters: number;
  };
  pipelineVersion?: string;
}

export function createAnalysisFingerprint(value: AnalysisFingerprintInput, secret: string) {
  const digest = hmacHex(
    deriveKey(secret, ANALYSIS_KEY_DOMAIN),
    canonicalSerialize({
      ...value,
      pipelineVersion: value.pipelineVersion ?? ANALYSIS_PIPELINE_VERSION,
    }),
  );
  return `${ANALYSIS_FINGERPRINT_VERSION}_${digest}`;
}
