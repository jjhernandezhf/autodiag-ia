import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createAnalysisFingerprint } from "./analysis-fingerprint.js";
import {
  DEMONSTRATION_KNOWLEDGE_CORPUS,
  KNOWLEDGE_CORPUS_VERSION,
  knowledgeChunkSchema,
  validateKnowledgeCorpus,
} from "./knowledge-corpus.js";
import { computeKnowledgeHashes, prepareKnowledgeCorpus } from "./rag-ingest.js";
import { parseStoredProvenance, ragProvenanceSchema } from "./rag-provenance.js";

const sourceUrl = "https://www.mazdausa.com/static/manuals/2019/mazda3/contents/05120200.html";
const provenance = z.object({
  publisher: z.literal("Mazda USA"), documentTitle: z.string().min(1), section: z.string().min(1),
  sourceModel: z.literal("Mazda3"), sourceModelYear: z.literal(2019), publicationMarket: z.literal("USA"),
  originalLanguage: z.literal("en"), summaryLanguage: z.literal("es"), consultedOn: z.literal("2026-10-16"),
  derivation: z.literal("paraphrase_not_manufacturer_literal"),
  reviewStatus: z.literal("pending_technical_review"),
  applicabilityStatus: z.literal("case_market_and_equipment_unverified"),
  scope: z.string().min(10), limitations: z.string().min(10),
}).strict();
const candidatesSchema = z.object({
  schemaVersion: z.literal("knowledge_candidates_v1"),
  candidateSetVersion: z.literal("mazda3_2019_usa_tpms_candidates_v1"),
  status: z.literal("candidate_not_ingested"),
  ingestibleCorpusVersionAtPreparation: z.literal("demonstration_corpus_v1"),
  chunks: z.array(knowledgeChunkSchema.extend({ sourceUrl: z.literal(sourceUrl), metadata: provenance })).length(3),
}).strict();
function readCandidates(): unknown {
  return JSON.parse(readFileSync(new URL("../../../docs/conocimiento-candidato/mazda3-2019-tpms.json", import.meta.url), "utf8"));
}

function readProposal() {
  return z.object({
    status: z.literal("proposal_not_approved_not_ingested"),
    proposedCorpusVersion: z.literal("demonstration_corpus_v2_mazda3_2019_tpms"),
    proposedTotalChunks: z.literal(19),
    experimentalUseAcceptance: z.object({
      acceptedOn: z.literal("2026-10-17"),
      statement: z.literal("Revisé los resúmenes y acepto su uso experimental como información para el propietario."),
      scope: z.string().min(1),
      doesNotEstablish: z.array(z.string()),
      doesNotAuthorize: z.array(z.string()),
    }).strict(),
    admissionDecision: z.literal("pending_requirements"),
    humanTechnicalReview: z.null(),
    usagePermissionReview: z.null(),
    chunks: z.array(knowledgeChunkSchema).length(3),
  }).parse(JSON.parse(readFileSync(new URL("../../../docs/conocimiento-candidato/mazda3-2019-tpms.propuesta.json", import.meta.url), "utf8")));
}

describe("candidatos TPMS: validación local, no ingestión ni medición de recuperación", () => {
  it("registra aceptación experimental sin inventar revisión profesional ni eludir admisión", () => {
    const proposal = readProposal();
    expect(proposal.experimentalUseAcceptance.doesNotEstablish).toEqual([
      "professional_technical_review", "manufacturer_license", "vehicle_compatibility",
    ]);
    expect(proposal.experimentalUseAcceptance.doesNotAuthorize).toEqual(["paid_calls", "external_ingestion"]);
    for (const chunk of proposal.chunks) {
      expect(chunk.metadata.reviewStatus).toBe("pending_technical_review");
      expect(typeof chunk.metadata.provenance).toBe("string");
      const provenance = ragProvenanceSchema.parse(JSON.parse(String(chunk.metadata.provenance)));
      expect(provenance).toMatchObject({ make: "Mazda", model: "Mazda3", year: 2019, publicationMarket: "USA", vehicleMarket: null, applicability: "unknown", documentType: "owner_manual" });
      for (const text of [chunk.content, provenance.limitations]) {
        expect(text).toContain("Uso experimental de información para el propietario");
        expect(text).toContain("sin validación técnica profesional");
        expect(text).toContain("Sin interpretación de DTC ni procedimientos de reparación");
      }
      expect(() => parseStoredProvenance(chunk.metadata, chunk.sourceUrl)).toThrow("RAG_PROVENANCE_INVALID");
    }
    expect(proposal.proposedTotalChunks).toBe(DEMONSTRATION_KNOWLEDGE_CORPUS.length + proposal.chunks.length);
    expect(() => prepareKnowledgeCorpus([...DEMONSTRATION_KNOWLEDGE_CORPUS, ...proposal.chunks])).toThrow("RAG_PROVENANCE_INVALID");
    expect(prepareKnowledgeCorpus(DEMONSTRATION_KNOWLEDGE_CORPUS)).toHaveLength(16);
  });

  it("conserva procedencia y límites, sin atribuir paráfrasis al texto literal del fabricante", () => {
    const candidate = candidatesSchema.parse(readCandidates());
    expect(new Set(candidate.chunks.map((chunk) => `${chunk.sourceId}:${chunk.chunkIndex}`)).size).toBe(3);
    for (const chunk of candidate.chunks) {
      expect(chunk.sourceLabel).toContain("resumen propio");
      expect(chunk.sourceLabel).toContain("aplicabilidad pendiente");
      expect(chunk.content.startsWith("Alcance: manual Mazda USA, Mazda3 2019;")).toBe(true);
      expect(chunk.content).not.toMatch(/C1A(?:56|58|60|62)|MHz|\b(?:315|433)\b/iu);
    }
  });

  it.each(["section", "consultedOn", "applicabilityStatus", "limitations"])("no acepta candidato que omita %s", (field) => {
    const candidate = candidatesSchema.parse(readCandidates());
    const mutated = structuredClone(candidate) as { chunks: Array<{ metadata: Record<string, unknown> }> };
    delete mutated.chunks[0]!.metadata[field];
    expect(() => candidatesSchema.parse(mutated)).toThrow();
  });

  it("rechaza versión o estado que pretendan presentar el candidato como activado", () => {
    const candidate = candidatesSchema.parse(readCandidates());
    expect(() => candidatesSchema.parse({ ...candidate, schemaVersion: "unknown" })).toThrow();
    expect(() => candidatesSchema.parse({ ...candidate, status: "active" })).toThrow();
  });

  it("los candidatos conservan su forma, pero su metadata pendiente impide prepararlos para ingestión", () => {
    const candidate = candidatesSchema.parse(readCandidates());
    const combined = [...DEMONSTRATION_KNOWLEDGE_CORPUS, ...candidate.chunks];
    expect(candidate.chunks.every((chunk) => knowledgeChunkSchema.safeParse(chunk).success)).toBe(true);
    expect(() => validateKnowledgeCorpus(combined)).toThrow("RAG_PROVENANCE_REQUIRED");
    expect(() => prepareKnowledgeCorpus(combined)).toThrow("RAG_PROVENANCE_REQUIRED");
    const first = candidate.chunks[0]!;
    const original = computeKnowledgeHashes(first);
    const changed = computeKnowledgeHashes({ ...first, metadata: { ...first.metadata, section: "Synthetic changed section" } });
    expect(changed.contentHash).toBe(original.contentHash);
    expect(changed.recordHash).not.toBe(original.recordHash);
  });

  it("mantiene el corpus ingerible y su versión; no añade candidatos pendientes al conjunto activo", () => {
    const candidate = candidatesSchema.parse(readCandidates());
    expect(KNOWLEDGE_CORPUS_VERSION).toBe("demonstration_corpus_v1");
    expect(candidate.ingestibleCorpusVersionAtPreparation).toBe(KNOWLEDGE_CORPUS_VERSION);
    expect(candidate.candidateSetVersion).not.toBe(KNOWLEDGE_CORPUS_VERSION);
    expect(DEMONSTRATION_KNOWLEDGE_CORPUS).toHaveLength(16);
    expect(DEMONSTRATION_KNOWLEDGE_CORPUS.some((chunk) => chunk.sourceId === candidate.chunks[0]!.sourceId)).toBe(false);
  });

  it("una futura versión activa distinta separa fingerprints; la preparación no invalida el baseline", () => {
    const base = {
      contentFingerprint: "synthetic-content-reference", input: {
        vehicle: { make: "Marca sintética", model: "Modelo sintético", year: 2024 },
        modules: [{ code: "PCM", name: "Módulo sintético", dtcs: [{ code: "P0300", description: "Fixture", status: "current" as const, alsoHistorical: false }] }],
      }, extraction: {}, analysisModel: "fixture-model", promptVersion: "fixture-prompt", outputSchemaVersion: "fixture-schema",
      embeddingModel: "fixture-embedding", corpusVersion: KNOWLEDGE_CORPUS_VERSION,
      rag: { enabled: true, matchCount: 3, matchThreshold: 0.7, maxContextCharacters: 500 },
    };
    const secret = "synthetic-evaluation-secret-with-32-bytes";
    const before = createAnalysisFingerprint(base, secret);
    expect(createAnalysisFingerprint({ ...base, corpusVersion: readProposal().proposedCorpusVersion }, secret)).not.toBe(before);
    expect(createAnalysisFingerprint({ ...base, corpusVersion: "demonstration_corpus_v1" }, secret)).toBe(before);
    const appSource = readFileSync(new URL("./app.ts", import.meta.url), "utf8");
    expect(appSource).toContain("corpusVersion: KNOWLEDGE_CORPUS_VERSION");
  });
});
