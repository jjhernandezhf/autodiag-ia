import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiRequestError, type BrowserApiClient } from "./api-client";
import type { ReviewableExtraction } from "./report-review-data";
import { isSupportedDtcCode, normalizeForMatch } from "../../../shared/technical-text.mjs";
import { LimitedReportReviewPanel } from "./LimitedReportReviewPanel";

interface Report { id: string; contentToken: string; extractionToken?: string; extraction: ReviewableExtraction }
interface Row { sourceIndex: number | null; moduleIndex: number; code: string; description: string;
  state: "as_reported" | "reviewed_uncertain"; statusLabel?: string; reason: string; duplicateReason?: string }
export function ReportReviewPanel<T>({ report, apiClient, disabled, parse, onReviewed, onEditing, onCancel, onFailure, reasons = [] }: {
  report: Report; apiClient: BrowserApiClient; disabled: boolean; parse: (value: unknown) => T | null;
  onReviewed: (value: T) => void; onEditing: () => void; onCancel: () => void; onFailure: (error: unknown) => void;
  reasons?: Array<{ code: string; message: string }>;
}) {
  const source = report.extraction.review?.original ?? report.extraction;
  const [limited, setLimited] = useState(false);
  const e = report.extraction;
  const missingVehicle = !e.vehicle.make || !e.vehicle.model || e.vehicle.year === null;
  const [open, setOpen] = useState(missingVehicle || e.requiresManualReview);
  const [vehicle, setVehicle] = useState({ make: e.vehicle.make ?? "", model: e.vehicle.model ?? "", year: e.vehicle.year?.toString() ?? "" });
  const [rows, setRows] = useState<Row[]>(e.dtcs.map((d, i) => ({ sourceIndex: i < source.dtcs.length ? i : null,
    moduleIndex: source.systems.findIndex(s => s.code === d.moduleCode && s.name === d.moduleName),
    code: d.code, description: d.descriptionOriginal, state: d.status === "reviewed_uncertain" ? "reviewed_uncertain" : "as_reported",
    reason: e.review?.decisions.find(decision => decision.path.startsWith(`rows.${i}.`))?.reason ?? "", ...(i >= source.dtcs.length && d.statusOriginal ? { statusLabel: d.statusOriginal } : {}),
    duplicateReason: e.review?.decisions.find(decision => decision.path === "extraction" && decision.after?.startsWith(`Fila ${i + 1}: observación independiente`))?.reason,
  })));
  const [reason, setReason] = useState(e.review?.reason ?? "");
  const [countUse, setCountUse] = useState<"reported" | "detail">(e.review?.decisions.some(d => d.path === "counts") ? "detail" : "reported");
  const [countsReason, setCountsReason] = useState(e.review?.decisions.find(d => d.path === "counts")?.reason ?? "");
  const [ack, setAck] = useState<Record<string, string>>(Object.fromEntries((e.review?.decisions ?? [])
    .filter(d => d.path === "extraction" && ["DTC_ROW_UNPARSED", "VEHICLE_IDENTITY_AMBIGUOUS"].includes(d.before ?? ""))
    .map(d => [d.before!, d.reason])));
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const active = useRef<AbortController | null>(null);
  const alive = useRef(true);
  useEffect(() => { if (disabled) active.current?.abort(); }, [disabled]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; active.current?.abort(); active.current = null; }; }, []);
  const countsDiffer = source.scanSummary.declaredDtcs !== source.dtcs.length || source.scanSummary.declaredSystems !== source.systems.length ||
    source.scanSummary.declaredDtcs !== rows.length || source.systems.some((s, i) => s.dtcCount !== source.dtcs.filter(d => d.moduleCode === s.code && d.moduleName === s.name).length || s.dtcCount !== rows.filter(r => r.moduleIndex === i).length);
  const zeroConfirmed = source.status === "completed" && !source.requiresManualReview && source.scanSummary.declaredDtcs === 0 && source.dtcs.length === 0 && !countsDiffer;
  const descriptionConflict = (index: number) => {
    const d = rows[index];
    return d && rows.some(other => other.code === d.code && other.moduleIndex === d.moduleIndex && normalizeForMatch(other.description) !== normalizeForMatch(d.description));
  };
  const rowChanged = (row: Row) => {
    const original = source.dtcs[row.sourceIndex ?? -1], module = source.systems[row.moduleIndex];
    return !original || original.code !== row.code || original.descriptionOriginal !== row.description ||
      original.moduleCode !== module?.code || original.moduleName !== module?.name || row.state === "reviewed_uncertain";
  };
  const rowIssues = (row: Row, index: number) => [
    ...(!isSupportedDtcCode(row.code) ? ["corrige el código no reconocido según el PDF"] : []),
    ...(!row.description.trim() ? ["completa la descripción literal"] : []),
    ...(row.moduleIndex < 0 ? ["selecciona el módulo documentado"] : []),
    ...((source.dtcs[row.sourceIndex ?? -1]?.status === "unknown" || e.dtcs[index]?.status === "unknown") && row.state !== "reviewed_uncertain" ? ["revisa explícitamente el estado incierto"] : []),
    ...(descriptionConflict(index) ? ["resuelve las descripciones contradictorias con evidencia"] : []),
    ...(rowChanged(row) && row.reason.trim().length < 10 ? ["registra un motivo de al menos 10 caracteres"] : []),
  ];
  const structuralWarnings = e.warnings.filter(w => ["VEHICLE_SECTION_MISSING", "SYSTEMS_SECTION_MISSING", "DTC_SECTION_MISSING", "SYSTEM_ROW_UNPARSED", "VIN_INVALID", "VIN_MULTIPLE_CANDIDATES"].includes(w.code));
  function changeRow(index: number, patch: Partial<Row>) {
    onEditing(); setRows(current => current.map((r, i) => i === index ? { ...r, ...patch } : r));
  }
  function cancel() {
    active.current?.abort(); active.current = null; setPending(false); setOpen(false); setMessage(""); onCancel();
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || active.current || !report.extractionToken) return;
    const controller = new AbortController(); active.current = controller; setPending(true); setMessage("");
    try {
      const value = await apiClient.requestJson("/api/reports/review", {
        init: { method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
          body: JSON.stringify({ reportReference: report.id, contentToken: report.contentToken, extractionToken: report.extractionToken,
            extraction: e, vehicle: { make: vehicle.make, model: vehicle.model, year: vehicle.year.trim() ? Number(vehicle.year) : null },
            rows: rows.map(r => ({ ...r, ...(r.reason.trim() ? { reason: r.reason } : { reason: undefined }), statusLabel: r.statusLabel?.trim() || undefined, duplicateReason: r.duplicateReason?.trim() || undefined })), reason,
            ...(countUse === "detail" ? { countsDecision: { use: countUse, reason: countsReason } } : {}),
            reviewedWarnings: Object.entries(ack).map(([code, why]) => ({ code, reason: why })),
          }) }, retry: "none", parse,
        invalidResponseMessage: "No se pudo validar la revisión del reporte.",
        errorMessage: () => "Revisión no válida. Comprueba las correcciones y sus motivos. Si venció la referencia, vuelve a cargar el PDF.",
      });
      if (alive.current && active.current === controller && !controller.signal.aborted) onReviewed(value);
    } catch (error) {
      if (!alive.current || active.current !== controller || controller.signal.aborted) return;
      onFailure(error);
      setMessage(error instanceof ApiRequestError && error.status === 413
        ? "La revisión supera el tamaño permitido. No se truncaron filas ni evidencia; este reporte requiere un procesamiento fuera de la capacidad actual."
        : "No se pudo validar la revisión. Revisa los datos, los motivos y la conexión. Si la referencia venció, vuelve a cargar el PDF.");
    } finally {
      if (alive.current && active.current === controller) { active.current = null; setPending(false); }
    }
  }
  if (!report.extractionToken || source.dtcs.length > 200 || source.systems.length > 100) return <p>La revisión local no está disponible para esta referencia o excede su capacidad (200 observaciones o 100 sistemas). Vuelve a cargar un reporte Autel legible dentro de los límites; no se generará un análisis parcial.</p>;
  if (limited) return <LimitedReportReviewPanel report={report} apiClient={apiClient} parse={parse} disabled={disabled} onReviewed={onReviewed} onEditing={onEditing} onFailure={onFailure} onCancel={() => { setLimited(false); onCancel(); }} />;
  const contingency = !zeroConfirmed && <button type="button" className="analysis-button" disabled={disabled || pending} onClick={() => { onEditing(); setLimited(true); }}>Completar manualmente y continuar con limitaciones</button>;
  if (!open) return <><button type="button" className="analysis-button" disabled={disabled} onClick={() => { onEditing(); setOpen(true); }}>Revisar o corregir datos</button>{contingency}</>;
  const vehicleFields = <div className="review-grid" id="review-vehicle" tabIndex={-1}>{(["make", "model", "year"] as const).map(key =>
    <label key={key}>{key === "make" ? "Marca confirmada" : key === "model" ? "Modelo confirmado" : "Año confirmado"}
      <input aria-label={key === "make" ? "Marca confirmada" : key === "model" ? "Modelo confirmado" : "Año confirmado"} type={key === "year" ? "number" : "text"} value={vehicle[key]} required
        min={key === "year" ? 1886 : undefined} max={key === "year" ? new Date().getUTCFullYear() + 1 : undefined}
        maxLength={key === "make" ? 80 : 120} onChange={event => { onEditing(); setVehicle(v => ({ ...v, [key]: event.target.value })); }} />
      <small>Original: {source.vehicle[key] ?? "No indicado"}</small>
    </label>)}</div>;
  return <form className="warnings-panel vehicle-confirmation report-review-panel" onSubmit={event => void submit(event)}>
    <h3>Revisión manual del reporte</h3>
    {contingency}
    <p>Corrige solo con evidencia del documento o del vehículo. Se conservan los originales y tus motivos; no es una validación profesional ni se genera IA automáticamente.</p>
    <section aria-label="Bloqueos y acciones disponibles">
      <h4>Qué revisar antes de analizar</h4>
      <ul>
        {(missingVehicle || source.warnings.some(w => ["VEHICLE_IDENTITY_UNREADABLE", "VEHICLE_IDENTITY_AMBIGUOUS"].includes(w.code))) && <li><a href="#review-vehicle">Completa o confirma marca, modelo y año con documentación del vehículo.</a> Registra el motivo general; motor y odómetro son opcionales.</li>}
        {rows.map((row, i) => { const issues = rowIssues(row, i); return issues.length ? <li key={i}><a href={`#review-row-${i}`}>Fila {i + 1}: {issues.join("; ")}.</a> Registra el motivo de la fila.</li> : null; })}
        {countsDiffer && <li><a href="#review-counts">Compara resumen, filas originales y detalle revisado; elige explícitamente los conteos usados y explica la discrepancia.</a></li>}
        {source.warnings.some(w => w.code === "DTC_ROW_UNPARSED") && <li><a href="#review-reconstruction">Revisa las filas no interpretadas: corrige la fila conservada; añade una fila solo si realmente falta.</a> Confirma la comprobación contra el PDF y su motivo.</li>}
        {reasons.filter(r => ["ANALYSIS_LIMIT_EXCEEDED", "SENSITIVE_CONTENT_DETECTED"].includes(r.code)).map(r => <li key={r.code}>{r.message} {r.code === "ANALYSIS_LIMIT_EXCEEDED" ? "El máximo es 50 identidades código/módulo y 200 observaciones. Corrige solo errores verificables; si el total real excede el máximo, usa otro reporte compatible, sin truncar este." : "Exporta nuevamente un reporte técnico sin información personal en sus textos."}</li>)}
      </ul>
      {structuralWarnings.map(w => <p key={w.code} role="alert">{w.message} Para una extracción completa, vuelve a exportar un reporte Autel compatible. Para orientar solo sobre registros que puedas transcribir, usa “Completar manualmente y continuar con limitaciones”; el impedimento permanecerá documentado, sin inventar módulos ni declarar completo el reporte.</p>)}
      <p>Después de validar, el servidor recalculará la elegibilidad y mostrará los impedimentos que permanezcan. Corregir no solicita IA.</p>
    </section>
    {e.warnings.filter(w => !["ENGINE_NOT_PROVIDED", "ODOMETER_NOT_PROVIDED", "ODOMETER_UNIT_NOT_PROVIDED"].includes(w.code)).map(w => <p key={w.code}>{w.message}</p>)}
    <fieldset disabled={pending || disabled}>
      {missingVehicle || source.warnings.some(w => w.code === "VEHICLE_IDENTITY_AMBIGUOUS") ? vehicleFields : <details><summary>Corregir identidad del vehículo</summary>{vehicleFields}</details>}
      <p>Motor y odómetro son opcionales. No reconstruyas datos desde el VIN ni desde el nombre del archivo.</p>
      {rows.map((row, index) => {
        const original = source.dtcs[row.sourceIndex ?? -1];
        const originalProblem = !!original && (original.status === "unknown" || !original.descriptionOriginal.trim() || !isSupportedDtcCode(original.code) ||
          !source.systems.some(s => s.code === original.moduleCode && s.name === original.moduleName));
        return <details key={index} id={`review-row-${index}`} tabIndex={-1} open={originalProblem || rowChanged(row) || descriptionConflict(index)} className="review-row">
          <summary>Fila {index + 1}: {original?.code || "Código no interpretado"} · {original?.moduleName ?? "Añadida por usuario"} · {original?.statusOriginal ?? "Estado no indicado"}</summary>
          <p>Descripción original: {original?.descriptionOriginal || "No interpretada"}</p>
          <p>Módulo original: {original ? `${original.moduleCode ?? "Sin código"} · ${original.moduleName}` : "No interpretado; fila añadida por el usuario"}</p>
          {!isSupportedDtcCode(original?.code ?? row.code) && <p role="note">Código no interpretado: reconstruye esta misma fila según el PDF; no añadas una copia ni inventes un código equivalente.</p>}
          {row.moduleIndex < 0 && <p role="note">Módulo no asociado: selecciona uno de los sistemas documentados. Si el sistema falta en la lista, vuelve a exportar el reporte completo.</p>}
          {descriptionConflict(index) && <p role="note">Esta identidad aparece con descripciones diferentes. Revisa las observaciones relacionadas; no se seleccionará una descripción arbitrariamente.</p>}
          {original?.status === "unknown" && <p role="note">Estado sin interpretación confirmada: conserva el bloqueo o revisa expresamente la incertidumbre. No se convertirá en activo.</p>}
          <div className="review-grid">
            <label>Código efectivo, fila {index + 1}<input required maxLength={32} value={row.code} onChange={event => changeRow(index, { code: event.target.value })} /></label>
            <label>Módulo efectivo, fila {index + 1}<select required value={row.moduleIndex} onChange={event => changeRow(index, { moduleIndex: Number(event.target.value) })}>
              <option value={-1}>Selecciona el módulo documentado</option>{source.systems.map((s, i) => <option key={i} value={i}>{s.code ? `${s.code} · ` : ""}{s.name}</option>)}
            </select></label>
          </div>
          <label>Descripción efectiva, fila {index + 1}<textarea required maxLength={1000} value={row.description} onChange={event => changeRow(index, { description: event.target.value })} /></label>
          {row.sourceIndex === null && <label>Estado literal de la fila añadida (si existe)<input required={row.state === "as_reported"} maxLength={120} value={row.statusLabel ?? ""} onChange={event => changeRow(index, { statusLabel: event.target.value })} /><small>Si no consta o no se conoce su interpretación, declara incertidumbre y explica el motivo; no inventes un estado.</small></label>}
          {row.sourceIndex === null && <label>Si repite otra fila: evidencia de observación independiente<textarea minLength={10} maxLength={500} value={row.duplicateReason ?? ""} onChange={event => changeRow(index, { duplicateReason: event.target.value })} /><small>Solo completa este motivo si el PDF contiene otra observación igual. No se aceptará una copia accidental.</small></label>}
          <label>Tratamiento del estado, fila {index + 1}<select value={row.state} onChange={event => changeRow(index, { state: event.target.value as Row["state"] })}>
            <option value="as_reported">Conservar interpretación disponible; bloquear si no se conoce</option>
            <option value="reviewed_uncertain">Orientar con incertidumbre revisada, sin afirmar actividad ni historia</option>
          </select></label>
          <label>Motivo/evidencia de la corrección, fila {index + 1}<textarea required={rowChanged(row)} minLength={10} maxLength={500} value={row.reason} onChange={event => changeRow(index, { reason: event.target.value })} /></label>
          {row.sourceIndex === null && index >= e.dtcs.length && <button type="button" onClick={() => { onEditing(); setRows(r => r.filter((_, i) => i !== index)); }}>Eliminar fila añadida {index + 1}</button>}
        </details>;
      })}
      <div id="review-reconstruction" tabIndex={-1}>
        {!zeroConfirmed && <p>{rows.length}/200 observaciones revisadas. La validación admite hasta 50 identidades código/módulo, sin truncamiento.</p>}
        {!zeroConfirmed && <p>Compara las filas con el PDF. Si una ya aparece arriba, corrígela allí; no la vuelvas a añadir. Los originales no se pueden eliminar.</p>}
        {!zeroConfirmed && rows.length < 200 && <button type="button" onClick={() => { onEditing(); setRows(r => [...r, { sourceIndex: null, moduleIndex: -1, code: "", description: "", state: "as_reported", reason: "" }]); }}>Añadir fila omitida según el PDF</button>}
      </div>
      {(countsDiffer || rows.length !== source.dtcs.length) && <div className="review-counts" id="review-counts" tabIndex={-1}>
        <p>Resumen original: {source.scanSummary.declaredDtcs ?? "?"} filas declaradas. Detalle interpretado: {source.dtcs.length}. No se cambiarán sin una decisión explícita.</p>
        <p>Filas del detalle revisado: {rows.length}.</p>
        <ul>{source.systems.map((s, i) => <li key={i}>{s.name}: resumen {s.dtcCount}; detalle original {source.dtcs.filter(d => d.moduleCode === s.code && d.moduleName === s.name).length}; detalle revisado {rows.filter(r => r.moduleIndex === i).length}</li>)}</ul>
        <label>Versión de conteos utilizada<select value={countUse} onChange={event => { onEditing(); setCountUse(event.target.value as "reported" | "detail"); }}>
          <option value="reported">Conservar resumen original; bloquear si no coincide</option><option value="detail">Usar el detalle revisado; conservar discrepancia original</option>
        </select></label>
        {countUse === "detail" && <label>Motivo de reconciliación<textarea required minLength={10} maxLength={500} value={countsReason} onChange={event => { onEditing(); setCountsReason(event.target.value); }} /></label>}
      </div>}
      {source.warnings.filter(w => ["DTC_ROW_UNPARSED", "VEHICLE_IDENTITY_AMBIGUOUS"].includes(w.code)).map(w => <div key={w.code}>
        <label><input type="checkbox" checked={w.code in ack} onChange={event => { onEditing(); setAck(a => { const next = { ...a }; if (event.target.checked) next[w.code] = ""; else delete next[w.code]; return next; }); }} />Verifiqué y resolví en los campos anteriores: {w.message}</label>
        {w.code in ack && <label>Evidencia para {w.code}<textarea required minLength={10} maxLength={500} value={ack[w.code]} onChange={event => { onEditing(); setAck(a => ({ ...a, [w.code]: event.target.value })); }} /></label>}
      </div>)}
      <label>Motivo general y evidencia consultada<textarea required minLength={10} maxLength={500} value={reason} onChange={event => { onEditing(); setReason(event.target.value); }} /></label>
      <button className="analysis-button" type="submit">{pending ? "Validando revisión…" : "Validar revisión del reporte"}</button>
    </fieldset>
    <button type="button" className="analysis-button" onClick={cancel}>Cancelar edición</button>
    {message && <p role="alert">{message}</p>}
  </form>;
}
