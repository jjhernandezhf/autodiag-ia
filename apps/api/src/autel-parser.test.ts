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

function codeAndStatus(code: string, status: string) {
  return line(`${code} ${status}`, [
    { text: code, x: 20, width: 70 },
    { text: status, x: 480, width: 90 },
  ]);
}

function dtcTableHeader() {
  return line("DTC Descripción Estado", [
    { text: "DTC", x: 20, width: 50 },
    { text: "Descripción", x: 130, width: 100 },
    { text: "Estado", x: 480, width: 60 },
  ]);
}

function bmwPages(): ExtractedPdfPage[] {
  const activeSystems = [
    ["DME", "Electrónica de motor digital", 1],
    ["DSC", "Control de Estabilidad Dinámico", 1],
    ["KOMBI", "Grupo de instrumentos", 1],
    ["BDC", "Controlador de dominio corporal", 3],
    ["ICM", "Gestión del Chasis Integrada", 2],
    ["KAFAS", "Sistemas de asistencia basados en cámara", 1],
    ["IHKA", "Control de A/C", 1],
  ] as const;
  const systems = [
    ...activeSystems.map(([code, name, count]) => line(`${code}(${name}) ${count}`)),
    ...Array.from({ length: 23 }, (_, index) => line(`Z${index}(Módulo sintético ${index}) 0`)),
  ];
  const description = (text: string) => line(text, [{ text, x: 130, width: 280 }]);

  return [
    {
      pageNumber: 1,
      lines: [
        line("Informe de diagnóstico de vehículo"),
        line("Información del vehículo"),
        line("2015_10/BMW/X'/X5 sDrive35i_N55/"),
        line("Lectura del odómetro: 180001 km"),
        line(`VIN: ${SYNTHETIC_VIN}`),
        line("Número de serie: 030343"),
        line("Orden de reparación: 480004"),
        line("ID del informe: 800A07"),
        line("Sistema/s escaneado/s (30)"),
        line("Sistema Estado/DTC"),
        ...systems,
      ],
    },
    {
      pageNumber: 2,
      lines: [
        line("DTC (10)"),
        line("DME(Electrónica de motor digital) (1 DTC)"),
        dtcTableHeader(),
        description("Convertidor catalítico: rendimiento por debajo"),
        codeAndStatus("180001", "Intermitente"),
        description("del valor límite"),
        line("DSC(Control de Estabilidad Dinámico) (1 DTC)"),
        dtcTableHeader(),
        description("Sensor de desgaste de freno trasero"),
        codeAndStatus("480A12", "Permanente"),
        description("requiere comprobación"),
        line("KOMBI(Grupo de instrumentos) (1 DTC)"),
        dtcTableHeader(),
        description("Señal de operación de columna"),
        codeAndStatus("E12C35", "Intermitente"),
        description("no válida"),
        line("BDC(Controlador de dominio corporal) (3 DTC)"),
        dtcTableHeader(),
        columns("030343", "Botón sintético atascado", "Intermitente"),
        description("Actuador sintético"),
        codeAndStatus("030488", "Intermitente"),
        description("cortocircuito a masa"),
        description("Indicador delantero"),
        codeAndStatus("80418B", "Intermitente"),
      ],
    },
    {
      pageNumber: 3,
      lines: [
        description("derecho defectuoso"),
        line("ICM(Gestión del Chasis Integrada) (2 DTC)"),
        dtcTableHeader(),
        columns("480004", "Interfaz de cámara con señal inválida", "Intermitente"),
        columns("48004A", "Interfaz de volante con señal inválida", "Intermitente"),
        line("KAFAS(Sistemas de asistencia basados en cámara) (1 DTC)"),
        dtcTableHeader(),
        columns("800A07", "Motor de vibración defectuoso", "Intermitente"),
        line("IHKA(Control de A/C) (1 DTC)"),
        dtcTableHeader(),
        description("Motor de trampilla trasera"),
        codeAndStatus("8011A3", "Permanente"),
        description("bloqueo detectado"),
        line("Número informe"),
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
      classification: "actionable",
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

  it("interpreta diez DTC BMW contextuales, descripciones multilínea y continuidad entre páginas", () => {
    const result = parseAutelReport(bmwPages(), TEST_SECRET);
    const expectedCodes = ["180001", "480A12", "E12C35", "030343", "030488", "80418B", "480004", "48004A", "800A07", "8011A3"];

    expect(result.status).toBe("completed");
    expect(result.requiresManualReview).toBe(false);
    expect(result.vehicle).toMatchObject({ year: 2015, make: "BMW", model: "X5", engine: "sDrive35i / N55" });
    expect(result.scanSummary).toEqual({ declaredSystems: 30, parsedSystems: 30, declaredDtcs: 10, parsedDtcs: 10 });
    expect(result.dtcs.map((dtc) => dtc.code)).toEqual(expectedCodes);
    expect(result.dtcs.map((dtc) => dtc.moduleCode)).toEqual([
      "DME", "DSC", "KOMBI", "BDC", "BDC", "BDC", "ICM", "ICM", "KAFAS", "IHKA",
    ]);
    expect(result.dtcs[0]).toMatchObject({
      status: "intermittent",
      classification: "actionable",
      descriptionOriginal: "Convertidor catalítico: rendimiento por debajo del valor límite",
    });
    expect(result.dtcs[1]).toMatchObject({ status: "permanent", classification: "actionable" });
    expect(result.dtcs[5]?.descriptionOriginal).toBe("Indicador delantero derecho defectuoso");
    expect(result.dtcs.every((dtc) => dtc.descriptionOriginal.length > 0)).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.dtcs).toHaveLength(10);
  });

  it("no acepta un número hexadecimal de seis caracteres sin módulo y columnas DTC", () => {
    const pages = zeroDtcPages();
    pages[0]!.lines.push(line("180001"));

    const result = parseAutelReport(pages, TEST_SECRET);

    expect(result.dtcs).toEqual([]);
    expect(result.scanSummary.parsedDtcs).toBe(0);
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

  it("normaliza Intermitente como accionable sin convertirlo en historial", () => {
    const pages = completePages();
    pages[1]!.lines[5] = columns("U1000:87-AB", "Señal sintética dividida", "Intermitente");

    const result = parseAutelReport(pages, TEST_SECRET);

    expect(result.status).toBe("completed");
    expect(result.dtcs[0]).toMatchObject({
      status: "intermittent",
      statusOriginal: "Intermitente",
      classification: "actionable",
    });
    expect(result.warnings).not.toContainEqual(expect.objectContaining({ code: "UNKNOWN_DTC_STATUS" }));
  });

  it("conserva un estado realmente desconocido y genera una advertencia segura", () => {
    const pages = completePages();
    pages[1]!.lines[5] = columns("U1000:87-AB", "Señal sintética dividida", "Estado no definido");

    const result = parseAutelReport(pages, TEST_SECRET);

    expect(result.status).toBe("partial");
    expect(result.dtcs[0]).toMatchObject({
      status: "unknown",
      statusOriginal: "Estado no definido",
      classification: "unknown",
    });
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
