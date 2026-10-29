import { z } from "zod";
import { historyExtractionInputSchema } from "./diagnostic-history.js";
import { diagnosticAnalysisInputSchema } from "./ai-analysis-types.js";
import { prepareAiAnalysis } from "./ai-analysis-adapter.js";
import { containsSensitiveValue } from "./sensitive-data.js";

const confirmationSchema = z.object({
  extraction: historyExtractionInputSchema,
  vehicle: diagnosticAnalysisInputSchema.shape.vehicle,
}).strict();

// Fill missing vehicle fields only. This is not a waiver of extraction review,
// unknown states, count checks, sensitivity checks or analysis resource limits.
export function confirmVehicleData(raw: unknown) {
  const parsed = confirmationSchema.safeParse(raw);
  if (!parsed.success || containsSensitiveValue(parsed.data.vehicle, "structured_identifier")) return null;
  const { extraction, vehicle } = parsed.data;
  const fields = ["make", "model", "year"] as const;
  if (fields.some(key => extraction.vehicle[key] !== null && extraction.vehicle[key] !== vehicle[key])) return null;
  const missing = fields.filter(key => extraction.vehicle[key] === null);
  if (missing.length === 0) return null;
  extraction.vehicle = { ...extraction.vehicle, ...vehicle };
  extraction.warnings = [...extraction.warnings.filter(w => w.code !== "VEHICLE_DATA_CONFIRMED_BY_USER").map(w =>
    w.code === "YEAR_NOT_PROVIDED" ? { ...w, message: "El PDF no proporciona un año; se utiliza el año confirmado por el usuario." } : w), {
    code: "VEHICLE_DATA_CONFIRMED_BY_USER",
    message: `Datos ausentes en el PDF confirmados manualmente por el usuario: ${missing.join(", ")}. No fueron extraídos del documento.`,
  }];
  return { extraction, analysisPreparation: prepareAiAnalysis(extraction) };
}
