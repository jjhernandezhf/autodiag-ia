import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { BrowserApiClient } from "./api-client";

interface Statistics {
  schemaVersion: number; cutoff: string; timeZone: string; totalAnalyses: number; dtcRecords: number; distinctCodes: number;
  dates: { date: string; count: number }[];
  vehicles: { make: string; model: string; count: number }[];
  codes: { code: string; count: number; descriptions?: {
    make: string; model: string; year: number | null; moduleCode: string | null; moduleName: string;
    description: string | null; analysisIds: string[];
  }[] }[];
  modules: { moduleCode: string | null; moduleName: string; count: number }[];
  analyses: { id: string; date: string; make: string; model: string; year: number | null; dtcCount: number }[];
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
    !list(v.codes, 10_000, r => text(r.code, 32) && count(r.count, 200) &&
      (r.descriptions === undefined || list(r.descriptions, 10_000, d =>
        text(d.make, 80) && text(d.model, 120) && (d.year === null || count(d.year, 9999)) &&
        (d.moduleCode === null || text(d.moduleCode, 32)) && text(d.moduleName) &&
        (d.description === null || text(d.description, 1000)) && Array.isArray(d.analysisIds) &&
        d.analysisIds.length <= 200 && d.analysisIds.every(id => typeof id === "string" && /^[0-9a-f-]{36}$/iu.test(id))))) ||
    !list(v.modules, 10_000, r => (r.moduleCode === null || text(r.moduleCode, 32)) && text(r.moduleName) && count(r.count, 200)) ||
    !list(v.analyses, 200, r => text(r.id, 36) && /^[0-9a-f-]{36}$/iu.test(r.id as string) &&
      text(r.date, 10) && text(r.make, 80) && text(r.model, 120) && (r.year === null || count(r.year, 9999)) && count(r.dtcCount, 500)) ||
    v.analyses.length !== v.totalAnalyses || v.analyses.reduce((s, r) => s + r.dtcCount, 0) !== v.dtcRecords ||
    v.dates.reduce((s, r) => s + r.count, 0) !== v.totalAnalyses ||
    v.vehicles.reduce((s, r) => s + r.count, 0) !== v.totalAnalyses || v.codes.length !== v.distinctCodes) return null;
  return v;
}
function Bars({ title, rows }: { title: string; rows: { label: string; count: number }[] }) {
  const [all, setAll] = useState(false);
  const maximum = Math.max(1, ...rows.map(row => row.count));
  return <section className="statistics-chart"><h2>{title}</h2>
    <p className="statistics-note">Análisis · escala 0–{maximum}{rows.length > 6 ? ` · ${all ? rows.length : 6} de ${rows.length} categorías` : ""}</p>
    {!rows.length ? <p>Sin registros en esta selección.</p> : <ul>{(all ? rows : rows.slice(0, 6)).map((row, index) => <li key={index}>
      <span>{row.label}</span><strong>{row.count}</strong>
      <span className="statistics-bar" aria-hidden="true" style={{ width: `${100 * row.count / maximum}%` }} />
    </li>)}</ul>}
    {rows.length > 6 && <button className="statistics-secondary" onClick={() => setAll(!all)}>{all ? "Ver principales" : `Ver todos (${rows.length})`}</button>}
  </section>;
}
function Timeline({ rows }: { rows: Statistics["dates"] }) {
  const max = Math.max(1, ...rows.map(row => row.count));
  const start = rows.length ? Date.parse(rows[0]!.date) : 0;
  const span = Math.max(86_400_000, rows.length ? Date.parse(rows.at(-1)!.date) - start : 0);
  const x = (date: string) => 48 + (Date.parse(date) - start) / span * 680;
  const y = (count: number) => 180 - count / max * 140;
  return <section className="statistics-chart statistics-timeline"><h2>Evolución de análisis</h2>
    <p className="statistics-note">Fecha de Guatemala · puntos observados; no se interpolan días sin registros.</p>
    {!rows.length ? <p>Sin registros.</p> : <>
      <svg viewBox="0 0 780 230" role="img" aria-label="Análisis por fecha; valores completos en la tabla desplegable">
        {[0, Math.ceil(max / 2), max].filter((n, i, a) => a.indexOf(n) === i).map(n => <g key={n}>
          <line x1="48" x2="740" y1={y(n)} y2={y(n)} stroke="#dce5ef" /><text x="35" y={y(n) + 4} textAnchor="end">{n}</text>
        </g>)}
        <line x1="48" x2="740" y1="180" y2="180" stroke="#6a7e94" />
        {rows.map(row => <circle key={row.date} cx={x(row.date)} cy={y(row.count)} r="5" fill="#1574b8" />)}
        <text x="48" y="205">{rows[0]!.date}</text>
        {rows.length > 1 && <text x="740" y="205" textAnchor="end">{rows.at(-1)!.date}</text>}
        <text x="390" y="225" textAnchor="middle">Fecha</text>
      </svg>
      <details><summary>Ver fechas y cantidades ({rows.length})</summary>
        <table><thead><tr><th>Fecha</th><th>Análisis</th></tr></thead><tbody>
          {rows.map(row => <tr key={row.date}><td>{row.date}</td><td>{row.count}</td></tr>)}
        </tbody></table>
      </details>
    </>}
  </section>;
}
function DtcList({ codes, onOpen }: { codes: Statistics["codes"]; onOpen: (id: string) => void }) {
  const [all, setAll] = useState(false);
  const maximum = Math.max(1, ...codes.map(code => code.count));
  return <section className="statistics-chart"><h2>DTC más frecuentes</h2>
    <p className="statistics-note">Análisis distintos por código · escala 0–{maximum} · {Math.min(all ? codes.length : 6, codes.length)} de {codes.length} códigos. Descripciones originales del reporte; no son definiciones universales.</p>
    <ul>{(all ? codes : codes.slice(0, 6)).map(code => <li className="statistics-dtc" key={code.code}>
      <strong>{code.code}</strong><strong>{code.count} análisis</strong>
      <div className="statistics-dtc-description">
        {!code.descriptions?.length ? <p>Descripción no disponible</p> : <>
          <p className="statistics-preview">{new Set(code.descriptions.map(d => d.description)).size > 1
            ? "La descripción varía según el contexto del reporte."
            : code.descriptions[0]!.description ?? "Descripción no disponible"}</p>
          <details><summary>Leer texto completo y contexto ({code.descriptions.length})</summary>
            {code.descriptions.map((d, index) => <div className="statistics-context" key={index}>
              <strong>{d.make} / {d.model} · {d.year ?? "Año no informado"} · {d.moduleCode ?? "sin código"} / {d.moduleName}</strong>
              <p>{d.description ?? "Descripción no disponible"}</p>
              <details><summary>Consultar análisis ({d.analysisIds.length})</summary>
                {d.analysisIds.map((id, i) => <button className="statistics-secondary" key={id} onClick={() => onOpen(id)}>Abrir diagnóstico {i + 1}</button>)}
              </details>
            </div>)}
          </details>
        </>}
      </div>
      <span className="statistics-bar" aria-hidden="true" style={{ width: `${100 * code.count / maximum}%` }} />
    </li>)}</ul>
    {codes.length > 6 && <button className="statistics-secondary" onClick={() => setAll(!all)}>{all ? "Ver principales" : `Ver todos (${codes.length})`}</button>}
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
  const initialLoad = useEffectEvent(() => { void load(); });
  useEffect(() => {
    mounted.current = true;
    let alive = true;
    queueMicrotask(() => { if (alive) initialLoad(); });
    return () => { alive = false; mounted.current = false; active.current?.abort(); active.current = null; };
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
  function reset() {
    generation.current++; active.current?.abort(); active.current = null;
    selection.current = { from: "", to: "", make: "", model: "" };
    setFilters(selection.current); setData(null); void load();
  }
  return <section className="statistics-dashboard" aria-labelledby="statistics-title">
    <header className="statistics-heading"><div><span className="eyebrow">TU HISTORIAL, EN PERSPECTIVA</span>
      <h1 id="statistics-title">Estadísticas</h1>
      <p>Análisis guardados, no vehículos únicos, reparaciones ni precisión diagnóstica.</p>
      <p className="statistics-note">{filters.from || filters.to ? `${filters.from || "Inicio del historial"} → ${filters.to || "Último registro"}` : "Todas las fechas"} · {filters.make || "Todas las marcas"} · {filters.model || "Todos los modelos"}</p>
    </div><button className="statistics-primary" disabled={status === "loading"} onClick={() => void load()}>Actualizar</button></header>
    <details className="statistics-filter-panel"><summary>Filtrar historial <span>Opcional</span></summary>
    <p id="statistics-name-help" className="statistics-note">Marca y modelo: nombre completo, sin distinguir mayúsculas/minúsculas ni espacios al inicio o al final. Vacío significa todos; no se admiten coincidencias parciales ni comodines.</p>
    <form className="statistics-filters" onSubmit={event => { event.preventDefault(); void load(); }}>
      {(["from", "to", "make", "model"] as const).map((key, index) => <label key={key}>
        {["Desde (Guatemala)", "Hasta (Guatemala)", "Marca exacta", "Modelo exacto"][index]}
        <input type={index < 2 ? "date" : "text"} maxLength={key === "make" ? 80 : 120} value={filters[key]}
          aria-describedby={index >= 2 ? "statistics-name-help" : undefined}
          onChange={event => {
            generation.current++;
            active.current?.abort(); active.current = null;
            selection.current = { ...selection.current, [key]: event.target.value };
            setFilters(selection.current); setData(null); setStatus("idle");
          }} />
      </label>)}
      <button className="statistics-primary" disabled={status === "loading"} type="submit">Aplicar filtros</button>
      <button className="statistics-secondary" type="button" onClick={reset}>Restablecer filtros</button>
    </form></details>
    <p className="statistics-note">Fechas de Guatemala. Límite: 200 análisis del historial completo y 10 000 registros DTC. Filtrar no evita este límite; nunca se muestran conjuntos parciales.</p>
    {status === "loading" && <p role="status">Cargando estadísticas…</p>}
    {status === "error" && <p className="statistics-error" role="alert">No fue posible obtener estadísticas completas. Puedes reintentar con Actualizar. Tu sesión y trabajo se conservan.</p>}
    {data && <>
      <p className="statistics-note">Última actualización: {new Intl.DateTimeFormat("es-GT", { timeZone: "America/Guatemala", dateStyle: "medium", timeStyle: "short" }).format(new Date(data.cutoff))} · Guatemala</p>
      {!data.totalAnalyses && <p role="status">No hay análisis guardados para esta selección.</p>}
      <div className="statistics-totals">
        <p>Análisis guardados <strong>{data.totalAnalyses}</strong></p>
        <p>Registros DTC <strong>{data.dtcRecords}</strong></p>
        <p>Códigos distintos <strong>{data.distinctCodes}</strong></p>
      </div>
      <p>Frecuencias de códigos y módulos: número de análisis distintos que los contienen. Código de módulo ausente se indica como “sin código”.</p>
      <Timeline rows={data.dates} />
      <div className="statistics-grid" key={data.cutoff + JSON.stringify(filters)}>
        <Bars title="Análisis por marca y modelo" rows={data.vehicles.map(r => ({ label: `${r.make} / ${r.model}`, count: r.count }))} />
        <DtcList codes={data.codes} onOpen={onOpen} />
        <Bars title="Módulos presentes en análisis" rows={data.modules.map(r => ({ label: `${r.moduleCode ?? "sin código"} / ${r.moduleName}`, count: r.count }))} />
      </div>
      <div className="statistics-table"><table><caption>Análisis de la selección</caption>
        <thead><tr>{["Fecha Guatemala", "Marca", "Modelo", "Año", "DTC", "Consulta"].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead>
        <tbody>{data.analyses.map(row => <tr key={row.id}><td>{row.date}</td><td>{row.make}</td><td>{row.model}</td>
          <td>{row.year ?? "No informado"}</td><td>{row.dtcCount}</td><td><button type="button" onClick={() => onOpen(row.id)}>Abrir diagnóstico</button></td></tr>)}</tbody>
      </table></div>
    </>}
  </section>;
}
