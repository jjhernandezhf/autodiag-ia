import { z } from "zod";

// This evaluation deliberately enables only low, on documented model IDs.
export const optionalReasoningEffortSchema = z.preprocess(
  (value) => typeof value === "string" ? value.trim() || undefined : value,
  z.literal("low").optional(),
);

export type AnalysisReasoningEffort = "low";

export function resolveOpenAiReasoningEffort(model: string | undefined, value?: unknown) {
  const effort = optionalReasoningEffortSchema.parse(value);
  if (effort !== undefined && model?.trim() !== "gpt-6.1-sol" && model?.trim() !== "gpt-5.6-luna") {
    throw new Error("OPENAI_REASONING_EFFORT=low requiere gpt-6.1-sol o gpt-5.6-luna en esta evaluación.");
  }
  return effort;
}
