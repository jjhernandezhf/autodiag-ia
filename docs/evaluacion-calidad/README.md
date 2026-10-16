# FASE 3.7A — Base de evaluación de calidad

Esta fase prepara instrumentos, no publica una medida de precisión diagnóstica. No ejecuta el parser, embeddings, RPC ni análisis generativo: consume proyecciones saneadas de resultados obtenidos anteriormente. No hay una evaluación real de modelo o RAG en este directorio. Las pruebas unitarias comprueban el evaluador; sus puntuaciones ficticias no son resultados del producto.

## Capacidades y evidencia disponible

| Etapa implementada | Evidencia disponible | Lo que todavía no demuestra |
| --- | --- | --- |
| PDF Autel y parser por módulos/estados, advertencias y bloqueo de datos incompletos | Contratos en `report-types.ts`; pruebas de parser, extractor y PDF; casos sintéticos de integración | Exactitud por fabricante/variante, tasa de rechazo y cobertura en una muestra independiente representativa |
| Adaptador de análisis | Conserva módulo+código, agrupa actual/histórico mediante `alsoHistorical`, excluye históricos exclusivos y bloquea inconsistencias; pruebas automatizadas | Que una extracción plausible sea fiel al documento original o que un estado represente una avería presente |
| RAG | Corpus interno demostrativo de 16 chunks, embeddings de 1536 dimensiones, recuperación con presupuesto/umbral y fallback; pruebas con mocks | Relevancia, suficiencia, recall real o validez técnica para un vehículo concreto. Similitud no equivale a relevancia ni causalidad |
| Análisis final | Responses con esquema estricto, validación semántica de referencias y confirmación técnica obligatoria; pruebas de transporte simulado | Causas correctas, seguridad de recomendaciones, calibración de confianza ni reparaciones confirmadas |
| Fiabilidad | Deadlines, exclusión física, máximo de dos intentos y reutilización; pruebas deterministas | Probabilidad real de éxito, distribución de latencia o causa histórica de timeouts |

Las pruebas manuales reportadas por el usuario en la evaluación de modelos se documentan en `../evaluacion-gpt-6-1-sol.md`. Son exploratorias, no un benchmark independiente. Este trabajo no presupone una optimización adicional. La sesión, el historial y el PDF no se modifican.

## Formatos v1

La especificación ejecutable está en `apps/api/src/quality-evaluation.ts`, mediante Zod estricto. No se modifica el contrato productivo.

### Casos: `quality_cases_v1`

Objeto con `schemaVersion` y `cases`. Cada caso contiene:

- `id`: identificador técnico único, minúsculas y guiones, sin identidad personal.
- `split`: `development` para ajustar, `holdout` para evaluación reservada. No agregar puntuaciones entre ambos grupos.
- `origin`: `kind` (`synthetic` o `authorized_sanitized`), `usePermission` (alcance de permiso, sin personas) y `reference` (referencia técnica de autorización, no nombre/ruta de reporte).
- `scenario` y `observations`: contexto técnico; `null` significa que no se aportaron observaciones. No usar el campo para instrucciones de sistema. Las instrucciones adversariales son datos no confiables.
- `expected.vehicle`: solo marca/modelo/año conocidos; `null` en campos no etiquetados. No añadir VIN, odómetro, cliente o nombre de archivo.
- `expected.dtcs`: filas completas esperadas con `code`, `moduleCode` anulable, `moduleName` y `status`. Incluye históricos; preserva multiplicidad. `null` significa sin etiquetas y `[]` significa conjunto conocido vacío.
- `expected.actionableDtcs`: referencias módulo+código que se espera cubrir en hallazgos, separadas de las filas históricas. No se deducen automáticamente del corpus. Etiquetar explícitamente, sin inventar datos ausentes.
- `expected.extractionDisposition`: `completed`, `partial`, `unsupported` o desconocido (`null`).
- `expected.sources`: lista de IDs técnicos, relevancia `relevant`/`partial`/`irrelevant` y justificación. `null` es sin juicios. `[]` solo es una etiqueta de ausencia de fuentes en un pool definido, no ausencia universal de documentación.
- `sourceLabelsExhaustive`: solo verdadero si el pool relevante está definido y completamente juzgado. `humanReview` mantiene `pending` hasta revisión; etiquetas RAG pendientes no generan métricas de relevancia.
- `expected.withoutEvidence`: reconocer límites (`acknowledge_limits`), bloquear orientación (`do_not_analyze`) o no aplicable. La adecuación del contenido necesita revisión humana, no coincidencias de palabras.
- `versions`: snapshot de referencia o `null` si aún no se registró. El objeto contiene todos los campos descritos abajo, usando `null` para desconocidos.

`casos-sinteticos.json` contiene nueve ejemplos de infraestructura: uno/múltiples DTC, código compartido entre módulos, actuales/históricos, observaciones, ausencia y relación parcial de fuentes, contenido malicioso, reporte parcial y formato no compatible. No contiene PDF, fragmentos privados ni causas mecánicas etiquetadas como ciertas. Las fuentes ficticias no atribuyen contenido a fabricantes. El ejemplo parcial es una etiqueta ilustrativa pendiente, no un juicio técnico definitivo.

La separación development/holdout de esos ejemplos muestra el formato. Al estar públicos y usados para probar el evaluador, no constituyen un conjunto ciego del producto. Crear un holdout autorizado independiente, no usado para ajustar prompts, corpus, umbrales o parser. Si se inspecciona para ajustar el sistema, reclasificarlo como desarrollo y reservar casos nuevos antes de medir otra vez.

### Resultados: `quality_results_v1`

Objeto con `schemaVersion` y `runs`. `resultados-vacios.json` es una plantilla sin mediciones, no una ejecución exitosa. Una ejecución contiene estos campos obligatorios (salvo `analysis` y `analysisInputDtcs`, cuya omisión se normaliza a `null`):

```json
{
  "id": "measurement-a", "caseId": "authorized-case-a", "origin": "recorded",
  "versions": {
    "parser": null, "corpus": null, "prompt": null, "outputSchema": null,
    "analysisModel": null, "embeddingModel": null, "reasoningEffort": null,
    "ragEnabled": null, "matchCount": null, "matchThreshold": null,
    "contextCharacters": null, "attemptTimeoutMs": null, "totalTimeoutMs": null
  },
  "responseOrigin": "unknown", "responseOriginEvidence": null,
  "httpStatus": null, "errorCode": null, "durationMs": null,
  "extraction": null, "analysisAvailable": null, "analysisInputDtcs": null,
  "retrievedSources": null, "ragStatus": null, "human": null
}
```

Este objeto es solo un molde, no una medición. Para los casos sintéticos usar `origin: "fixture"`; el evaluador impide presentarlos como `recorded`. No mezclar resultados ficticios con observaciones del producto.

Registrar versiones efectivamente utilizadas: revisión de código para parser (no existe una versión independiente formal), `demonstration_corpus_v1` para el corpus actual, `diagnostic_prompt_v1`, `diagnostic_output_schema_v1`, modelos exactos, esfuerzo efectivo/política `provider_default`, RAG y límites. Estos nombres describen el estado inspeccionado; deben verificarse al capturar cada ejecución. Nunca inferir el modelo local leyendo un valor de ejemplo ni copiar entornos privados. Configuración o campos desconocidos se quedan en `null`: no inventar defaults observados. Cambiar código/corpus exige una revisión de versión, aunque una constante no haya cambiado.

`extraction` es una proyección manual: `disposition`, vehículo mínimo y filas `{code,moduleCode,moduleName,status}` de la extracción, no de la entrada de análisis. No exportar el objeto upload/historial completo. `analysisAvailable` se toma de `analysisPreparation.available`. `analysisInputDtcs` recoge las referencias que realmente atravesaron el adaptador; su ausencia impide puntuar validez de referencias.

`retrievedSources` recoge solo IDs que llegaron al contexto final, no candidatos RPC descartados. Registrar `ragStatus` observado: `used`, `no_matches`, `disabled`, `not_configured`, `unavailable` o desconocido (`null`). Solo los dos primeros permiten medir relevancia; una recuperación no ejecutada o fallida no se convierte en recall cero. Mantener un mapa técnico local estable entre UUID/índice de chunk y el ID del juicio, sin datos personales; no mapear por título aproximado. No copiar el contenido de los chunks al resultado. La evaluación de relevancia exige juicios independientes y justificados; no tomar como verdad la lista completa del corpus usado por el sistema. También se puede requerir documentación técnica autorizada fuera del corpus.

`analysis`, si existe, contiene únicamente la salida técnica saneada, sin wrappers privados. El evaluador usa el esquema productivo para puntuar validez estructural; no considera eso una prueba de verdad. Referencias semánticas se evalúan por separado contra `analysisInputDtcs`.

`human` es `null` hasta revisión. Para registrar una valoración: `{status:"completed", role:"qualified_technician", rationale:"justificación técnica saneada", supportedClaims:{supported:1,total:2}, appropriateAbstention:true, usefulAndSafe:false}`. Los números ilustran el formato, no una revisión real. Se acepta `pending` y `null` en valoraciones no realizadas. El técnico debe elaborar un inventario de afirmaciones y comprobar cada una contra fuentes/mediciones; solo se exportan los conteos y una justificación saneada. El software no autentica al revisor ni verifica su competencia o la verdad de los conteos.

## Métricas y límites

Cada métrica devuelve `measured` con valor y, en proporciones, numerador/denominador, o `not_evaluable` con motivo (mostrar como **no evaluable**). Un denominador vacío no se convierte en 0 o 1. Un cero explícito medido es válido; no se usa para rellenar datos faltantes. No hay nota global ni umbral de aprobación automático.

- Extracción: coincidencia exacta de campos conocidos; precisión/recall de filas con clave módulo+código+estado y conteo multiconjunto. No mide calidad de descripciones, geometría PDF ni OCR. Cambios de formato equivalentes requieren normalización de etiquetas acordada, no tolerancias silenciosas.
- Análisis: esquema válido y cobertura de referencias únicas que coinciden en expectativas, input realmente enviado y hallazgos, con identidad completa (`moduleCode`, `moduleName`, `code`). El denominador conserva todas las referencias únicas esperadas, incluidas las omitidas del input. Input enviado `null` u omitido produce cobertura no evaluable con motivo `missing_sent_input`; input presente `[]` con expectativas no vacías produce cobertura 0. Expectativas vacías conservan el motivo `empty_denominator`, sin aprobación automática. La validez de todas las referencias de hallazgos y correlaciones contra las realmente enviadas se informa por separado y no cambia. No mide priorización correcta, causalidad ni que todos los consejos sean seguros. Duplicar hallazgos no mejora cobertura; el mismo código en otro módulo no coincide.
- Recuperación: precisión/recall binarios de fuentes relevantes; las parcialmente relacionadas se informan por separado, sin contarlas como plenamente pertinentes. Se deduplican IDs. Sin juicios revisados o con fuentes recuperadas sin juicio, no evaluable; recall requiere pool exhaustivo. Pool vacío revisado permite medir que no se recuperaron fuentes, pero no da precisión/recall perfectos por convención.
- Respaldo de afirmaciones, utilidad/seguridad y abstención: valores de revisión humana completada; nunca derivados de palabras como “confirmado”, longitud del texto, confidence del modelo o similitud RAG. Respaldo requiere salida estructuralmente válida.
- Bloqueo de análisis: para casos etiquetados `do_not_analyze`, requiere disponibilidad observada falsa y ausencia de análisis. No equivale a abstención técnica del texto ni puede inferirse solo por timeout.
- Fiabilidad: estado HTTP observado y código de fallo por intento lógico registrado. HTTP 200 no equivale a diagnóstico válido; contrastar esquema y revisión humana. No hay tasa agregada de fiabilidad sin definir población, ventana, denominadores y condiciones; conservar también intentos fallidos y casos sin medición.
- Latencia total y latencia de generación separadas. Esta última solo se informa para HTTP 200 sin código de error, salida válida, `responseOrigin: "new_generation"` y evidencia explícita. La duración de fallos sigue conservada como latencia total, no como generación exitosa. `memory_reuse`, `history_reuse` y `unknown` no son velocidad de generación. El evaluador confía en la procedencia anotada, no puede probarla por el tiempo o el payload. Un fixture siempre sigue marcado como tal, aunque simule generación.

No se agrupan modelos, configuraciones, splits o fixtures automáticamente. `configurationMatchesCase` solo compara snapshots completos; con desconocidos es no evaluable. Esa coincidencia no prueba que las mismas entradas fueran usadas; el operador debe conservar el caso autorizado y la captura exacta de inputs saneados en su ámbito local. No generar conclusiones estadísticas de unas pocas muestras.

## Ejecución sin proveedores

Desde la raíz, sin cargar dotenv ni usar los scripts dev/rag:

```powershell
npm exec --workspace @autodiag/api -- tsx src/quality-evaluation-cli.ts ../../docs/evaluacion-calidad/casos-sinteticos.json ../../docs/evaluacion-calidad/resultados-vacios.json
npm exec --workspace @autodiag/api -- vitest run src/quality-evaluation.test.ts
```

El primer comando produce nueve casos no evaluables por ausencia de ejecuciones, no puntuaciones del modelo. Para resultados previamente capturados usar dos rutas JSON locales explícitas autorizadas. La CLI solo lee esos archivos, no escribe resultados ni abre puertos. Sus errores son públicos genéricos; no imprimen cuerpos ni rutas. Los resultados muestran métricas/IDs/configuración, no textos de análisis. El detector de campos/datos sensibles es defensa adicional, no anonimización garantizada: revisar manualmente antes de ejecutar o compartir. No pasar `.env`, respuestas completas de upload/historial, nombres de cliente, VIN, odómetro, PDFs, claves, tokens, hashes privados ni nombres de archivo originales. No versionar resultados reales sin una nueva revisión explícita de privacidad/autorización.

Códigos de salida de la CLI:

- **0:** procesamiento correcto; no implica calidad aprobada ni que existan métricas evaluables.
- **1:** error de entrada o procesamiento; se informa `EVALUATION_INPUT_INVALID` por stderr, sin resultados JSON ni contenido privado.

Una ejecución correcta puede tener todos los casos como no evaluables: por ejemplo, la plantilla vacía devuelve código 0, `runs: []` y nueve entradas en `unobservedCases` con `status: "not_evaluable"` y `reason: "missing_run"`. Significa que los archivos se procesaron, pero no hay mediciones para evaluar esos casos. Revisar siempre los estados y motivos de cada métrica/caso; no interpretar el código 0 como aprobación ni reemplazar ausencias por ceros. No se introducen umbrales ni se cambian los códigos de salida.

## Protocolo manual pendiente

1. Obtener permiso de uso y saneamiento; registrar alcance mediante referencia técnica sin nombres. Conservar originales fuera del repositorio en un ámbito autorizado. No introducir PDF reales aquí. Un técnico competente transcribe etiquetas de extracción disponibles, distingue estados y adjudica módulo; lo desconocido permanece desconocido.
2. Antes de ajustar el sistema, separar desarrollo y reserva, fijar versiones del caso/protocolo y construir juicios de relevancia independientes con justificación. Revisar cobertura del pool y no confundir relación temática con evidencia aplicable al vehículo.
3. Capturar únicamente ejecuciones previamente autorizadas; esta fase no autoriza llamadas pagadas. Registrar fallo/HTTP, tiempo total, medición y procedencia en todas, sin omitir timeouts. No agregar reintentos para conseguir resultados favorables. Registrar cada solicitud lógica y, cuando se conozca, explicar número de intentos físicos en una ficha técnica saneada.
4. Distinguir generación, memoria e historial mediante evidencia del flujo y uso atribuible, no por velocidad. `reused: true` indica recuperación persistente; `reused: false` no prueba generación porque la caché en memoria puede conservar el payload original. Reiniciar no elimina historial. No borrar datos, cambiar observaciones o rotar secretos para forzar una llamada. Si no puede determinarse el origen, usar `unknown`.
5. Revisar por una persona competente afirmaciones, causas como hipótesis, prioridad, cobertura, advertencias, pruebas recomendadas y abstención ante evidencia insuficiente. En contenido adversarial, comprobar que no se siguieron las instrucciones incrustadas; el esquema válido no prueba resistencia a inyección.
6. Comparar versiones con los mismos casos, entradas/observaciones y pool, condiciones y snapshots registrados; separar generación/reutilización, desarrollo/reserva y fallos. Si cambia RAG, registrar la evidencia final: no atribuir toda diferencia al modelo. Medir tokens/costes solo si hay datos atribuibles; este formato no los infiere ni habilita instrumentación productiva.
7. Acordar antes de evaluar criterios de aceptación: tamaño/diversidad de muestra, tratamiento de etiquetas discutidas, acuerdo entre revisores, pesos de errores críticos, mínimos de cobertura/relevancia, abstención adecuada, tolerancia a rechazos, objetivos de latencia/fiabilidad y condiciones de comparación. **Todos esos umbrales quedan pendientes**; no hay aprobación diagnóstica en esta fase.
