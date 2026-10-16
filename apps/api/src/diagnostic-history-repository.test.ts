import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import {
  DiagnosticHistoryService,
  SupabaseDiagnosticHistoryRepository,
  parseHistoryListQuery,
} from "./diagnostic-history.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const CREATED_AT = "2026-10-04T12:00:00.000Z";
const IDS = [
  "33333333-3333-4333-8333-333333333333",
  "22222222-2222-4222-8222-222222222222",
  "11111111-1111-4111-8111-111111111111",
];

function listRow(id = IDS[0]!) {
  return {
    id,
    created_at: CREATED_AT,
    report_reference: null,
    make: "Marca segura",
    model: "Modelo seguro",
    year: 2026,
    odometer_value: null,
    odometer_unit: null,
    dtc_count: 1,
    rag_status: "disabled",
  };
}

function fluentBuilder(result: { data: unknown; error: unknown }) {
  const builder: Record<string, ReturnType<typeof vi.fn>> & PromiseLike<typeof result> = {
    select: vi.fn(() => builder),
    insert: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    order: vi.fn(() => builder),
    limit: vi.fn(() => builder),
    or: vi.fn(() => builder),
    abortSignal: vi.fn(() => builder),
    single: vi.fn(async () => result),
    maybeSingle: vi.fn(async () => result),
    update: vi.fn(() => builder),
    delete: vi.fn(() => builder),
    then: (onfulfilled, onrejected) => Promise.resolve(result).then(onfulfilled, onrejected),
  };
  return builder;
}

function clientFor(builder: unknown) {
  const from = vi.fn(() => builder);
  return { client: { from } as unknown as SupabaseClient, from };
}

describe("adaptador Supabase del historial", () => {
  it("lista solo columnas públicas, filtra usuario y aplica orden y límite estable", async () => {
    const builder = fluentBuilder({ data: [listRow(), listRow(IDS[1])], error: null });
    const { client, from } = clientFor(builder);
    const repository = new SupabaseDiagnosticHistoryRepository(client);

    const page = await repository.list(USER_ID, 1);

    expect(from).toHaveBeenCalledExactlyOnceWith("diagnostic_history");
    expect(builder.select).toHaveBeenCalledExactlyOnceWith(
      "id, created_at, report_reference, make, model, year, odometer_value, odometer_unit, dtc_count, rag_status",
    );
    expect(builder.eq).toHaveBeenCalledExactlyOnceWith("user_id", USER_ID);
    expect(builder.order.mock.calls).toEqual([
      ["created_at", { ascending: false }],
      ["id", { ascending: false }],
    ]);
    expect(builder.limit).toHaveBeenCalledExactlyOnceWith(2);
    expect(builder.or).not.toHaveBeenCalled();
    expect(page).toEqual({ rows: [listRow()], hasMore: true });
  });

  it("aplica exclusivamente el cursor validado de created_at e id sin alterar el usuario", async () => {
    const builder = fluentBuilder({ data: [], error: null });
    const { client } = clientFor(builder);
    const repository = new SupabaseDiagnosticHistoryRepository(client);
    const cursor = { createdAt: CREATED_AT, id: IDS[1]! };

    await repository.list(USER_ID, 20, cursor);

    expect(builder.eq).toHaveBeenCalledExactlyOnceWith("user_id", USER_ID);
    expect(builder.or).toHaveBeenCalledExactlyOnceWith(
      `created_at.lt.${CREATED_AT},and(created_at.eq.${CREATED_AT},id.lt.${IDS[1]})`,
    );
    const injectedCursor = Buffer.from(JSON.stringify({ ...cursor, user_id: "otro" }), "utf8").toString("base64url");
    expect(() => parseHistoryListQuery({ cursor: injectedCursor })).toThrow();

    const invalidBuilder = fluentBuilder({ data: [], error: null });
    const invalidClient = clientFor(invalidBuilder);
    const invalidRepository = new SupabaseDiagnosticHistoryRepository(invalidClient.client);
    await expect(invalidRepository.list(USER_ID, 20, {
      createdAt: "valor-no-validado",
      id: IDS[1]!,
    })).rejects.toThrow();
    expect(invalidClient.from).not.toHaveBeenCalled();
  });

  it("busca el detalle simultáneamente por usuario e id y conserva not found", async () => {
    const foundBuilder = fluentBuilder({ data: listRow(), error: null });
    const foundClient = clientFor(foundBuilder);
    const repository = new SupabaseDiagnosticHistoryRepository(foundClient.client);

    await expect(repository.findById(USER_ID, IDS[0]!)).resolves.toEqual(listRow());
    expect(foundBuilder.eq.mock.calls).toEqual([
      ["user_id", USER_ID],
      ["id", IDS[0]],
    ]);
    expect(foundBuilder.maybeSingle).toHaveBeenCalledOnce();

    const missingBuilder = fluentBuilder({ data: null, error: null });
    const missingRepository = new SupabaseDiagnosticHistoryRepository(clientFor(missingBuilder).client);
    await expect(missingRepository.findById(USER_ID, IDS[0]!)).resolves.toBeNull();
  });

  it("reemplaza la búsqueda ambigua por referencia con huella y señal del propietario", async () => {
    const builder = fluentBuilder({ data: { id: IDS[0] }, error: null });
    const { client } = clientFor(builder);
    const repository = new SupabaseDiagnosticHistoryRepository(client);

    const signal = new AbortController().signal;
    const fingerprint = `analysis_v1_${"c".repeat(64)}`;
    await expect(repository.findIdByAnalysisFingerprint(USER_ID, fingerprint, signal)).resolves.toEqual({ id: IDS[0] });
    expect(builder.abortSignal).toHaveBeenCalledExactlyOnceWith(signal);
    expect(repository).not.toHaveProperty("findIdByReportReference");
    expect(builder.select).toHaveBeenCalledExactlyOnceWith("id");
    expect(builder.eq.mock.calls).toEqual([
      ["user_id", USER_ID],
      ["analysis_fingerprint", fingerprint],
    ]);
    expect(builder.maybeSingle).toHaveBeenCalledOnce();
  });

  it("busca la huella del análisis exclusivamente dentro del usuario autenticado", async () => {
    const builder = fluentBuilder({ data: { id: IDS[0] }, error: null });
    const { client } = clientFor(builder);
    const repository = new SupabaseDiagnosticHistoryRepository(client);
    const fingerprint = `analysis_v1_${"a".repeat(64)}`;

    await expect(repository.findIdByAnalysisFingerprint(USER_ID, fingerprint)).resolves.toEqual({ id: IDS[0] });
    expect(builder.select).toHaveBeenCalledExactlyOnceWith("id");
    expect(builder.eq.mock.calls).toEqual([
      ["user_id", USER_ID],
      ["analysis_fingerprint", fingerprint],
    ]);
  });

  it("inserta el usuario autenticado, propaga AbortSignal y no solicita escritura mutable", async () => {
    const builder = fluentBuilder({ data: { id: IDS[0] }, error: null });
    const { client } = clientFor(builder);
    const repository = new SupabaseDiagnosticHistoryRepository(client);
    const controller = new AbortController();
    const record = {
      reportReference: IDS[1],
      contentFingerprint: `pdf_v1_${"a".repeat(64)}`,
      analysisFingerprint: `analysis_v1_${"b".repeat(64)}`,
      make: "Marca segura",
      model: "Modelo seguro",
      year: 2026,
      odometer: null,
      vinHmac: null,
      vinLast4: null,
      dtcCodes: ["P0300"],
      ragStatus: "disabled",
      extractionSnapshot: {},
      analysisSnapshot: {},
      ragSnapshot: {},
      analysisModel: "synthetic-analysis-model",
      embeddingModel: null,
    } as unknown as Parameters<SupabaseDiagnosticHistoryRepository["insert"]>[1];

    await expect(repository.insert(USER_ID, record, controller.signal)).resolves.toEqual({ id: IDS[0], reused: false });

    const payload = builder.insert.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.user_id).toBe(USER_ID);
    expect(payload.content_fingerprint).toBe(record.contentFingerprint);
    expect(payload.analysis_fingerprint).toBe(record.analysisFingerprint);
    expect(payload).not.toHaveProperty("userId");
    expect(JSON.stringify(payload.extraction_snapshot)).not.toContain("user_id");
    expect(builder.abortSignal).toHaveBeenCalledExactlyOnceWith(controller.signal);
    expect(builder.select).toHaveBeenCalledExactlyOnceWith("id");
    expect(builder.single).toHaveBeenCalledOnce();
    expect(builder.update).not.toHaveBeenCalled();
    expect(builder.delete).not.toHaveBeenCalled();
  });

  it("ante conflicto del índice recupera el registro ganador aislado por usuario y huella", async () => {
    const insertBuilder = fluentBuilder({ data: null, error: { code: "23505" } });
    const winnerBuilder = fluentBuilder({ data: { id: IDS[0] }, error: null });
    const from = vi.fn()
      .mockReturnValueOnce(insertBuilder)
      .mockReturnValueOnce(winnerBuilder);
    const repository = new SupabaseDiagnosticHistoryRepository({ from } as unknown as SupabaseClient);
    const record = {
      reportReference: IDS[1],
      contentFingerprint: `pdf_v1_${"a".repeat(64)}`,
      analysisFingerprint: `analysis_v1_${"b".repeat(64)}`,
      make: "Marca segura",
      model: "Modelo seguro",
      year: 2026,
      odometer: null,
      vinHmac: null,
      vinLast4: null,
      dtcCodes: ["P0300"],
      ragStatus: "disabled",
      extractionSnapshot: {},
      analysisSnapshot: {},
      ragSnapshot: {},
      analysisModel: "synthetic-analysis-model",
      embeddingModel: null,
    } as unknown as Parameters<SupabaseDiagnosticHistoryRepository["insert"]>[1];

    const signal = new AbortController().signal;
    await expect(repository.insert(USER_ID, record, signal)).resolves.toEqual({ id: IDS[0], reused: true });
    expect(insertBuilder.abortSignal).toHaveBeenCalledExactlyOnceWith(signal);
    expect(winnerBuilder.abortSignal).toHaveBeenCalledExactlyOnceWith(signal);
    expect(from).toHaveBeenCalledTimes(2);
    expect(winnerBuilder.eq.mock.calls).toEqual([
      ["user_id", USER_ID],
      ["analysis_fingerprint", record.analysisFingerprint],
    ]);
    expect(insertBuilder.update).not.toHaveBeenCalled();
    expect(insertBuilder.delete).not.toHaveBeenCalled();
  });

  it("pagina sin repeticiones ni pérdidas cuando tres filas comparten created_at", async () => {
    const rows = IDS.map((id) => ({ ...listRow(id), user_id: USER_ID }));
    const from = vi.fn(() => {
      let selectedUser: string | undefined;
      let requestedLimit = 0;
      let cursorId: string | undefined;
      const builder = {
        select: vi.fn(() => builder),
        eq: vi.fn((column: string, value: string) => {
          if (column === "user_id") selectedUser = value;
          return builder;
        }),
        order: vi.fn(() => builder),
        limit: vi.fn((value: number) => {
          requestedLimit = value;
          return builder;
        }),
        or: vi.fn((filter: string) => {
          cursorId = /id\.lt\.([0-9a-f-]+)/u.exec(filter)?.[1];
          return builder;
        }),
        then: (
          onfulfilled?: (value: { data: unknown[]; error: null }) => unknown,
          onrejected?: (reason: unknown) => unknown,
        ) => {
          const data = rows
            .filter((row) => row.user_id === selectedUser && (cursorId === undefined || row.id < cursorId))
            .sort((left, right) => right.id.localeCompare(left.id))
            .slice(0, requestedLimit)
            .map((row) => {
              const { user_id: _userId, ...publicRow } = row;
              void _userId;
              return publicRow;
            });
          return Promise.resolve({ data, error: null }).then(onfulfilled, onrejected);
        },
      };
      return builder;
    });
    const repository = new SupabaseDiagnosticHistoryRepository({ from } as unknown as SupabaseClient);
    const service = new DiagnosticHistoryService(repository);

    const first = await service.list(USER_ID, parseHistoryListQuery({ limit: "1" }));
    const second = await service.list(USER_ID, parseHistoryListQuery({ limit: "1", cursor: first.nextCursor! }));
    const third = await service.list(USER_ID, parseHistoryListQuery({ limit: "1", cursor: second.nextCursor! }));

    expect([first.items[0]!.id, second.items[0]!.id, third.items[0]!.id]).toEqual(IDS);
    expect(new Set([first.items[0]!.id, second.items[0]!.id, third.items[0]!.id]).size).toBe(3);
    expect(first.nextCursor).not.toBeNull();
    expect(second.nextCursor).not.toBeNull();
    expect(third.nextCursor).toBeNull();
    expect(parseHistoryListQuery({ limit: "1", cursor: first.nextCursor! }).cursor).toEqual({
      createdAt: CREATED_AT,
      id: IDS[0],
    });
  });
});
