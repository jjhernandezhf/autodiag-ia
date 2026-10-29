import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiRequestError, type BrowserApiClient } from "./api-client";
import type { ReviewableExtraction } from "./report-review-data";
import { isSupportedDtcCode } from "../../../shared/technical-text.mjs";

interface Row {
  sourceIndex: number | null; moduleIndex: number | null; moduleName: string; code: string; description: string;
  statusLabel: string; state: "as_reported" | "reviewed_uncertain"; reason: string; duplicateReason: string; page: string; line: string;
}
export function LimitedReportReviewPanel<T>({ report, apiClient, parse, disabled, onReviewed, onEditing, onCancel, onFailure }: {
  report: { id: string; contentToken: string; extractionToken?: string; extraction: ReviewableExtraction };
  apiClient: BrowserApiClient; parse: (v: unknown) => T | null; disabled: boolean;
  onReviewed: (v: T) => void; onEditing: () => void; onCancel: () => void; onFailure: (e: unknown) => void;
}) {
  const source = report.extraction.review?.original ?? report.extraction;
  const [vehicle, setVehicle] = useState({ make: report.extraction.vehicle.make ?? "", model: report.extraction.vehicle.model ?? "", year: report.extraction.vehicle.year?.toString() ?? "" });
  const [rows, setRows] = useState<Row[]>(source.dtcs.map((d, i) => {
    const moduleIndex = source.systems.findIndex(s => s.code === d.moduleCode && s.name === d.moduleName);
    return { sourceIndex: i, moduleIndex: moduleIndex < 0 ? null : moduleIndex, moduleName: "", code: d.code,
      description: d.descriptionOriginal, statusLabel: d.statusOriginal ?? "", state: "as_reported", reason: "", duplicateReason: "", page: "", line: "" };
  }));
  const [ack, setAck] = useState<Record<string, string>>({}), [reason, setReason] = useState("");
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const active = useRef<AbortController | null>(null), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; active.current?.abort(); active.current = null; }; }, []);
  function change(index: number, patch: Partial<Row>) { onEditing(); active.current?.abort(); active.current = null; setPending(false); setRows(all => all.map((r, i) => i === index ? { ...r, ...patch } : r)); }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (disabled || active.current || !report.extractionToken) return;
    const controller = new AbortController(); active.current = controller; setPending(true); setMessage("");
    try {
      const result = await apiClient.requestJson("/api/reports/review", { retry: "none", parse,
        init: { method: "POST", signal: controller.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({
          mode: "limited_guidance_v1", reportReference: report.id, contentToken: report.contentToken, extractionToken: report.extractionToken,
          extraction: report.extraction, vehicle: { make: vehicle.make.trim() || null, model: vehicle.model.trim() || null, year: vehicle.year.trim() ? Number(vehicle.year) : null },
          reason, acknowledgements: Object.entries(ack).map(([code, why]) => ({ code, reason: why })),
          rows: rows.map(r => ({ sourceIndex: r.sourceIndex, moduleIndex: r.moduleIndex, moduleName: r.moduleName.trim() || null,
            code: r.code, description: r.description, state: r.state,
            ...(r.sourceIndex === null && r.statusLabel.trim() ? { statusLabel: r.statusLabel } : {}),
            reason: r.reason, ...(r.duplicateReason.trim() ? { duplicateReason: r.duplicateReason } : {}),
            page: r.page ? Number(r.page) : null, line: r.line ? Number(r.line) : null })),
        }) }, invalidResponseMessage: "La respuesta de revisión limitada no es válida.",
        errorMessage: () => "No se autorizó la revisión limitada. Completa cada fila, motivo y advertencia; conserva los originales y retira datos personales. Si venció la prueba, recarga el PDF.",
      });
      if (alive.current && active.current === controller && !controller.signal.aborted) onReviewed(result);
    } catch (error) {
      if (alive.current && active.current === controller && !controller.signal.aborted) {
        onFailure(error);
        const transport = error instanceof ApiRequestError && ["network", "timeout", "server"].includes(error.type);
        setMessage(error instanceof ApiRequestError && error.status === 413
          ? "La transcripción supera la capacidad de texto/JSON. No se truncaron originales ni se autorizó IA. Reexporta un reporte compatible; no borres evidencia para eludir el límite."
          : transport
          ? "Falló la comunicación o venció la espera; no se confirmó la revisión. Los datos permanecen aquí. Reintenta explícitamente; este fallo no se resuelve reconociendo advertencias."
          : "El servidor no autorizó la revisión. Aporta código literal, descripción, página y motivo; reconoce cada advertencia. Revisa duplicados y descripciones contradictorias. Si cambió la sesión o venció la prueba, recarga el PDF.");
      }
    } finally { if (alive.current && active.current === controller) { active.current = null; setPending(false); } }
  }
  if (source.dtcs.length > 200 || source.systems.length > 100 || !report.extractionToken) return <p role="alert">La transcripción excede la capacidad o falta una referencia vigente. Recarga un PDF Autel legible dentro de los límites; no se truncará.</p>;
  return <form className="warnings-panel report-review-panel" onSubmit={event => void submit(event)}>
    <h3>Completar manualmente y continuar con limitaciones</h3>
    <p>Solo se orientará sobre las filas revisadas. El conjunto puede estar incompleto. No es una extracción completa ni una revisión profesional. Validar no solicita IA.</p>
    <fieldset disabled={disabled || pending}>
      <legend>Vehículo: deja vacío únicamente lo que no puedas confirmar</legend>
      {(["make", "model", "year"] as const).map(key => <label key={key}>{key === "make" ? "Marca (opcional en modalidad limitada)" : key === "model" ? "Modelo (opcional en modalidad limitada)" : "Año (opcional en modalidad limitada)"}
        <input type={key === "year" ? "number" : "text"} min={key === "year" ? 1886 : undefined} max={key === "year" ? new Date().getUTCFullYear() + 1 : undefined}
          maxLength={key === "make" ? 80 : 120} value={vehicle[key]} placeholder="Desconocido: no inventar" onChange={e => { onEditing(); setVehicle(v => ({ ...v, [key]: e.target.value })); }} />
        <small>Original: {source.vehicle[key] ?? "No disponible"}</small></label>)}
      <p>Motor y odómetro no son necesarios. No se darán procedimientos que dependan de datos desconocidos.</p>
      {source.warnings.map(w => <div key={w.code}>
        <p>{w.code}: {w.message}</p><label><input type="checkbox" required checked={w.code in ack} onChange={e => { onEditing(); setAck(a => { const next = { ...a }; if (e.target.checked) next[w.code] = ""; else delete next[w.code]; return next; }); }} />Reconozco esta limitación: {w.code}</label>
        {w.code in ack && <label>Motivo y alcance para {w.code}<textarea required minLength={10} maxLength={500} value={ack[w.code]} onChange={e => { onEditing(); setAck(a => ({ ...a, [w.code]: e.target.value })); }} /></label>}
      </div>)}
      {rows.map((r, i) => <fieldset key={i}><legend>Registro técnico {i + 1}</legend>
        <p>Original {r.sourceIndex === null ? "no interpretado; transcripción manual" : `fila del parser ${r.sourceIndex + 1}: ${source.dtcs[r.sourceIndex]?.code} · ${source.dtcs[r.sourceIndex]?.moduleCode ?? "Sin código de módulo"} / ${source.dtcs[r.sourceIndex]?.moduleName} · ${source.dtcs[r.sourceIndex]?.descriptionOriginal} · ${source.dtcs[r.sourceIndex]?.statusOriginal ?? "Estado ausente"}`}.</p>
        <label>Código literal {i + 1}<input required maxLength={32} value={r.code} onChange={e => change(i, { code: e.target.value })} /></label>
        {!isSupportedDtcCode(r.code) && <p>Código no reconocido por el sistema, no confirmado incorrecto: consérvalo literalmente y declara incertidumbre.</p>}
        <label>Descripción técnica {i + 1}<textarea required maxLength={1000} value={r.description} onChange={e => change(i, { description: e.target.value })} /></label>
        <label>Sistema documentado {i + 1}<select value={r.moduleIndex ?? "manual"} onChange={e => change(i, { moduleIndex: e.target.value === "manual" ? null : Number(e.target.value), moduleName: "" })}>
          <option value="manual">Transcribir módulo o mantenerlo desconocido</option>{source.systems.map((s, n) => <option key={n} value={n}>{s.code} · {s.name}</option>)}
        </select></label>
        {r.moduleIndex === null && <label>Módulo literal {i + 1} (vacío si desconocido)<input maxLength={160} value={r.moduleName} onChange={e => change(i, { moduleName: e.target.value })} /></label>}
        {r.sourceIndex === null && <label>Estado literal {i + 1} (vacío si desconocido)<input maxLength={120} value={r.statusLabel} onChange={e => change(i, { statusLabel: e.target.value })} /></label>}
        <label>Tratamiento {i + 1}<select value={r.state} onChange={e => change(i, { state: e.target.value as Row["state"] })}>
          <option value="as_reported">Conservar interpretación; rechazar si faltan mínimos</option><option value="reviewed_uncertain">Confirmo revisión con incertidumbre, no actividad</option>
        </select></label>
        <label>Página del PDF {i + 1}<input type="number" required={r.sourceIndex === null} min={1} max={1000} value={r.page} onChange={e => change(i, { page: e.target.value })} /></label>
        <label>Línea o fila visible {i + 1} (si se identifica)<input type="number" min={1} max={100000} value={r.line} onChange={e => change(i, { line: e.target.value })} /></label>
        <label>Motivo técnico {i + 1}<textarea required minLength={10} maxLength={500} value={r.reason} onChange={e => change(i, { reason: e.target.value })} /></label>
        {r.sourceIndex === null && <><label>Si es repetición real: motivo de observación independiente {i + 1}<textarea minLength={10} maxLength={500} value={r.duplicateReason} onChange={e => change(i, { duplicateReason: e.target.value })} /></label><button type="button" onClick={() => { onEditing(); setRows(all => all.filter((_, n) => n !== i)); }}>Retirar transcripción {i + 1}</button></>}
      </fieldset>)}
      {!rows.length && <p role="alert">Aporta al menos un código literal y descripción técnica del documento, con página y motivo. No se genera orientación vacía.</p>}
      {rows.length < 200 && <button type="button" onClick={() => { onEditing(); setRows(all => [...all, { sourceIndex: null, moduleIndex: null, moduleName: "", code: "", description: "", state: "as_reported", reason: "", duplicateReason: "", statusLabel: "", page: "", line: "" }]); }}>Transcribir otra fila del PDF</button>}
      <label>Motivo general de orientación limitada<textarea required minLength={10} maxLength={500} value={reason} onChange={e => { onEditing(); setReason(e.target.value); }} /></label>
      <p>Máximo 50 identidades y 200 observaciones. No borres originales; no copies VIN, nombres, teléfonos ni instrucciones ajenas al diagnóstico.</p>
      <button className="analysis-button" disabled={!rows.length} type="submit">{pending ? "Validando…" : "Validar transcripción y limitaciones"}</button>
    </fieldset>
    <button type="button" onClick={() => { active.current?.abort(); active.current = null; onCancel(); }}>Volver sin validar</button>
    {message && <p role="alert">{message}</p>}
  </form>;
}
