import { describe, expect, it, vi } from "vitest";

import { detectAutelVehicleDiagnosticReport } from "./autel-detector.js";
import { parseAutelReport, parseOdometer } from "./autel-parser.js";
import type { ExtractedPdfPage, ExtractedTextFragment } from "./report-types.js";

const TEST_SECRET = "parser-only-synthetic-secret-at-least-32-bytes";
const SYNTHETIC_VIN = "1ABCD23EFGH456789";

function line(text: string, fragments?: ExtractedTextFragment[]) {
  return { text, y: 0, fragments: fragments ?? [{ text, x: 0, width: text.length }] };
}

function columns(code: string, description: string, status: string) {
  return line(`${code} ${description} ${status}`, [
    { text: code, x: 20, width: 70 },
    { text: description, x: 130, width: 250 },
    { text: status, x: 480, width: 70 },
  ]);
}

function completePages(): ExtractedPdfPage[] {
  return [
    {
      pageNumber: 1,
      lines: [
        line("Informe de diagnóstico de vehículo"),
        line("Información del vehículo"),
        line("2022 / Marca Sintética / Modelo Sintético / Motor Sintético"),
        line("Lectura del odómetro: 12345.5 mi"),
        line(`VIN: ${SYNTHETIC_VIN}`),
        line("Sistema/s escaneado/s (3)"),
        line("Sistema Estado/DTC"),
        line("PCM(Control Unit (Primary)) 2"),
        line("DOOR_ESU_D(Driver's"),
        line("Side) 0"),
      ],
    },
    {
      pageNumber: 2,
      lines: [
        line("Tiempo de prueba: 2030-01-01 ID del informe: SYNTHETIC"),
        line("BCM/ALT(Body-Control Module (Nested)) 1"),
        line("DTC (3)"),
        line("PCM(Control Unit (Primary)) (2 DTC)"),
        line("DTC Descripción Estado", [
          { text: "DTC", x: 20, width: 50 },
          { text: "Descripción", x: 130, width: 100 },
          { text: "Estado", x: 480, width: 60 },
        ]),
        columns("U1000:87-AB", "Señal sintética dividida", "Corriente"),
        line("Sensor adicional en segunda línea", [{ text: "Sensor adicional en segunda línea", x: 130, width: 180 }]),
        columns("P2000-01", "Descripción sintética almacenada", "Almacenado"),
        line("BCM/ALT(Body-Control"),
        line("Module (Nested)) (1 DTC)"),
        line("DTC Descripción Estado", [
          { text: "DTC", x: 20, width: 50 },
          { text: "Descripción", x: 130, width: 100 },
          { text: "Estado", x: 480, width: 60 },
        ]),
        columns("B3000", "Descripción sintética pendiente", "Pendiente"),
      ],
    },
  ];
}

function zeroDtcPages(): ExtractedPdfPage[] {
  return [
    {
      pageNumber: 1,
      lines: [
        line("Informe de diagnostico de vehiculo"),
        line("Informacion del vehiculo"),
        line("2023 / Marca de Prueba / Modelo de Prueba / --"),
        line("Lectura del odometro: --"),
        line("VIN: --"),
        line("Sistema/s escaneado/s (1)"),
        line("Sistema Estado/DTC"),
        line("PCM(Módulo sintético) 0"),
        line("DTC (0)"),
      ],
    },
  ];
}

describe("parseAutelReport", () => {
  it("estructura un reporte multipágina con módulos y DTC complejos", () => {
    const result = parseAutelReport(completePages(), TEST_SECRET);

    expect(result.status).toBe("completed");
    expect(result.requiresManualReview).toBe(false);
    expect(result.vehicle).toMatchObject({
      year: 2022,
      make: "Marca Sintética",
      model: "Modelo Sintético",
      engine: "Motor Sintético",
      odometer: { value: 12345.5, unit: "mi" },
    });
    expect(result.vehicle.vinMasked).toBe("*************6789");
    expect(result.vehicle.vinPseudonym).toMatch(/^vin_v1_[a-f0-9]{64}$/u);
    expect(parseAutelReport(completePages(), TEST_SECRET).vehicle.vinPseudonym).toBe(result.vehicle.vinPseudonym);
    expect(result.scanSummary).toEqual({ declaredSystems: 3, parsedSystems: 3, declaredDtcs: 3, parsedDtcs: 3 });
    expect(result.systems).toEqual([
      { code: "PCM", name: "Control Unit (Primary)", dtcCount: 2 },
      { code: "DOOR_ESU_D", name: "Driver's Side", dtcCount: 0 },
      { code: "BCM/ALT", name: "Body-Control Module (Nested)", dtcCount: 1 },
    ]);
    expect(result.dtcs[0]).toMatchObject({
      code: "U1000:87-AB",
      moduleCode: "PCM",
      moduleName: "Control Unit (Primary)",
      status: "current",
      statusOriginal: "Corriente",
      descriptionOriginal: "Señal sintética dividida Sensor adicional en segunda línea",
    });
  });

  it("acepta un reporte coherente con cero DTC y campos opcionales ausentes", () => {
    const result = parseAutelReport(zeroDtcPages(), TEST_SECRET);

    expect(result.status).toBe("completed");
    expect(result.requiresManualReview).toBe(false);
    expect(result.vehicle).toMatchObject({ engine: null, odometer: null, vinMasked: null, vinPseudonym: null });
    expect(result.scanSummary).toEqual({ declaredSystems: 1, parsedSystems: 1, declaredDtcs: 0, parsedDtcs: 0 });
    expect(result.warnings.map((warning) => warning.code)).toEqual(
      expect.arrayContaining(["VIN_NOT_PROVIDED", "ENGINE_NOT_PROVIDED", "ODOMETER_NOT_PROVIDED"]),
    );
  });

  it("asocia un contador centrado con un nombre de módulo dividido en dos líneas", () => {
    const pages = zeroDtcPages();
    pages[0]!.lines.splice(
      7,
      1,
      { ...line("MOD_A(Control Unit /"), y: 300 },
      { ...line("0", [{ text: "0", x: 500, width: 8 }]), y: 291 },
      { ...line("Nested (Section))"), y: 282 },
    );

    const result = parseAutelReport(pages, TEST_SECRET);

    expect(result.status).toBe("completed");
    expect(result.systems).toEqual([{ code: "MOD_A", name: "Control Unit / Nested (Section)", dtcCount: 0 }]);
  });

  it("marca como parcial los totales inconsistentes", () => {
    const pages = zeroDtcPages();
    pages[0]!.lines[5] = line("Sistema/s escaneado/s (2)");
    pages[0]!.lines[8] = line("DTC (1)");

    const result = parseAutelReport(pages, TEST_SECRET);

    expect(result.status).toBe("partial");
    expect(result.requiresManualReview).toBe(true);
    expect(result.warnings.map((warning) => warning.code)).toEqual(
      expect.arrayContaining(["SYSTEM_COUNT_MISMATCH", "DTC_COUNT_MISMATCH"]),
    );
  });

  it("conserva un estado desconocido y genera una advertencia segura", () => {
    const pages = completePages();
    pages[1]!.lines[5] = columns("U1000:87-AB", "Señal sintética dividida", "Intermitente");

    const result = parseAutelReport(pages, TEST_SECRET);

    expect(result.status).toBe("partial");
    expect(result.dtcs[0]).toMatchObject({ status: "unknown", statusOriginal: "Intermitente" });
    expect(result.warnings).toContainEqual({
      code: "UNKNOWN_DTC_STATUS",
      message: "Al menos un estado DTC no pudo normalizarse.",
    });
  });

  it("no expone el VIN completo y detecta candidatos incompatibles", () => {
    const pages = completePages();
    pages[0]!.lines.splice(5, 0, line("VIN: 2BCDE34FGHJ567891"));

    const result = parseAutelReport(pages, TEST_SECRET);
    const serialized = JSON.stringify(result);

    expect(result.status).toBe("partial");
    expect(result.vehicle.vinMasked).toBeNull();
    expect(result.vehicle.vinPseudonym).toBeNull();
    expect(serialized).not.toContain(SYNTHETIC_VIN);
    expect(serialized).not.toContain("2BCDE34FGHJ567891");
  });

  it("marca como parcial una identidad vehicular completamente ilegible aunque los totales cero coincidan", () => {
    const pages: ExtractedPdfPage[] = [
      {
        pageNumber: 1,
        lines: [
          line("Informe de diagnostico de vehiculo"),
          line("Informacion del vehiculo"),
          line("-- / -- / --"),
          line("Sistema/s escaneado/s (0)"),
          line("Sistema Estado/DTC"),
          line("DTC (0)"),
          line("DTC Descripcion Estado"),
        ],
      },
    ];

    expect(detectAutelVehicleDiagnosticReport(pages)).toBe(true);
    const result = parseAutelReport(pages, TEST_SECRET);

    expect(result.status).toBe("partial");
    expect(result.requiresManualReview).toBe(true);
    expect(result.vehicle).toMatchObject({ year: null, make: null, model: null });
    expect(result.scanSummary).toEqual({ declaredSystems: 0, parsedSystems: 0, declaredDtcs: 0, parsedDtcs: 0 });
    expect(result.warnings).toContainEqual({
      code: "VEHICLE_IDENTITY_UNREADABLE",
      message: "No se pudo interpretar la identidad principal del vehículo.",
    });
  });

  it.each([
    ["Lectura del odometro: 123.456 km", { value: 123456, unit: "km" }],
    ["Lectura del odometro: 123,456 mi", { value: 123456, unit: "mi" }],
    ["Lectura del odometro: 1.234.567 km", { value: 1234567, unit: "km" }],
    ["Lectura del odometro: 1,234,567 mi", { value: 1234567, unit: "mi" }],
    ["Lectura del odometro: 123,4 km", { value: 123.4, unit: "km" }],
    ["Lectura del odometro: 123.4 mi", { value: 123.4, unit: "mi" }],
    ["Lectura del odometro: 1.234,5 km", { value: 1234.5, unit: "km" }],
    ["Lectura del odometro: 1,234.5 mi", { value: 1234.5, unit: "mi" }],
    ["Lectura del odometro: 1.234,567 km", { value: 1234.567, unit: "km" }],
    ["Lectura del odometro: 1,234.567 mi", { value: 1234.567, unit: "mi" }],
    ["Lectura del odometro: 1.234.567,8901 km", { value: 1234567.8901, unit: "km" }],
    ["Lectura del odometro: 1,234,567.8901 mi", { value: 1234567.8901, unit: "mi" }],
    ["Lectura del odometro: 123.40 km", { value: 123.4, unit: "km" }],
    ["Lectura del odometro: 0.1 km", { value: 0.1, unit: "km" }],
    ["Lectura del odometro: 0.0000001 km", { value: 0.0000001, unit: "km" }],
    ["Lectura del odometro: 0.0 km", { value: 0, unit: "km" }],
    ["Lectura del odometro: 9,007,199,254,740,991 mi", { value: Number.MAX_SAFE_INTEGER, unit: "mi" }],
    ["Lectura del odometro: 1 234 km", { value: 1234, unit: "km" }],
    ["Lectura del odometro: 1\u00a0234 km", { value: 1234, unit: "km" }],
    ["Lectura del odometro: 1\u202f234 km", { value: 1234, unit: "km" }],
    ["Lectura del odometro: 123\u202f456 km", { value: 123456, unit: "km" }],
    ["Lectura del odometro: 123'456 mi", { value: 123456, unit: "mi" }],
    ["Lectura del odometro: 1'234'567 km", { value: 1234567, unit: "km" }],
  ])("normaliza el odómetro %s", (raw, expected) => {
    expect(parseOdometer(raw)).toEqual(expected);
  });

  it.each([
    "Lectura del odometro: 12 34 km",
    "Lectura del odometro: 12\u202f34 km",
    "Lectura del odometro: 1'23'456 km",
    "Lectura del odometro: 1234 567 km",
    "Lectura del odometro: 1  234 km",
    "Lectura del odometro: 1''234 km",
    "Lectura del odometro: 12.34,567 km",
    "Lectura del odometro: 12,34.567 mi",
    "Lectura del odometro: 1.234, km",
    "Lectura del odometro: 1.234,56.7 km",
    "Lectura del odometro: -123 km",
    "Lectura del odometro: 9,007,199,254,740.991 mi",
    "Lectura del odometro: 9.007.199.254.740,991 km",
    "Lectura del odometro: 9,007,199,254,740,992 mi",
    "Lectura del odometro: 9,007,199,254,740,992.1 mi",
  ])("rechaza el formato de odómetro incompatible %s", (raw) => {
    expect(parseOdometer(raw)).toBeNull();
  });

  it("rechaza un decimal no nulo que Number convertiría silenciosamente en cero", () => {
    const tinyValue = `0.${"0".repeat(400)}1`;

    expect(parseOdometer(`Lectura del odometro: ${tinyValue} km`)).toBeNull();
  });

  it("rechaza una conversión decimal con pérdida sin exponer el valor", () => {
    const unsafeValue = "9,007,199,254,740.991";
    const pages = zeroDtcPages();
    pages[0]!.lines[3] = line(`Lectura del odometro: ${unsafeValue} mi`);
    const spies = ["log", "info", "warn", "error"].map((method) => vi.spyOn(console, method as "log").mockImplementation(() => undefined));

    try {
      const result = parseAutelReport(pages, TEST_SECRET);

      expect(result.vehicle.odometer).toBeNull();
      expect(result.warnings).toContainEqual({
        code: "ODOMETER_NOT_PROVIDED",
        message: "El reporte no proporciona una lectura de odómetro utilizable.",
      });
      expect(JSON.stringify(result)).not.toContain(unsafeValue);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("rechaza un odómetro mal formado con una advertencia que no expone su valor", () => {
    const malformedValue = "12,34,567";
    const pages = zeroDtcPages();
    pages[0]!.lines[3] = line(`Lectura del odometro: ${malformedValue} km`);
    const spies = ["log", "info", "warn", "error"].map((method) => vi.spyOn(console, method as "log").mockImplementation(() => undefined));

    try {
      const result = parseAutelReport(pages, TEST_SECRET);

      expect(result.vehicle.odometer).toBeNull();
      expect(result.warnings).toContainEqual({
        code: "ODOMETER_NOT_PROVIDED",
        message: "El reporte no proporciona una lectura de odómetro utilizable.",
      });
      expect(JSON.stringify(result)).not.toContain(malformedValue);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
