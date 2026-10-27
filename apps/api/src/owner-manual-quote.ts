// One curated, directly verified short quotation, not general approval of a manual.
// Reviewed against Mazda USA's TPMS page on 2026-10-27 (20 English words).
export const OWNER_QUOTE_STATUS = "quote_verified_demo";
export const OWNER_QUOTE_VERSION = "demonstration_corpus_v2_mazda_tpms_quote";
export const OWNER_QUOTE_PROVENANCE = {
  version: "rag_provenance_v1", origin: "official_documentation", publisher: "Mazda USA",
  documentType: "owner_manual", section: "2019 Mazda3 Owner's Manual — Tire Pressure Monitoring System (TPMS)",
  make: "Mazda", model: "Mazda3", year: 2019, publicationMarket: "USA", vehicleMarket: null,
  applicability: "unknown",
  limitations: "Cita breve verificada el 2026-10-27; admitida solo para demostración experimental. Sin revisión profesional ni licencia verificada. Mercado y equipamiento del vehículo desconocidos. No interpreta DTC ni autoriza reparación. La traducción es propia de AutoDiag, no de Mazda.",
  derivation: "literal",
} as const;
export const OWNER_MANUAL_QUOTE = {
  sourceId: "mazda-usa-2019-tpms-inspection-quote", chunkIndex: 0,
  title: "Mazda3 2019 — TPMS e inspección periódica (cita breve)",
  sourceLabel: "Mazda USA — 2019 Mazda3 Owner's Manual; cita verificada, demostración sin revisión profesional",
  sourceUrl: "https://www.mazdausa.com/static/manuals/2019/mazda3/contents/05120200.html",
  content: 'Cita breve en inglés del manual del propietario Mazda3 2019, sección TPMS: "The TPMS is not a substitute for your own periodic inspection of the tires. Always inspect the tires yourself periodically." Traducción propia de AutoDiag: El TPMS no sustituye la inspección periódica de los neumáticos por parte del propietario. Inspeccione los neumáticos periódicamente. Uso experimental; aplicabilidad al vehículo desconocida. Sin interpretación de DTC ni procedimientos de reparación.',
  metadata: { reviewStatus: OWNER_QUOTE_STATUS, provenance: JSON.stringify(OWNER_QUOTE_PROVENANCE) },
};

// Admission is deliberately limited to this exact reviewed quotation and context.
// It does not admit arbitrary owner/service manuals or the three pending summaries.
export function validateDemoQuoteContent(value: {
  title: string; sourceLabel: string; sourceUrl?: string; content: string; metadata: Record<string, unknown>;
}) {
  if (value.metadata.reviewStatus !== OWNER_QUOTE_STATUS) return;
  if (value.title !== OWNER_MANUAL_QUOTE.title || value.sourceLabel !== OWNER_MANUAL_QUOTE.sourceLabel ||
      value.sourceUrl !== OWNER_MANUAL_QUOTE.sourceUrl || value.content !== OWNER_MANUAL_QUOTE.content ||
      Object.keys(value.metadata).length !== 2 ||
      value.metadata.provenance !== OWNER_MANUAL_QUOTE.metadata.provenance) {
    throw new Error("RAG_DEMO_QUOTE_INVALID");
  }
}
