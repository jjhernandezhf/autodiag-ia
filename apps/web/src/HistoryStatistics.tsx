import { useEffect, useRef, useState } from "react";
import type { BrowserApiClient } from "./api-client";

interface Statistics {
  schemaVersion: number; cutoff: string; timeZone: string; totalAnalyses: number; dtcRecords: number; distinctCodes: number;
  dates: { date: string; count: number }[];
  vehicles: { make: string; model: string; count: number }[];
  codes: { code: string; count: number }[];
  modules: { moduleCode: string | null; moduleName: string; count: number }[];
  analyses: { id: string; date: string; make: string; model: string; year: number; dtcCount: number }[];
}
function parseStatistics(value: unknown): Statistics | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Statistics;
  const text = (s: unknown, max = 160) => typeof s === "string" && s.length > 0 && s.length <= max;
  const count = (n: unknown, max = 10_000) => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= max;
  const list = (items: unknown, max: number, valid: (row: Record<string, unknown>) => boolean) =>
    Array.isArray(items) && items.length <= max && items.every(row => row && typeof row === "object" && valid(row));
  if (v.schemaVersion !== 1 || v.timeZone !== "America/Guatemala" || !text(v.cutoff, 40) ||
    !count(v.totalAnalyses, 200) || !count(v.dtcRecords) || !count(v.distinctCodes) ||
    !list(v.dates, 200, r => text(r.date, 10) && count(r.count, 200)) ||
    !list(v.vehicles, 200, r => text(r.make, 80) && text(r.model, 120) && count(r.count, 200)) ||
    !list(v.codes, 10_000, r => text(r.code, 32) && count(r.count, 200)) ||
    !list(v.modules, 10_000, r => (r.moduleCode === null || text(r.moduleCode, 32)) && text(r.moduleName) && count(r.count, 200)) ||
    !list(v.analyses, 200, r => text(r.id, 36) && /^[0-9a-f-]{36}$/iu.test(r.id as string) &&
      text(r.date, 10) && text(r.make, 80) && text(r.model, 120) && count(r.year, 9999) && count(r.dtcCount, 500)) ||
    v.analyses.length !== v.totalAnalyses || v.analyses.reduce((s, r) => s + r.dtcCount, 0) !== v.dtcRecords ||
    v.dates.reduce((s, r) => s + r.count, 0) !== v.totalAnalyses ||
    v.vehicles.reduce((s, r) => s + r.count, 0) !== v.totalAnalyses || v.codes.length !== v.distinctCodes) return null;
  return v;
}
function Bars({ title, rows }: { title: string; rows: { label: string; count: number }[] }) {
  const maximum = Math.max(1, ...rows.map(row => row.count));
  return <section className="statistics-chart"><h2>{title}</h2>
    {!rows.length ? <p>Sin registros en esta selección.</p> : <ul>{rows.map((row, index) => <li key={index}>
      <span>{row.label}</span><strong>{row.count}</strong>
      <span className="statistics-bar" aria-hidden="true" style={{ width: `${100 * row.count / maximum}%` }} />
    </li>)}</ul>}
  </section>;
}
export function HistoryStatistics({ apiClient, onFailure, onOpen }: {
  apiClient: BrowserApiClient; onFailure: (error: unknown, retry: () => void) => boolean; onOpen: (id: string) => void;
}) {
  const [data, setData] = useState<Statistics | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "error" | "ready">("idle");
  const [filters, setFilters] = useState({ from: "", to: "", make: "", model: "" });
  const selection = useRef(filters);
  const generation = useRef(0);
  const active = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; active.current?.abort(); active.current = null; };
  }, []);
  async function load() {
    if (!mounted.current || active.current) return;
    const controller = new AbortController(); active.current = controller;
    const currentGeneration = ++generation.current;
    const isCurrent = () => mounted.current && !controller.signal.aborted &&
      active.current === controller && generation.current === currentGeneration;
    setData(null); setStatus("loading");
    // Global retry callbacks always read the current selection, never their render's filters.
    const query = new URLSearchParams(Object.entries(selection.current).filter(([, value]) => value !== ""));
    try {
      const result = await apiClient.requestJson(`/api/history/statistics?${query}`, {
        init: { signal: controller.signal }, timeoutMs: 15_000, retry: "none", parse: parseStatistics,
        errorMessage: () => "No fue posible obtener estadísticas completas.",
      });
      if (isCurrent()) { setData(result); setStatus("ready"); }
    } catch (error) {
      if (!isCurrent()) return;
      setStatus("error");
      onFailure(error, () => void load());
    } finally { if (active.current === controller) active.current = null; }
  }
  return <section className="upload-card" aria-labelledby="statistics-title">
    <h1 id="statistics-title">Estadísticas</h1>
    <p>Análisis guardados de tu cuenta. No representan vehículos únicos, reparaciones ni averías confirmadas.</p>
    <form className="statistics-filters" onSubmit={event => { event.preventDefault(); void load(); }}>
      {(["from", "to", "make", "model"] as const).map((key, index) => <label key={key}>
        {["Desde (Guatemala)", "Hasta (Guatemala)", "Marca exacta", "Modelo exacto"][index]}
        <input type={index < 2 ? "date" : "text"} maxLength={key === "make" ? 80 : 120} value={filters[key]}
          onChange={event => {
            generation.current++;
            active.current?.abort(); active.current = null;
            selection.current = { ...selection.current, [key]: event.target.value };
            setFilters(selection.current); setData(null); setStatus("idle");
          }} />
      </label>)}
      <button disabled={status === "loading"} type="submit">{status === "loading" ? "Consultando…" : "Consultar estadísticas"}</button>
    </form>
    <p>Fechas inclusivas en America/Guatemala. Hasta 200 análisis del historial completo y 10 000 registros DTC; si se supera el límite no se muestran datos parciales.</p>
    {status === "loading" && <p role="status">Cargando estadísticas…</p>}
    {status === "error" && <p role="alert">No fue posible obtener estadísticas completas. Puedes reintentar con Consultar estadísticas. Tu sesión y trabajo se conservan.</p>}
    {data && <>
      <p role="status">{data.totalAnalyses ? `Corte de consulta: ${data.cutoff}` : "No hay análisis guardados para esta selección."}</p>
      <div className="statistics-totals">
        <p>Análisis guardados <strong>{data.totalAnalyses}</strong></p>
        <p>Registros DTC <strong>{data.dtcRecords}</strong></p>
        <p>Códigos distintos <strong>{data.distinctCodes}</strong></p>
      </div>
      <p>Frecuencias de códigos y módulos: número de análisis distintos que los contienen. Código de módulo ausente se indica como “sin código”.</p>
      <div className="statistics-grid">
        <Bars title="Análisis por fecha" rows={data.dates.map(r => ({ label: r.date, count: r.count }))} />
        <Bars title="Análisis por marca y modelo" rows={data.vehicles.map(r => ({ label: `${r.make} / ${r.model}`, count: r.count }))} />
        <Bars title="DTC por frecuencia" rows={data.codes.map(r => ({ label: r.code, count: r.count }))} />
        <Bars title="Módulos presentes en análisis" rows={data.modules.map(r => ({ label: `${r.moduleCode ?? "sin código"} / ${r.moduleName}`, count: r.count }))} />
      </div>
      <div className="statistics-table"><table><caption>Análisis de la selección</caption>
        <thead><tr>{["Fecha Guatemala", "Marca", "Modelo", "Año", "DTC", "Consulta"].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead>
        <tbody>{data.analyses.map(row => <tr key={row.id}><td>{row.date}</td><td>{row.make}</td><td>{row.model}</td>
          <td>{row.year}</td><td>{row.dtcCount}</td><td><button type="button" onClick={() => onOpen(row.id)}>Abrir diagnóstico</button></td></tr>)}</tbody>
      </table></div>
    </>}
  </section>;
}
