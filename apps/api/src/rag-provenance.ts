import { z } from "zod";
import { containsSensitiveValue, normalizeSafeHttpsUrl } from "./sensitive-data.js";

const bounded = (max: number) => z.string().trim().min(1).max(max);
export const ragProvenanceSchema = z.object({
  version: z.literal("rag_provenance_v1"),
  origin: z.enum(["official_documentation", "internal_demonstration", "unverified"]),
  publisher: bounded(120).nullable(),
  documentType: z.enum(["owner_manual", "service_manual", "internal_notes", "unknown"]),
  section: bounded(200).nullable(),
  make: bounded(80).nullable(), model: bounded(120).nullable(), year: z.number().int().min(1886).max(9999).nullable(),
  publicationMarket: bounded(80).nullable(),
  vehicleMarket: z.null(),
  applicability: z.enum(["unknown", "incompatible"]),
  limitations: bounded(500),
  derivation: z.enum(["summary", "literal", "internal", "unknown"]),
}).strict().refine((value) => !containsSensitiveValue(value, "source_text"), "Sensitive provenance");
export type RagProvenance = z.infer<typeof ragProvenanceSchema>;

// Scope must have a single representation. Even null flat fields indicate a
// partial/mixed format, not a legacy source without provenance.
const FLAT_PROVENANCE_FIELDS = [
  ...Object.keys(ragProvenanceSchema.shape),
  "documentTitle", "sourceMake", "sourceModel", "sourceModelYear",
  "originalLanguage", "summaryLanguage", "consultedOn", "applicabilityStatus", "scope",
];

// JSON text inside the existing flat metadata JSONB; no migration.
export function parseStoredProvenance(metadata: Record<string, unknown>, url?: string): RagProvenance | undefined {
  const hasProvenance = Object.hasOwn(metadata, "provenance");
  if (FLAT_PROVENANCE_FIELDS.some((key) => Object.hasOwn(metadata, key))) {
    throw new Error(hasProvenance ? "RAG_PROVENANCE_MIXED" : "RAG_PROVENANCE_REQUIRED");
  }
  if (!hasProvenance) {
    if (Object.hasOwn(metadata, "reviewStatus")) {
      throw new Error("RAG_PROVENANCE_REQUIRED");
    }
    return undefined;
  }
  if (metadata.reviewStatus !== "approved" || typeof metadata.provenance !== "string" || metadata.provenance.length > 2200) {
    throw new Error("RAG_PROVENANCE_INVALID");
  }
  const parsed = ragProvenanceSchema.parse(JSON.parse(metadata.provenance));
  if (parsed.origin === "official_documentation" && (!parsed.publisher || !url || !normalizeSafeHttpsUrl(url))) {
    throw new Error("RAG_PROVENANCE_INVALID");
  }
  return parsed;
}

export function incompatibleWithVehicle(source: RagProvenance, vehicle: { make: string; model: string; year: number }) {
  const same = (a: string, b: string) => a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();
  return source.applicability === "incompatible"
    || (source.make !== null && !same(source.make, vehicle.make))
    || (source.model !== null && !same(source.model, vehicle.model))
    || (source.year !== null && source.year !== vehicle.year);
}
