import { useEffect, useRef, useState } from "react";
import type { BrowserApiClient } from "./api-client";

export function HistoryAutomation({ apiClient, historyId }: { apiClient: BrowserApiClient; historyId: string }) {
  const [enabled, setEnabled] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const active = useRef<AbortController | null>(null);
  useEffect(() => {
    const sequence = ++generation.current;
    const controller = new AbortController();
    void apiClient.requestJson("/api/automation/capabilities", { init: { signal: controller.signal }, retry: "none",
      parse: value => value && typeof value === "object" && typeof (value as { enabled?: unknown }).enabled === "boolean"
        ? { enabled: (value as { enabled: boolean }).enabled } : null,
      errorMessage: () => "Automatización no disponible.",
    }).then(value => { if (!controller.signal.aborted && generation.current === sequence) setEnabled(value.enabled); }).catch(() => {});
    return () => { generation.current = sequence + 1; controller.abort(); active.current?.abort(); active.current = null; };
  }, [apiClient, historyId]);
  async function send() {
    if (!enabled || active.current) return;
    const sequence = generation.current, controller = new AbortController();
    active.current = controller; setBusy(true); setMessage("");
    try {
      await apiClient.requestJson(`/api/history/${encodeURIComponent(historyId)}/automation`, {
        init: { method: "POST", signal: controller.signal }, timeoutMs: 12_000, retry: "none",
        parse: value => value && typeof value === "object" && (value as { status?: unknown }).status === "completed" ? true : null,
        errorMessage: () => "No se pudo confirmar el evento.",
      });
      if (!controller.signal.aborted && generation.current === sequence) setMessage("Recepción del evento confirmada. El diagnóstico no fue modificado.");
    } catch {
      if (!controller.signal.aborted && generation.current === sequence) setMessage("No se pudo confirmar el evento; puede haberse recibido. Puedes reintentar manualmente. El diagnóstico permanece intacto.");
    } finally {
      if (active.current === controller && generation.current === sequence) { active.current = null; setBusy(false); }
    }
  }
  if (!enabled) return null;
  return <section aria-label="Automatización"><button type="button" disabled={busy} onClick={() => void send()}>
    {busy ? "Registrando evento…" : "Registrar evento en n8n"}</button><p role="status">{message}</p></section>;
}
