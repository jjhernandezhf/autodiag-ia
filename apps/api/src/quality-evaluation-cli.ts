import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { evaluateQuality, evaluationCasesSchema } from "./quality-evaluation.js";

// Explicit local JSON files only; never dotenv, network clients or product bootstrap.
export function runQualityEvaluation(args: string[], read = (path: string) => readFileSync(path, "utf8")) {
  if (args.length !== 2 || args.some((path) => !path.toLowerCase().endsWith(".json"))) {
    throw new Error("EVALUATION_USAGE");
  }
  const cases = JSON.parse(read(resolve(args[0]!)));
  const output = evaluateQuality(cases, JSON.parse(read(resolve(args[1]!))));
  const unobservedCases = evaluationCasesSchema.parse(cases).cases
    .filter((item) => !output.some((run) => run.caseId === item.id))
    .map((item) => ({ caseId: item.id, status: "not_evaluable", reason: "missing_run" }));
  return JSON.stringify({ schemaVersion: "quality_metrics_v1", runs: output, unobservedCases }, null, 2);
}

// Isolated entry point, not imported by the API. Errors never echo input or local paths.
try {
  console.log(runQualityEvaluation(process.argv.slice(2)));
} catch {
  console.error("EVALUATION_INPUT_INVALID: use two authorized sanitized JSON files matching quality_cases_v1 and quality_results_v1.");
  process.exitCode = 1;
}
