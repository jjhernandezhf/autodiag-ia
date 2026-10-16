import { describe, expect, it, vi } from "vitest";

import {
  buildHistoryInsertRecord,
  DiagnosticHistoryError,
  DiagnosticHistoryService,
  MAX_HISTORY_PAGE_SIZE,
  parseHistoryListQuery,
  type DiagnosticHistoryRepository,
  type HistoryCaptureContext,
  type HistorySaveInput,
} from "./diagnostic-history.js";
import type { DiagnosticAnalysisInput, DiagnosticAnalysisOutput } from "./ai-analysis-types.js";
import type { RagMetadata } from "./rag-types.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const REPORT_ID = "22222222-2222-4222-8222-222222222222";
const HISTORY_ID = "33333333-3333-4333-8333-333333333333";
const SOURCE_ID = "44444444-4444-4444-8444-444444444444";

const input: DiagnosticAnalysisInput = {
  vehicle: { make: "Marca", model: "Modelo", year: 2025 },
  modules: [{
    code: "PCM",
    name: "Módulo motriz",
    dtcs: [{ code: "P0300", description: "Fallo de encendido sintético", status: "current", alsoHistorical: false }],
  }],
  observations: "Vibración al acelerar.",
};

const analysis: DiagnosticAnalysisOutput = {
  technicalSummary: "Se requiere comprobar el sistema de encendido.",
  findings: [{
    relatedDtc: { code: "P0300", moduleCode: "PCM", moduleName: "Módulo motriz" },
    priority: "high",
    simpleExplanation: "El DTC requiere comprobaciones profesionales.",
    possibleCauses: ["Conexión eléctrica deficiente"],
    recommendedChecks: ["Comprobar alimentación y señal"],
    safetyWarnings: ["Trabajar con el vehículo inmovilizado"],
    confidence: "medium",
  }],
  observationCorrelation: {
    status: "matches_found",
    summary: "La observación podría relacionarse con el DTC.",
    matches: [{
      relatedDtc: { code: "P0300", moduleCode: "PCM", moduleName: "Módulo motriz" },
      observation: "Vibración al acelerar.",
      possibleRelation: "Puede guardar relación sin confirmar causalidad.",
      confidence: "low",
    }],
  },
  safetyWarnings: ["Confirmar el diagnóstico antes de sustituir componentes"],
  confidence: "medium",
  requiresTechnicianConfirmation: true,
};

const rag: RagMetadata = {
  enabled: true,
  used: true,
  status: "used",
  querySummary: "Consulta técnica sintética para P0300.",
  sources: [{
    id: SOURCE_ID,
    title: "Comprobación de encendido",
    label: "Fuente técnica sintética",
    url: "https://example.com/manual.pdf",
    similarity: 0.88,
    excerpt: "Comprobar alimentación, conexión y señal antes de sustituir componentes.",
  }],
};

function context(): HistoryCaptureContext {
  return {
    reportReference: REPORT_ID,
    extraction: {
      status: "completed",
      format: "autel_vehicle_diagnostic_report",
      requiresManualReview: false,
      vehicle: {
        year: 2025,
        make: "Marca",
        model: "Modelo",
        engine: "Motor sintético",
        odometer: { value: 123_456, unit: "km" },
        vinMasked: "*************6789",
        vinPseudonym: `vin_v1_${"a".repeat(64)}`,
      },
      scanSummary: { declaredSystems: 1, parsedSystems: 1, declaredDtcs: 1, parsedDtcs: 1 },
      systems: [{ code: "PCM", name: "Módulo motriz", dtcCount: 1 }],
      dtcs: [{
        code: "P0300",
        moduleCode: "PCM",
        moduleName: "Módulo motriz",
        status: "current",
        statusOriginal: "Actual",
        classification: "actionable",
        descriptionOriginal: "Fallo de encendido sintético",
      }],
      warnings: [],
    },
  };
}

function saveInput(overrides: Partial<HistorySaveInput> = {}): HistorySaveInput {
  return {
    context: context(),
    input,
    analysis,
    rag,
    analysisModel: "synthetic-analysis-model",
    embeddingModel: "text-embedding-3-small",
    ...overrides,
  };
}

function storedRow(id = HISTORY_ID) {
  const record = buildHistoryInsertRecord(saveInput());
  return {
    id,
    created_at: "2026-10-04T12:00:00.000Z",
    report_reference: record.reportReference,
    make: record.make,
    model: record.model,
    year: record.year,
    odometer_value: record.odometer?.value ?? null,
    odometer_unit: record.odometer?.unit ?? null,
    dtc_count: record.dtcCodes.length,
    rag_status: record.ragStatus,
    extraction_snapshot: record.extractionSnapshot,
    analysis_snapshot: record.analysisSnapshot,
    rag_snapshot: record.ragSnapshot,
    analysis_model: record.analysisModel,
    embedding_model: record.embeddingModel,
    schema_version: 1,
  };
}

function storedListRow() {
  const row = storedRow();
  return {
    id: row.id,
    created_at: row.created_at,
    report_reference: row.report_reference,
    make: row.make,
    model: row.model,
    year: row.year,
    odometer_value: row.odometer_value,
    odometer_unit: row.odometer_unit,
    dtc_count: row.dtc_count,
    rag_status: row.rag_status,
  };
}

describe("historial de diagnósticos", () => {
  it("construye únicamente snapshots permitidos y conserva VIN protegido", () => {
    const record = buildHistoryInsertRecord(saveInput());
    expect(record.vinHmac).toBe(`vin_v1_${"a".repeat(64)}`);
    expect(record.vinLast4).toBe("6789");
    expect(record.extractionSnapshot.vehicle).toMatchObject({ vinMasked: "*************6789", vinPseudonym: null });
    expect(record.ragSnapshot).toEqual(rag);
    expect(record.analysisSnapshot.output).toEqual(analysis);
    expect(JSON.stringify(record)).not.toMatch(/originalName|filename|sha256|rawText|access_token|refresh_token|authorization/iu);
  });

  it("descarta fuentes RAG contaminadas antes de persistir", () => {
    const contaminated = {
      ...rag,
      sources: [{ ...rag.sources[0]!, excerpt: "Contacto 55551234" }],
    };
    const record = buildHistoryInsertRecord(saveInput({ rag: contaminated }));
    expect(record.ragSnapshot).toMatchObject({ status: "unavailable", used: false, sources: [] });
    expect(JSON.stringify(record)).not.toContain("55551234");
  });

  it("conserva una fuente HTTPS segura y normaliza su URL", () => {
    const withCanonicalizableUrl = {
      ...rag,
      sources: [{ ...rag.sources[0]!, url: "https://example.com" }],
    };
    const record = buildHistoryInsertRecord(saveInput({ rag: withCanonicalizableUrl }));
    expect(record.ragSnapshot.sources).toHaveLength(1);
    expect(record.ragSnapshot.sources[0]!.url).toBe("https://example.com/");
  });

  it("rechaza contenido sensible fuera de los campos VIN protegidos", () => {
    const contaminated = context();
    contaminated.extraction.dtcs[0]!.descriptionOriginal = "Correo cliente@example.test";
    expect(() => buildHistoryInsertRecord(saveInput({ context: contaminated }))).toThrow(DiagnosticHistoryError);
  });

  it("exige el modelo de embeddings cuando la evidencia RAG fue utilizada", () => {
    expect(() => buildHistoryInsertRecord(saveInput({ embeddingModel: null }))).toThrow(DiagnosticHistoryError);
  });

  it("limita y valida la paginación estable", () => {
    expect(parseHistoryListQuery({})).toEqual({ limit: 20, cursor: undefined });
    expect(parseHistoryListQuery({ limit: String(MAX_HISTORY_PAGE_SIZE) }).limit).toBe(MAX_HISTORY_PAGE_SIZE);
    expect(() => parseHistoryListQuery({ limit: String(MAX_HISTORY_PAGE_SIZE + 1) })).toThrow(DiagnosticHistoryError);
    expect(() => parseHistoryListQuery({ limit: "2", user_id: USER_ID })).toThrow(DiagnosticHistoryError);
  });

  it("siempre entrega user_id al repositorio desde el argumento del servicio", async () => {
    const insert = vi.fn(async () => ({ id: HISTORY_ID }));
    const repository: DiagnosticHistoryRepository = {
      insert,
      list: vi.fn(async () => ({ rows: [], hasMore: false })),
      findById: vi.fn(async () => null),
    };
    const service = new DiagnosticHistoryService(repository);
    await expect(service.save(USER_ID, saveInput())).resolves.toEqual({ id: HISTORY_ID, reused: false });
    expect(insert).toHaveBeenCalledOnce();
    expect(insert.mock.calls[0]![0]).toBe(USER_ID);
  });

  it("rechaza user_id dentro del snapshot antes de alcanzar el repositorio", async () => {
    const insert = vi.fn(async () => ({ id: HISTORY_ID }));
    const repository: DiagnosticHistoryRepository = {
      insert,
      list: vi.fn(async () => ({ rows: [], hasMore: false })),
      findById: vi.fn(async () => null),
    };
    const service = new DiagnosticHistoryService(repository);
    const maliciousContext = context() as HistoryCaptureContext & { user_id: string };
    maliciousContext.user_id = "22222222-2222-4222-8222-222222222222";

    await expect(service.save(USER_ID, saveInput({ context: maliciousContext }))).rejects.toMatchObject({
      code: "HISTORY_DATA_INVALID",
    });
    expect(insert).not.toHaveBeenCalled();
  });

  it("valida filas recuperadas antes de devolverlas", async () => {
    const repository: DiagnosticHistoryRepository = {
      insert: vi.fn(async () => ({ id: HISTORY_ID })),
      list: vi.fn(async () => ({ rows: [{ ...storedListRow(), make: "Contacto 55551234" }], hasMore: false })),
      findById: vi.fn(async () => ({ ...storedRow(), analysis_snapshot: { invalid: true } })),
    };
    const service = new DiagnosticHistoryService(repository);
    await expect(service.list(USER_ID, parseHistoryListQuery({}))).rejects.toMatchObject({ code: "HISTORY_DATA_INVALID" });
    await expect(service.get(USER_ID, HISTORY_ID)).rejects.toMatchObject({ code: "HISTORY_DATA_INVALID" });
  });

  it("rechaza snapshots recuperados cuyas referencias DTC no pertenecen a la entrada", async () => {
    const row = storedRow();
    row.analysis_snapshot.output.findings[0]!.relatedDtc = {
      code: "P9999",
      moduleCode: "PCM",
      moduleName: "Módulo motriz",
    };
    const repository: DiagnosticHistoryRepository = {
      insert: vi.fn(async () => ({ id: HISTORY_ID })),
      list: vi.fn(async () => ({ rows: [], hasMore: false })),
      findById: vi.fn(async () => row),
    };
    const service = new DiagnosticHistoryService(repository);

    await expect(service.get(USER_ID, HISTORY_ID)).rejects.toMatchObject({ code: "HISTORY_DATA_INVALID" });
  });

  it("genera cursor desde el último elemento sin exceder el límite", async () => {
    const repository: DiagnosticHistoryRepository = {
      insert: vi.fn(async () => ({ id: HISTORY_ID })),
      list: vi.fn(async () => ({ rows: [storedListRow()], hasMore: true })),
      findById: vi.fn(async () => storedRow()),
    };
    const service = new DiagnosticHistoryService(repository);
    const page = await service.list(USER_ID, parseHistoryListQuery({ limit: "1" }));
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toEqual(expect.any(String));
    const decoded = parseHistoryListQuery({ limit: "1", cursor: page.nextCursor! });
    expect(decoded.cursor).toEqual({ createdAt: page.items[0]!.createdAt, id: HISTORY_ID });
  });
});
