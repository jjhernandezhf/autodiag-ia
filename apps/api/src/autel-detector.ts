import type { ExtractedPdfPage } from "./report-types.js";
import { normalizeForMatch } from "./text-normalization.js";

export function detectAutelVehicleDiagnosticReport(pages: ExtractedPdfPage[]) {
  const text = normalizeForMatch(pages.flatMap((page) => page.lines.map((line) => line.text)).join("\n"));
  const signals = {
    title: text.includes("informe de diagnostico de vehiculo"),
    vehicle: text.includes("informacion del vehiculo"),
    systems: /sistema\/?s escaneado\/?s/u.test(text),
    systemColumns: text.includes("estado/dtc") && text.includes("sistema"),
    dtcColumns: text.includes("descripcion") && text.includes("estado") && /\bdtc\b/u.test(text),
  };
  const score = Object.values(signals).filter(Boolean).length;
  return signals.title && signals.vehicle && signals.systems && score >= 4;
}
