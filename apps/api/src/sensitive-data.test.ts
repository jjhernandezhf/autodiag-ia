import { describe, expect, it } from "vitest";

import { containsSensitiveText, containsSensitiveValue, normalizeSafeHttpsUrl } from "./sensitive-data.js";

describe("protección central de datos sensibles", () => {
  it.each([
    "1HGCM82633A004352",
    "cliente@example.test",
    "55551234",
    "+502 (5555) 1234",
    "reporte-cliente.pdf",
    "sk-proj-syntheticValue123456",
    "sb_secret_syntheticValue123456",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMifQ.signature123",
    "API_KEY=synthetic-value",
    "TOKEN: synthetic-value",
    "SECRET=synthetic-value",
    "PASSWORD=synthetic-value",
    "AUTHORIZATION=Bearer-synthetic-value",
  ])("detecta %s", (value) => {
    expect(containsSensitiveText(value, "free_text")).toBe(true);
  });

  it("detecta claves sensibles también en metadata anidada", () => {
    expect(containsSensitiveValue({ public: { authorization: "valor" } }, "source_text")).toBe(true);
  });

  it.each([
    ["P0300", "structured_identifier"],
    ["2025", "structured_identifier"],
    ["123456 km", "free_text"],
    ["PCM-01", "structured_identifier"],
    ["ECU-12345678", "structured_identifier"],
    ["PCM-12345678", "structured_identifier"],
    ["TCM-12345678", "structured_identifier"],
    ["BCM-12345678", "structured_identifier"],
    ["ECM-12345678", "structured_identifier"],
    ["ABS-12345678", "structured_identifier"],
    ["SRS-12345678", "structured_identifier"],
    ["PID-12345678", "structured_identifier"],
    ["CAN-12345678", "structured_identifier"],
    ["Servicio 2026-09-22", "free_text"],
  ] as const)("permite el valor técnico %s", (value, context) => {
    expect(containsSensitiveText(value, context)).toBe(false);
  });

  it.each([
    "55551234",
    "Tel: 55551234",
    "Teléfono 5555-1234",
    "+502 5555-1234",
    "CONTACTO-55551234",
  ])("mantiene bloqueado el teléfono %s", (value) => {
    expect(containsSensitiveText(value, "free_text")).toBe(true);
  });

  it("acepta HTTPS PDF y normaliza la URL", () => {
    expect(normalizeSafeHttpsUrl("https://example.com/manual.pdf"))
      .toBe("https://example.com/manual.pdf");
  });

  it.each([
    "http://example.com/manual.pdf",
    "https://usuario:clave@example.com/manual.pdf",
    "https://example.com/manual.pdf?token=valor-sintetico",
    "https://example.com/manual.pdf?source=sb_secret_syntheticValue123456",
  ])("rechaza la URL insegura %s", (value) => {
    expect(normalizeSafeHttpsUrl(value)).toBeUndefined();
  });
});
