import { useEffect, useRef, useState } from "react";
import type { BrowserApiClient } from "./api-client";

interface AnalyticsExport {
  schemaVersion: 1; cutoff: string; analysesCount: number; dtcCount: number; analysesCsv: string; dtcsCsv: string;
}
function parseExport(value: unknown): AnalyticsExport | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).sort().join() !== ["schemaVersion", "cutoff", "analysesCount", "dtcCount", "analysesCsv", "dtcsCsv"].sort().join() ||
    item.schemaVersion !== 1 || typeof item.cutoff !== "string" || item.cutoff.length > 40 || !Number.isFinite(Date.parse(item.cutoff)) ||
    !Number.isInteger(item.analysesCount) || (item.analysesCount as number) < 0 || (item.analysesCount as number) > 200 ||
    !Number.isInteger(item.dtcCount) || (item.dtcCount as number) < 0 || (item.dtcCount as number) > 10_000 ||
    typeof item.analysesCsv !== "string" || typeof item.dtcsCsv !== "string" ||
    item.analysesCsv.length + item.dtcsCsv.length > 4 * 1024 * 1024 ||
    !item.analysesCsv.startsWith('\uFEFF"analysis_reference","created_at","make","model","year","dtc_count","rag_status"\r\n') ||
    !item.dtcsCsv.startsWith('\uFEFF"analysis_reference","dtc_code","module_code","module_name"\r\n')) return null;
  return item as unknown as AnalyticsExport;
}

export function HistoryAnalyticsExport({ apiClient, onFailure }: {
  apiClient: BrowserApiClient;
  onFailure: (error: unknown, retry: () => void) => boolean;
}) {
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [message, setMessage] = useState("");
  const [urls, setUrls] = useState<{ analyses: string; dtcs: string } | null>(null);
  const resources = useRef<string[]>([]);
  const active = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  function release() {
    resources.current.forEach(url => URL.revokeObjectURL(url));
    resources.current = [];
  }
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; active.current?.abort(); release(); };
  }, []);
  async function prepare() {
    if (!mounted.current || active.current) return;
    const controller = new AbortController();
    active.current = controller;
    release(); setUrls(null); setStatus("loading"); setMessage("");
    try {
      const result = await apiClient.requestJson("/api/history/export", {
        init: { signal: controller.signal }, timeoutMs: 15_000, retry: "none", parse: parseExport,
        errorMessage: () => "No fue posible exportar todo el historial. No se ofrecen archivos parciales.",
      });
      if (!mounted.current || controller.signal.aborted) return;
      const analyses = URL.createObjectURL(new Blob([result.analysesCsv], { type: "text/csv;charset=utf-8" }));
      resources.current.push(analyses);
      const dtcs = URL.createObjectURL(new Blob([result.dtcsCsv], { type: "text/csv;charset=utf-8" }));
      resources.current.push(dtcs);
      setUrls({ analyses, dtcs }); setStatus("ready");
      setMessage(`${result.analysesCount} análisis guardados y ${result.dtcCount} DTC registrados. Corte UTC: ${result.cutoff}`);
    } catch (error) {
      release();
      if (!mounted.current || controller.signal.aborted) return;
      if (onFailure(error, () => void prepare())) return;
      setStatus("error"); setMessage("No fue posible exportar todo el historial. No se ofrecen archivos parciales.");
    } finally { if (active.current === controller) active.current = null; }
  }
  return <section className="history-state" aria-labelledby="analytics-title">
    <h2 id="analytics-title">Exportación para Power BI</h2>
    <p>Solo tu historial guardado. Cuenta análisis, no vehículos únicos, reparaciones ni averías confirmadas. Descarga ambos archivos del mismo lote.</p>
    <button type="button" disabled={status === "loading"} onClick={() => void prepare()}>
      {status === "loading" ? "Preparando CSV…" : "Preparar CSV de mi historial"}
    </button>
    <p role={status === "error" ? "alert" : "status"}>{message}</p>
    {urls && <ul>
      <li><a href={urls.analyses} download="autodiag-analisis.csv">Descargar análisis CSV</a></li>
      <li><a href={urls.dtcs} download="autodiag-dtc.csv">Descargar DTC CSV</a></li>
    </ul>}
  </section>;
}
