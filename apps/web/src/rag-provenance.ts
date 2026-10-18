export interface RagProvenance {
  version: "rag_provenance_v1";
  origin: "official_documentation" | "internal_demonstration" | "unverified";
  publisher: string | null;
  documentType: "owner_manual" | "service_manual" | "internal_notes" | "unknown";
  section: string | null;
  make: string | null; model: string | null; year: number | null;
  publicationMarket: string | null;
  vehicleMarket: null;
  applicability: "unknown" | "incompatible";
  limitations: string;
  derivation: "summary" | "literal" | "internal" | "unknown";
}

export function isRagProvenance(value: unknown, sensitive: (text: string) => boolean): value is RagProvenance {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const fields = ["version", "origin", "publisher", "documentType", "section", "make", "model", "year", "publicationMarket", "vehicleMarket", "applicability", "limitations", "derivation"];
  if (Object.keys(item).length !== fields.length || !Object.keys(item).every((key) => fields.includes(key))) return false;
  const text = (key: string, maximum: number) => typeof item[key] === "string" && (item[key] as string).trim().length > 0
    && (item[key] as string).length <= maximum && !sensitive(item[key] as string);
  return item.version === "rag_provenance_v1"
    && ["official_documentation", "internal_demonstration", "unverified"].includes(item.origin as string)
    && ["owner_manual", "service_manual", "internal_notes", "unknown"].includes(item.documentType as string)
    && ["unknown", "incompatible"].includes(item.applicability as string)
    && ["summary", "literal", "internal", "unknown"].includes(item.derivation as string)
    && item.vehicleMarket === null
    && (item.year === null || (Number.isInteger(item.year) && Number(item.year) >= 1886 && Number(item.year) <= 9999))
    && (item.publisher === null || text("publisher", 120)) && (item.section === null || text("section", 200))
    && (item.make === null || text("make", 80)) && (item.model === null || text("model", 120))
    && (item.publicationMarket === null || text("publicationMarket", 80)) && text("limitations", 500);
}

export function describeRagProvenance(item?: RagProvenance): string {
  if (!item) return "Fuente legacy: conservar su atribución original; aplicabilidad no verificada. No autoriza procedimientos específicos.";
  const origin = { official_documentation: "Documentación oficial atribuida, no compatibilidad verificada", internal_demonstration: "Corpus demostrativo interno", unverified: "Procedencia no verificada" }[item.origin];
  return `${origin}. Editor: ${item.publisher ?? "desconocido"}. Documento: ${item.documentType}; sección: ${item.section ?? "desconocida"}. `
    + `Modelo de la fuente: ${item.make ?? "desconocido"} / ${item.model ?? "desconocido"} / ${item.year ?? "desconocido"}. `
    + `Mercado de publicación: ${item.publicationMarket ?? "desconocido"}; mercado del vehículo: desconocido. `
    + `Contenido: ${item.derivation}. Aplicabilidad: ${item.applicability === "incompatible" ? "incompatible, no aplicar" : "desconocida, no autoriza procedimientos específicos"}. Límites: ${item.limitations}`;
}
