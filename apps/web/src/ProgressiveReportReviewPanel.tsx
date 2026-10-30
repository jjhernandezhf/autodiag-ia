import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiRequestError, type BrowserApiClient } from "./api-client";
import type { ReviewableExtraction } from "./report-review-data";
import { isSupportedDtcCode, isLiteralDtcCode, normalizeForMatch } from "../../../shared/technical-text.mjs";

type Patch = { sourceIndex: number; action?: "use" | "omit"; code?: string | null; description?: string | null;
  moduleName?: string | null; moduleCode?: string | null; statusOriginal?: string | null };
type Extra = { code: string; description: string; moduleName: string; statusOriginal: string; duplicate?: "separate_observation" };
export function ProgressiveReportReviewPanel<T>({ report, available, apiClient, parse, disabled, onReviewed, onEditing, onCancel, onFailure }: {
  report: { id: string; contentToken: string; extractionToken?: string; extraction: ReviewableExtraction };
  available: boolean; apiClient: BrowserApiClient; parse: (value: unknown) => T | null; disabled: boolean;
  onReviewed: (value: T) => void; onEditing: () => void; onCancel: () => void; onFailure: (error: unknown) => void;
}) {
  const e = report.extraction, original = e.review?.original ?? e;
  const [patches, setPatches] = useState<Record<number, Patch>>({});
  const [vehicle, setVehicle] = useState<Partial<Record<"make" | "model" | "year", string>>>({});
  const [extras, setExtras] = useState<Extra[]>([]), [editOther, setEditOther] = useState(false);
  const [notes, setNotes] = useState(e.review?.limited?.userNotes ?? ""), [notesChanged, setNotesChanged] = useState(false);
  const [pending, setPending] = useState(false), [message, setMessage] = useState("");
  const active = useRef<AbortController | null>(null), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; active.current?.abort(); active.current = null; }; }, []);
  const currentRow = (index: number) => {
    const positions = e.review?.limited?.positions;
    const currentIndex = positions ? positions.find(p => (p.sourceIndex === undefined ? (p.provenance === "parser_row_reviewed" ? p.rowIndex : null) : p.sourceIndex) === index)?.rowIndex : index;
    return currentIndex === undefined ? original.dtcs[index]! : e.dtcs[currentIndex] ?? original.dtcs[index]!;
  };
  const rows = original.dtcs.map((_row, i) => {
    const base = currentRow(i), patch = patches[i];
    return { ...base, code: patch?.code === undefined ? base.code : patch.code ?? "", descriptionOriginal: patch?.description === undefined ? base.descriptionOriginal : patch.description ?? "",
      moduleCode: patch?.moduleCode === undefined ? base.moduleCode : patch.moduleCode, moduleName: patch?.moduleName === undefined ? base.moduleName : patch.moduleName ?? "" };
  });
  const conflicted = (i: number) => rows.some((r, n) => n !== i && r.code === rows[i]!.code && r.moduleCode === rows[i]!.moduleCode && r.moduleName === rows[i]!.moduleName && normalizeForMatch(r.descriptionOriginal) !== normalizeForMatch(rows[i]!.descriptionOriginal));
  const omitted = new Set(e.review?.limited?.omittedRows?.map(r => r.sourceIndex) ?? []);
  const retainedExtras = e.review ? e.dtcs.filter((_row, index) => e.review?.limited?.positions
    ? e.review.limited.positions.some(p => p.rowIndex === index && (p.sourceIndex === null || (p.sourceIndex === undefined && p.provenance === "manual_transcription")))
    : index >= original.dtcs.length) : [];
  const pendingRows = rows.flatMap((r, i) => patches[i] || !r.code || !r.descriptionOriginal.trim() || !isSupportedDtcCode(r.code) || r.status === "unknown" ||
    !original.systems.some(s => s.code === r.moduleCode && s.name === r.moduleName) || conflicted(i) || omitted.has(i) ? [i] : []);
  const zero = original.status === "completed" && !original.requiresManualReview && !original.dtcs.length && original.scanSummary.declaredDtcs === 0 && original.scanSummary.parsedDtcs === 0 &&
    original.scanSummary.declaredSystems === original.systems.length && original.scanSummary.parsedSystems === original.systems.length && original.systems.every(s => !s.dtcCount);
  const changed = Object.keys(patches).length > 0 || Object.keys(vehicle).length > 0 || extras.length > 0 || notesChanged;
  const selected = rows.filter((r, i) => patches[i]?.action !== "omit" && (!omitted.has(i) || patches[i]) && isLiteralDtcCode(r.code) && !!r.descriptionOriginal.trim());
  const identities = new Set([...selected.map(r => JSON.stringify([r.code, r.moduleCode, r.moduleName || `sin_módulo_${rows.indexOf(r)}`])),
    ...retainedExtras.map(r => JSON.stringify([r.code, r.moduleCode, r.moduleName])),
    ...extras.filter(r => r.code.trim() && r.description.trim()).map(r => JSON.stringify([r.code, null, r.moduleName || "Módulo no confirmado"]))]).size;
  const overLimit = identities > 50;
  function patch(index: number, value: Partial<Patch>) { onEditing(); setPatches(all => ({ ...all, [index]: { ...all[index], sourceIndex: index, action: "use", ...value } })); }
  const vehicleValue = (key: "make" | "model" | "year") => vehicle[key] ?? (e.vehicle[key]?.toString() ?? "");
  const usable = retainedExtras.length > 0 || selected.length > 0 || extras.some(r => isLiteralDtcCode(r.code) && !!r.description.trim());
  async function submit(event: FormEvent) {
    event.preventDefault(); if (disabled || active.current || !report.extractionToken) return;
    const controller = new AbortController(); active.current = controller; setPending(true); setMessage("");
    onEditing();
    try {
      const result = await apiClient.requestJson("/api/reports/review", { retry: "none", parse, init: { method: "POST", signal: controller.signal,
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "progressive_review_v1", reportReference: report.id,
          contentToken: report.contentToken, extractionToken: report.extractionToken, extraction: e,
          ...(Object.keys(vehicle).length ? { vehicle: Object.fromEntries(Object.entries(vehicle).map(([key, value]) => [key, value.trim() ? key === "year" ? Number(value) : value.trim() : null])) } : {}),
          actions: Object.values(patches), additionalRows: extras.map(r => ({ code: r.code, description: r.description, moduleName: r.moduleName.trim() || null,
            statusOriginal: r.statusOriginal.trim() || null, ...(r.duplicate ? { duplicate: r.duplicate } : {}) })), ...(notesChanged ? { notes } : {}),
        }) }, invalidResponseMessage: "No se pudo validar la revisión progresiva.", errorMessage: () => "Comprueba código y descripción de al menos una fila útil, límites y referencia vigente. No necesitas escribir motivos." });
      if (alive.current && active.current === controller && !controller.signal.aborted) onReviewed(result);
    } catch (error) {
      if (!alive.current || active.current !== controller || controller.signal.aborted) return;
      onFailure(error);
      setMessage(error instanceof ApiRequestError && ["timeout", "network", "server"].includes(error.type)
        ? "Falló la comunicación; tus cambios siguen aquí. Reintenta explícitamente. No se resolvió ignorando datos."
        : "No se pudo autorizar. Completa código y descripción de alguna fila útil; revisa duplicados, contradicciones y límites. Recarga el PDF si venció la referencia. No inventes datos ni motivos.");
    } finally { if (alive.current && active.current === controller) { active.current = null; setPending(false); } }
  }
  if (!report.extractionToken || original.dtcs.length > 200 || original.systems.length > 100) return <p role="alert">Recarga un reporte legible dentro de los límites para obtener una referencia vigente. No se truncarán originales.</p>;
  if (zero) return <p>Escaneo completo con cero DTC: no hace falta revisión ni generación IA.</p>;
  const editor = <form className="warnings-panel report-review-panel" onSubmit={event => void submit(event)}>
    <h3>{available ? "Edición opcional de datos extraídos" : "Revisión mínima de datos pendientes"}</h3>
    <p>Se conserva automáticamente lo extraído. Puedes completar lo pendiente o continuar con limitaciones, sin escribir motivos.</p>
    {available && !changed && <p>Los datos técnicos ya están disponibles. No necesitas volver a confirmarlos.</p>}
    <fieldset disabled={pending || disabled}>
      <p>{identities}/50 identidades seleccionadas; máximo 200 observaciones originales y aportadas, sin truncamiento.</p>
      {overLimit && <p role="alert">Selecciona explícitamente qué filas dejar fuera hasta no superar 50 identidades. No se escogerán automáticamente las primeras 50; todos los originales se conservan.</p>}
      {(["make", "model", "year"] as const).filter(key => e.vehicle[key] === null || editOther).map(key => <label key={key}>
        {key === "make" ? "Marca (opcional)" : key === "model" ? "Modelo (opcional)" : "Año (opcional)"}
        <input type={key === "year" ? "number" : "text"} min={key === "year" ? 1886 : undefined} max={key === "year" ? new Date().getUTCFullYear() + 1 : undefined}
          maxLength={key === "make" ? 80 : 120} placeholder="Desconocido: puedes continuar sin este dato" value={vehicleValue(key)}
          onChange={event => { onEditing(); setVehicle(v => ({ ...v, [key]: event.target.value })); }} />
      </label>)}
      {original.warnings.filter(w => !["VIN_NOT_PROVIDED", "ENGINE_NOT_PROVIDED", "ODOMETER_NOT_PROVIDED", "ODOMETER_UNIT_NOT_PROVIDED"].includes(w.code)).map(w => <p key={w.code}>{w.message} Se conservará como limitación si continúa pendiente.</p>)}
      {!!omitted.size && <p>{omitted.size} filas permanecen fuera de la orientación y se conservan en los originales. Puedes completarlas y volver a incluirlas.</p>}
      {(editOther || overLimit ? rows.map((_r, i) => i) : pendingRows).map(i => {
        const r = rows[i]!, base = original.dtcs[i]!;
        return <section key={i} aria-label={`Pendientes de fila ${i + 1}`}>
          <h4>Fila {i + 1}: {base.code || "Código no interpretado"} · {base.moduleCode} {base.moduleName}</h4>
          <p>Original: {base.descriptionOriginal || "Descripción no recuperada"} · {base.statusOriginal ?? "Estado desconocido"}</p>
          {(!isSupportedDtcCode(currentRow(i).code) || patches[i]?.code !== undefined || editOther) && <label>Código literal, fila {i + 1} (opcional)<input maxLength={32} value={r.code} onChange={event => patch(i, { code: event.target.value || null })} /></label>}
          {(!currentRow(i).descriptionOriginal.trim() || patches[i]?.description !== undefined || conflicted(i) || editOther) && <label>Descripción, fila {i + 1} (opcional)<textarea maxLength={1000} value={r.descriptionOriginal} onChange={event => patch(i, { description: event.target.value || null })} /></label>}
          {!isSupportedDtcCode(r.code) && <p>No reconocido por el sistema no significa incorrecto. Se conserva el literal con incertidumbre; si no hay código legible, la fila queda fuera.</p>}
          {(!r.descriptionOriginal.trim() || !isLiteralDtcCode(r.code)) && <p>Si no aportas código legible y descripción, esta fila quedará fuera de la orientación, no de los originales.</p>}
          {(r.status === "unknown" || editOther) && <><p>Estado sin confirmar: no se convertirá en activo. No tienes que reescribirlo.</p><label>Estado literal, fila {i + 1} (opcional)<input maxLength={120} value={patches[i]?.statusOriginal ?? r.statusOriginal ?? ""} onChange={event => patch(i, { statusOriginal: event.target.value || null })} /></label></>}
          {(!original.systems.some(s => s.code === r.moduleCode && s.name === r.moduleName) || patches[i]?.moduleName !== undefined || patches[i]?.moduleCode !== undefined || editOther) && <>
            <label>Módulo, fila {i + 1} (opcional)<input maxLength={160} value={r.moduleName} onChange={event => patch(i, { moduleName: event.target.value || null })} /></label>
            <label>Código de módulo, fila {i + 1} (opcional)<input maxLength={32} value={r.moduleCode ?? ""} onChange={event => patch(i, { moduleCode: event.target.value || null })} /></label>
          </>}
          {conflicted(i) && <p>Descripciones contradictorias para esta identidad: puedes corregirlas o dejar fuera una observación. Mientras no se resuelva, ese grupo queda fuera.</p>}
          <label><input type="checkbox" checked={patches[i]?.action === "omit" || (!patches[i] && omitted.has(i))} onChange={event => patch(i, { action: event.target.checked ? "omit" : "use" })} />Dejar la fila {i + 1} fuera de la orientación (conservar original)</label>
        </section>;
      })}
      {extras.map((row, index) => <section key={index} aria-label={`Aporte nuevo ${index + 1}`}>
        <label>Código nuevo {index + 1}<input required maxLength={32} value={row.code} onChange={event => { onEditing(); setExtras(all => all.map((r, i) => i === index ? { ...r, code: event.target.value } : r)); }} /></label>
        <label>Descripción nueva {index + 1}<textarea required maxLength={1000} value={row.description} onChange={event => { onEditing(); setExtras(all => all.map((r, i) => i === index ? { ...r, description: event.target.value } : r)); }} /></label>
        <label>Módulo nuevo {index + 1} (opcional)<input maxLength={160} value={row.moduleName} onChange={event => { onEditing(); setExtras(all => all.map((r, i) => i === index ? { ...r, moduleName: event.target.value } : r)); }} /></label>
        <label>Estado nuevo {index + 1} (opcional)<input maxLength={120} value={row.statusOriginal} onChange={event => { onEditing(); setExtras(all => all.map((r, i) => i === index ? { ...r, statusOriginal: event.target.value } : r)); }} /></label>
        <label><input type="checkbox" checked={!!row.duplicate} onChange={event => { onEditing(); setExtras(all => all.map((r, i) => i === index ? { ...r, duplicate: event.target.checked ? "separate_observation" : undefined } : r)); }} />Es una observación adicional independiente, aunque repita otra fila</label>
        <button type="button" onClick={() => { onEditing(); setExtras(all => all.filter((_r, i) => i !== index)); }}>Retirar aporte nuevo {index + 1}</button>
      </section>)}
      <details><summary>Aportar información no recuperada (opcional)</summary>
        <p>Transcribe solo lo que realmente falta. Para una fila nueva hacen falta código y descripción; no páginas ni motivos.</p>
        {original.dtcs.length + retainedExtras.length + extras.length < 200 && <button type="button" onClick={() => { onEditing(); setExtras(all => [...all, { code: "", description: "", moduleName: "", statusOriginal: "" }]); }}>Añadir una fila no recuperada</button>}
      </details>
      <button type="button" onClick={() => setEditOther(v => !v)}>{editOther ? "Mostrar solo pendientes" : "Editar otro dato"}</button>
      <details><summary>Nota adicional (opcional)</summary><textarea aria-label="Nota adicional (opcional)" maxLength={300} value={notes} onChange={event => { onEditing(); setNotes(event.target.value); setNotesChanged(true); }} /></details>
      {!usable && <p role="alert">Mínimo pendiente: código literal y descripción técnica de al menos una fila útil. Solo síntomas no habilitan el contrato de orientación por DTC; no se inventarán códigos ni se llamará IA.</p>}
      {(!available || changed) && <><p>Continuar acepta únicamente la información disponible y las limitaciones visibles. Se conservarán desconocidos y filas omitidas; no se declara completo el reporte.</p>
        <button type="submit" className="analysis-button" disabled={!usable || overLimit}>{pending ? "Validando…" : "Continuar con la información disponible"}</button></>}
    </fieldset>
    {changed && <button type="button" onClick={() => { active.current?.abort(); active.current = null; setPending(false); setPatches({}); setVehicle({}); setExtras([]); setNotes(e.review?.limited?.userNotes ?? ""); setNotesChanged(false); setMessage(""); onCancel(); }}>Cancelar cambios pendientes</button>}
    {message && <p role="alert">{message}</p>}
  </form>;
  return available ? <details className="review-evidence"><summary>Editar datos extraídos (opcional)</summary>{editor}</details> : editor;
}
