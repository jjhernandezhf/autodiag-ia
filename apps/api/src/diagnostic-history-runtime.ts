import {
  DiagnosticHistoryService,
  SupabaseDiagnosticHistoryRepository,
} from "./diagnostic-history.js";
import { getSupabaseAdminClient } from "./supabase-admin-client.js";

export function createConfiguredDiagnosticHistoryService(): DiagnosticHistoryService | undefined {
  try {
    return new DiagnosticHistoryService(
      new SupabaseDiagnosticHistoryRepository(getSupabaseAdminClient()),
    );
  } catch {
    return undefined;
  }
}
