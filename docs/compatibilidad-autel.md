# Compatibilidad Autel y revisión manual

## Alcance comprobado — 2026-10-28

Los siete PDF originales autorizados se leyeron fuera del repositorio mediante
`extractPdfPages`, su proceso hijo productivo, el parser Autel y `prepareAiAnalysis`.
No se copian documentos, VIN ni números de serie al repositorio. Las regresiones
usan textos y disposiciones sintéticos. No se utilizaron proveedores, OCR,
credenciales ni datos inferidos del nombre del archivo.

| Caso | Sistemas / observaciones / identidades | Resultado local y condición pendiente |
| --- | --- | --- |
| Mazda AXELA / MAZDA3 | 13 / 7 / 7 | Corregible manualmente: año realmente ausente; ODDTCs/CMDTCs conservados; RCM continúa entre páginas. Confirmar el año con evidencia del vehículo. |
| Honda HR-V 2023 | 16 / 35 / 35 | Completo y elegible; SRS contiene 22, sin el antiguo bloqueo por 20. Conserva sufijos y códigos repetidos en módulos distintos. |
| Audi 2012 | 1 / 1 / 1 | Completo y elegible; `00003:005`, `Activo / static` y modelo A4 / S4 / RS4 2008> conservados. S4 no se interpreta como motor ni 2008 como año. |
| Kia Sportage 2015 | 8 / 0 / 0 | Sin DTC legítimo: resultado informativo, no diagnóstico artificial. El odómetro impreso es `0` sin unidad: `odometerRaw="0"`, odómetro estructurado nulo; no se inventan km/mi. |
| Acura TL 2004 | 7 / 14 / 13 | Corregible manualmente: resumen del cuadro = 0, detalle = 4; contradicción presente en el documento, no corregida silenciosamente. P0430 permanente y provisional conservados; SRS 61-10 entre páginas. |
| Nissan Frontier 2012 | 7 / 8 / 8 | Corregible manualmente: seis etiquetas `1 vez` permanecen desconocidas; solo dos filas son actuales. Requiere evidencia o incertidumbre revisada explícita para las seis, con motivo. |
| Honda CR-V 2006 | 5 / 9 / 8 | Completo y elegible: códigos numéricos con guion, F3-11 y continuidad SRS conservados. P1157 permanente y provisional son dos observaciones de una identidad. |

“Elegible” no significa que se haya generado ni validado una orientación real.
La comprobación local de Mazda/año y Audi reportada previamente por el usuario
se distingue de esta reproducción automatizada. No se ejecutaron análisis pagados.

## Causa y reglas reutilizables

El parser anterior no reconocía las rutas `Other/Mazda/...`, ciertos códigos
numéricos de fabricante ni algunos estados. Las continuaciones se asociaban por
número de líneas, no por distancia vertical; la descripción podía absorber código
y estado cuando faltaba texto en su columna. Se respetan columnas y coordenadas,
el módulo continúa entre páginas y las asociaciones geométricamente ambiguas
siguen bloqueadas. Los códigos numéricos solo se reconocen en contexto de tabla
y módulo. No se convierten a códigos OBD supuestamente equivalentes.

Las rutas contradictorias conservan revisión requerida. Se mantiene el nombre
completo del modelo; no se elige una variante ambigua ni se infiere el año.
La ausencia de motor u odómetro es opcional y no bloquea por sí sola.

### Estados documentales, no diagnóstico

- ODDTCs: `on_demand`, prueba bajo demanda.
- CMDTCs: `continuous_memory`; no acredita actividad presente ni historia exclusiva.
- DTC permanente: `permanent`; no acredita un modo OBD específico.
- DTC provisional: `provisional`, independiente del permanente.
- Activo / static: `current`, conservando la etiqueta original.
- `1 vez`: `unknown`; no se transforma en activo, histórico ni cantidad de códigos.
- Incertidumbre revisada: `reviewed_uncertain`, decisión explícita del usuario;
  conserva el estado literal y no significa normalización profesional verificada.
- Una identidad con varios estados elegibles: `multiple_observed`, con todas las
  observaciones originales anidadas, sin elegir arbitrariamente un estado.

Las etiquetas literales de on_demand, continuous_memory, provisional e incertidumbre
revisada también acompañan al contexto del modelo cuando hay una sola observación;
no se pierde `1 vez` al introducir el tratamiento explícito de incertidumbre.

La distinción de memoria continua y prueba bajo demanda se contrastó previamente
con el [glosario Ford VCM II CFR](https://www.fordservicecontent.com/Ford_Content/Catalog/ids_manuals/CFRManual_Released_v2.1.pdf)
y la [comunicación del fabricante conservada por NHTSA](https://static.nhtsa.gov/odi/tsbs/2015/SB-10057819-4973.pdf).
La segunda trata un Ford F-150, no acredita reparación ni compatibilidad Mazda.
Aquí solo fundamenta una lectura prudente de terminología; no se decodifican bytes
de estado ni se atribuyen causas automotrices.

## Capacidad y conteos

Una identidad es código y módulo completo (código y nombre). El máximo nuevo es
50 identidades por análisis y hasta 50 en un módulo, sin superar el total global.
Con 51 se rechaza, sin truncamiento. Los duplicados no eluden límites independientes:
200 observaciones originales, 40 módulos con DTC elegibles, 100 000 caracteres del
DTO de entrada serializado y el límite HTTP existente de 256 KiB. No se elevaron
límites PDF, tiempo, concurrencia ni recursos de extracción.

La interfaz diferencia filas originales, identidades y elementos enviados a IA.
Las observaciones agrupadas no generan filas adicionales en estadísticas/CSV:
se conservan las observaciones históricas reales y la frecuencia por código sigue
contando análisis distintos. La salida y sus referencias admiten hasta 50 elementos.

Kia muestra “¡Buenas noticias! Este escaneo no reportó códigos DTC en los 8 sistemas
revisados” solo con extracción completa y todos los conteos coherentes. Aclara que
no descarta problemas no detectados. No hay llamadas IA, embeddings ni RAG.
Con pérdida de filas o extracción parcial nunca se muestra ese resultado positivo.

## Revisión validada y trazabilidad

`POST /api/reports/review` requiere autenticación y una prueba HMAC del servidor,
vinculada a usuario, referencia, contenido y extracción completa. Caduca en una hora;
revisar no extiende esa vigencia. La clave se deriva con dominio separado del secreto
existente; no se añaden secretos ni se exponen en el navegador.

El panel permite completar/corregir marca, modelo y año; reasignar filas a módulos
existentes; corregir códigos/descripciones con motivo; añadir filas omitidas según
el documento y reconciliar resumen/detalle explícitamente. No permite borrar ni
reordenar observaciones originales. Un cero coherente no se convierte en códigos
inventados mediante revisión. Las advertencias estructurales no resolubles siguen
bloqueando. No hay un booleano genérico para ignorar errores.

Estados desconocidos pueden conservar el bloqueo o registrarse como incertidumbre
revisada con motivo por fila. No pueden cambiarse a “activo” por conveniencia.
Las decisiones, originales y valores efectivos se conservan hasta historial y PDF,
sin duplicar VIN en la evidencia de revisión. No acredita revisión profesional.

Antes de IA/RAG, el backend recalcula elegibilidad y compara el DTO con la extracción
firmada. Toda generación nueva necesita contexto y prueba vigente, aunque se quiten
flags de revisión. El DTO técnico directo y los sobres sin prueba se rechazan antes
de IA, RAG o persistencia; su antiguo uso para generación queda retirado. La lectura
histórica sigue admitida sin pruebas de upload. El helper anterior
`/api/reports/confirm-vehicle` se conserva para completar ausencias; el flujo nuevo
usa revisión firmada para admitir el análisis ligado al reporte.

Editar invalida análisis, PDF y callbacks anteriores. Se descartan respuestas tardías
al cambiar reporte, usuario o cerrar sesión. La validación no genera IA automáticamente:
después sigue siendo necesaria la solicitud explícita de orientación.

### Versiones y lectura histórica

- Prompt: `diagnostic_prompt_v5_manual_evidence`.
- Pipeline: `analysis_pipeline_v3_manual_review`.
- Modelo, corpus, recuperación RAG y política de reintentos: sin cambios.
  El ajuste posterior de presupuestos se documenta al final de esta guía.
- El prompt base independiente permanece intacto; la salvedad de estados/revisión
  se añade condicionalmente y trata los textos aportados como datos no confiables.
- La huella incluye datos efectivos y decisiones de revisión; cambiar una corrección
  no recupera el resultado anterior. Tokens y caducidad no forman esa identidad.
- Snapshots anteriores siguen legibles, incluidos contratos antiguos de hasta 100
  entradas totales/20 por módulo en lectura; no habilitan nuevas generaciones con
  esos límites. No se requieren migraciones. Historial/exportación no regeneran IA/RAG.

## Ensayo manual local pendiente

1. Iniciar sesión y cargar cada documento autorizado. Comparar sistemas, filas,
   identidad completa, sufijos, descripciones y estados con la tabla anterior.
2. Mazda: confirmar año con evidencia, no con nombre del archivo. Acura: decidir
   expresamente usar el detalle de cuatro filas del cuadro y registrar motivo.
   Nissan: revisar seis estados sin interpretación; si no hay evidencia suficiente,
   conservar bloqueo o declarar incertidumbre, nunca actividad inventada.
3. Honda HR-V, Audi y CR-V: comprobar elegibilidad sin pérdida ni duplicación.
   Kia: verificar resultado informativo, odómetro sin unidad y ausencia de acción IA.
4. Cambiar una corrección/reporte o cerrar sesión durante una petición simulada:
   ninguna respuesta anterior debe repoblar el trabajo. Revisar motivos conservados.
5. Solo con autorización separada de consumo, solicitar orientación explícita y revisar
   historial/PDF: originales, efectivos, estados y limitaciones. Esta tarea no hizo
   esa prueba pagada ni verificó el despliegue.

## Evidencia de desarrollo y límites de las pruebas

La fase anterior del 2026-10-27 cubrió tres documentos: 187/187 focalizadas API,
233/233 frontend y API global 855/858 (no aprobada: dos expectativas n8n y un timeout
de extracción real). Es evidencia anterior, no del estado consolidado.

Durante esta ampliación las primeras pruebas detectaron expectativas del límite
21/20 y de versiones anteriores, fixtures con estado literal ficticio incompatible
con su normalización, referencias modificadas sin renovar prueba y un fixture de
correlación sin observaciones enviadas. Se corrigieron conforme al contrato, sin
relajar validaciones. La expectativa de upload ahora exige también la prueba HMAC.
La prueba de separación RAG compara expresamente la versión anterior del pipeline.

La primera ejecución global de esta ampliación obtuvo 871/876: los tres fallos del
contrato/fixtures se corrigieron y verificaron en 99/99 focalizadas. Los otros dos
se reprodujeron de nuevo en una copia temporal limpia del HEAD base: 27/29,
`profiles-migration.test.ts:61` (lista sin migración n8n) y
`supabase-clients.test.ts:234` (prohibición incompatible con el arranque n8n existente).
No se corrigieron por ser ajenos a este alcance. No se atribuyen al ambiente.

La revisión final añadió dos regresiones: recuperación histórica de 35 identidades
en un módulo (no aplicarles el antiguo máximo de 20), y completar una ruta de vehículo
no interpretada con evidencia (sin levantar una sección estructural ausente).

### Evidencia anterior al cierre de los cuatro P2 (2026-10-28)

- Focalizadas de revisión/adaptador/historial/compatibilidad sobre el código final:
  **65/65**, incluida la conservación de etiquetas literales en el contexto.
- Frontend completo: **242/242**, incluyendo revisión, cancelación, identidad y PDF.
- Focalizadas frontend/PDF: **119/119** (incluidas en la suite completa).
- API global anterior a los dos ajustes: **872/876**, no aprobada. Incluyó dos
  timeouts de 5 s: el recorrido nativo nuevo de compatibilidad y la contención de
  terminación sintética en `pdf-integration.test.ts`. Ambos archivos aprobaron luego
  **22/22** en una ejecución acotada. No se demuestra la causa de la intermitencia.
- API global intermedia: **876/878**, solo las dos expectativas n8n.
- API global final: **875/878**; las dos expectativas n8n reproducidas en la base
  limpia y otro timeout de 5 s en `pdf-integration.test.ts:74` (contención de
  terminación sintética). **La suite API global no está aprobada.** No se repitió
  hasta obtener verde ni se atribuyó la causa de ese timeout sin evidencia.
- Lint y builds de ambos workspaces aprobados; lint/build API repetidos tras los
  dos ajustes finales. Se conserva la advertencia conocida del bundle >500 kB.
- Sin cambios de Vitest/timeouts, dependencias, lockfile, migraciones o proveedores.

Las pruebas sintéticas demuestran controles del software, no precisión diagnóstica
ni estabilidad permanente. La ejecución intermedia sin timeouts no elimina la
intermitencia observada ni demuestra un arreglo del extractor, que no se modificó.

## Cierre de los cuatro P2 — 2026-10-29

### 1. Generación vinculada al reporte

La reproducción anterior enviaba el reporte incompleto firmado y obtenía 400,
pero quitaba el contexto y declaraba `current` para obtener 200 e iniciar IA/RAG.
Ahora `validatedReportMatchesInput` exige contexto, token de contenido, prueba vigente
y correspondencia completa del DTO recalculado por el servidor. Los rechazos ocurren
antes de consulta histórica, recuperación, generación o guardado. Un upload completo
ya recibe su prueba: no requiere editar ni confirmar campos que estén completos.

Los fixtures de integración que antes enviaban DTO directos ahora reciben evidencia
de un helper de servidor de pruebas, fuera del código productivo. Las regresiones
del bypass no usan ese helper: verifican directamente el rechazo del DTO y sobres
incompletos con autenticación y clave de idempotencia válidas. No se añadió una
opción de producción para omitir validaciones.

### 2. Vigencia, concurrencia y límites del mecanismo

La firma por sí sola no invalidaba A después de B. Se incorpora una autoridad local
acotada por usuario/reporte, con HMAC del contenido/extracción y un nonce nuevo por
publicación. Aunque se vuelva a datos idénticos en el mismo milisegundo, una prueba
sustituida no revive. La aceptación y sustitución son síncronas y usan compare-and-swap
contra la prueba vigente: dos revisiones concurrentes de A no pueden publicar ambas.
Se mantiene el vencimiento original de una hora, sin prolongarlo al revisar.

El registro guarda únicamente claves derivadas, firmas, nonce y vencimiento, no
PDF ni texto del reporte. Conserva como máximo 1000 reportes vigentes por proceso;
no expulsa registros aún válidos para admitir otros. La capacidad agotada devuelve
503 `REPORT_VALIDATION_UNAVAILABLE`; los vencidos se limpian al emitir otra prueba.

Se comprueba vigencia al recibir análisis, antes de cada etapa externa, antes de
cada llamada física al modelo (incluido el segundo intento), antes del guardado y
antes de publicar respuesta. Si A estaba esperando historial o RAG cuando B se
aceptó, no inicia la etapa siguiente. Una llamada ya iniciada puede terminar y
permanece observada: no se promete deshacer consumo ni efectos consumados. Una
inserción histórica que ya comenzó puede finalizar con su snapshot inmutable de A;
esto no autoriza iniciar operaciones nuevas con A ni sustituye el snapshot de B.

Para una revisión manual, la operación en memoria se separa también por su prueba
vigente: una B con datos equivalentes no hereda el error de autorización de una A
pendiente. Se requiere una clave de idempotencia nueva al cambiar de revisión (la
interfaz ya la reinicia). La huella persistida no incorpora la prueba/nonce: conserva
la reutilización histórica para datos y decisiones realmente equivalentes.

**Reinicio:** el registro se pierde; las pruebas anteriores se rechazan aunque su
firma y fecha sean válidas. Se debe recargar el PDF para obtener nueva validación,
sin borrar historial. **Varias instancias:** este mecanismo no proporciona autoridad
compartida; no habilitar escalado horizontal sin diseñarla y probarla. Mantener una
sola instancia API, como las coordinaciones en memoria existentes. Una solicitud
recibida por un proceso que desconoce la prueba falla cerrada. No se añadieron
migraciones, infraestructura remota ni credenciales.

### 3. Exportación equivalente, sin perder originales

`Fallo de encendido` y `FALLO DE ENCENDIDO` eran elegibles en backend pero fallaban
al exportar. Backend y navegador usan ahora el mismo módulo puro de comparación:
`shared/technical-text.mjs` (espacios, mayúsculas y diacríticos). El frontend no
importa módulos privados de servidor. No se transforma el texto documental mostrado.

El modelo PDF conserva todas las observaciones y sus etiquetas originales de una
identidad, incluidos sus antecedentes históricos. Renderiza las variantes sin crear
hallazgos extra. Una descripción realmente contradictoria sigue rechazada; también
se conserva lectura de modelos PDF anteriores sin el campo nuevo `observations`.

### 4. Evidencia manual hasta Responses

`review_context_v2` incluye campo/fila, `before`, `after`, motivo individual, motivo
general y procedencia `user_review_unverified`. Conserva las etiquetas inciertas.
Solo transporta decisiones técnicas: no adjunta la extracción completa, VIN,
identificadores de usuario/reporte, firmas ni tokens. Los motivos deben ser técnicos,
sin datos personales; se conservan las defensas de contenido sensible existentes.
Las cantidades y longitudes se validan con los límites de decisiones (1400), textos
(500 para motivos, 2000 para valores) y el presupuesto total del DTO (100 000).

Los datos llegan en el reporte estructurado de la petición real a Responses, con
transporte simulado. No se interpolan como instrucciones confiables. El prompt
aclara que son aportaciones manuales, no verificaciones del fabricante. Su versión
v5 separa fingerprints de v4; el pipeline continúa en v3. Snapshots con contexto v1
siguen legibles sin regenerar ni perder la auditoría almacenada. La versión antigua
no habilita nuevas solicitudes sin prueba vigente.

### Verificación de este cierre

- Focalizadas API del bloque: 281/281; comprobaciones adicionales de estadísticas,
  CSV, n8n, autenticación y autoridad: 100/100 (incluyen regresiones ya contadas).
- Frontend completo: 243/243, con contexto v2 en la revisión del navegador.
- Siete originales reprocesados con extractor/parser reales: mismos conteos y
  condiciones de la tabla inicial. No hubo análisis real ni llamadas de embeddings.
- Tras extraer la comparación a su módulo compartido: 59/59 API y 47/47 PDF;
  imports compilados del API y comparación compartida comprobados sin servidor.
- Delta final de concurrencia A/B equivalente: 49/49 revisión/idempotencia/historial.
- Lint de ambos workspaces y del módulo compartido aprobado; builds API/frontend
  aprobados. API lint/build se comprueban de nuevo tras el delta final. Se conserva
  únicamente la advertencia conocida del bundle >500 kB.
- Diff-check, whitespace de archivos nuevos e inventario sin artefactos privados
  comprobados. Manifiestos, lockfile y migraciones intactos; entornos ignorados y
  no rastreados, sin leerlos. No se realizaron llamadas reales a proveedores.
- No se repitió la suite API global. Continúa **no aprobada**: los dos fallos n8n
  reproducidos en la base son distintos del timeout PDF de causa desconocida.

Fallos iniciales de esta corrección: 11/113 focalizadas por fixtures que reutilizaban
pruebas sustituidas, emitían otra prueba al evaluar un getter, o aún enviaban DTO
directos. Se ajustaron al nuevo contrato y se conservaron las regresiones explícitas
del rechazo; después aprobaron 113/113. Dos expectativas PDF asumían una sola etiqueta
cuando también existía un histórico: ahora exigen ambas y todas las observaciones.
Lint detectó un parámetro sin usar en una prueba nueva; se corrigió el fixture, sin
suprimir la regla. No se modificaron timeouts, Vitest ni dependencias.

## Comprobación de acciones manuales accesibles — 2026-10-29

Se encontraron y cerraron rutas incompletas del panel: una fila con código no
interpretado podía convertirse en continuación y desaparecer de la lista editable;
la reasignación de módulo no actualizaba la necesidad visible de reconciliar conteos;
y faltaban acciones de recuperación junto a errores de lectura del PDF.

El parser conserva ahora la fila de tabla con celda de código no reconocido y celda
de estado, dentro del máximo de 32 caracteres, como observación pendiente. No la
convierte en código válido: conserva código, descripción, estado y posición, marca
revisión requerida y bloquea IA. El usuario corrige esa misma fila (`sourceIndex`),
sin añadir una copia. Las continuaciones auténticas sin celda de código mantienen
su tratamiento. Se reprocesaron los siete originales y sus conteos no cambiaron.

El panel muestra un índice de acciones con enlaces a campos/filas/conteos, abre las
filas afectadas, conserva visibles originales y solicita motivo cuando cambia algo.
Los campos no se cierran al resolver el primer error antes de introducir el motivo.
La descripción conflictiva utiliza el mismo criterio normalizado que el backend.

| Bloqueo | Acción manual disponible | Validación backend | Prueba |
| --- | --- | --- | --- |
| Marca, modelo o año ausentes | Completar campos con original visible y motivo general; no exige motor/odómetro | Campos requeridos, formatos/año y prueba vigente; no levanta secciones faltantes | UI `resuelve desde el panel…`; API `completa identidad ausente…` |
| Código no reconocido | Corregir la misma fila conservada, viendo el código original | Formato admitido; `sourceIndex` único, conservación de todas las observaciones | API `conserva una fila con código no interpretado…`; UI `resuelve desde el panel…` |
| Descripción ausente | Introducir descripción literal y motivo por fila | Texto no vacío, longitud, sensibilidad y rechazo de contradicciones | Las dos pruebas anteriores conservan descripción original vacía y efectiva |
| Módulo no asociado | Seleccionar un sistema documentado; se muestra identidad original completa | Índice válido y asociación única; recalcula conteos | API `reasocia un módulo…`; UI `reasignar módulo abre reconciliación…` |
| Estado no normalizado | Elegir expresamente incertidumbre revisada y explicar; conservar etiqueta original o ausencia | No acepta cambiar etiqueta original a activo; `reviewed_uncertain` llega al contexto | UI `resuelve desde el panel…` / `añade solo una fila…`; API `reconstruye una fila ausente…` |
| Conteos discrepantes | Comparar resumen, detalle original y revisado; decidir versión y motivo | Recalcula totales y asociaciones; otros bloqueos siguen vigentes | UI `reasignar módulo…`; API `reconcilia una contradicción…` |
| Fila realmente ausente | Añadir datos técnicos, motivo y comprobación contra el PDF; retirar solo borrador añadido accidentalmente | Nunca elimina originales; copia añadida exige evidencia explícita de observación independiente | UI `añade solo una fila…`; API `una copia añadida no pasa silenciosamente…` |
| PDF ilegible, protegido, sin texto o fuera de límites | Reexportar/seleccionar PDF compatible; reintento explícito cuando proceda | Límites/extractor conservados; no existe formulario para convertir un archivo inválido en evidencia válida | UI `ofrece recuperación local…` (4 casos), pruebas de extracción previas reutilizadas |
| Cero DTC legítimo | Resultado informativo, sin acción de generación | Extracción completa y conteos coherentes; rechaza añadir códigos a un cero válido | UI `no confunde cero legítimo…`; API `el endpoint bloquea saltos directos y cero DTC…` |

Las filas nuevas idénticas a otra no se aceptan por accidente: requieren un motivo
adicional que acredite que el documento presenta dos observaciones independientes;
queda en la auditoría y el contexto manual. Los originales repetidos legítimos no
se eliminan ni necesitan esta confirmación adicional. Una fila añadida sin estado
documentado puede conservar `statusOriginal=null` solo con incertidumbre revisada.

La prueba de integración de App confirma que corregir el año y recibir del backend
un estado todavía desconocido muestra la acción específica restante, sin botón IA.
El caso cero DTC usa ahora una clave de idempotencia válida en la comprobación HTTP,
para demostrar el rechazo por elegibilidad, no un rechazo anterior por cabecera.

Límites: no se inventan módulos que no figuren en los sistemas interpretados. Una
sección ausente, sistema no interpretable, archivo corrupto, falta de texto o exceso
de recursos no se convierte en corregible ignorando advertencias: debe reexportarse
un reporte completo y compatible. Se mantienen 50 identidades y 200 observaciones.

Verificación de este delta: 113/113 API (parser, compatibilidad, revisión, autoridad
e historial) y 81/81 frontend (App y panel). Lint y builds aprobados, con la advertencia
conocida de bundle. El primer build detectó el tipo genérico del mock nuevo; se
corrigió el fixture sin alterar producción, aserciones, Vitest ni timeouts. Después
del pequeño delta de etiquetas/originales se ejecutan solo las comprobaciones afectadas.

Esto comprueba código, solicitudes y accesibilidad de controles en DOM sintético,
no un ensayo visual interactivo de escritorio/móvil ni calidad diagnóstica. Queda
pendiente ese ensayo local con el usuario. No se repitió ni aprobó la suite API
global; permanecen separados los dos fallos n8n de base y el timeout PDF desconocido.

## Archivos del bloque local

Modificados (31):

- `apps/api/src/ai-analysis-adapter.ts` y su prueba.
- `apps/api/src/ai-analysis-types.ts`, `ai-analysis-service.ts`, `ai-analysis-integration.test.ts`.
- `apps/api/src/analysis-fingerprint.ts`, su prueba, `analysis-references.ts`, `analysis-idempotency-integration.test.ts`.
- `apps/api/src/app.ts`, `app.test.ts`, `autel-parser.ts`.
- `apps/api/src/diagnostic-history.ts`, `diagnostic-history-integration.test.ts`.
- `apps/api/src/diagnostic-persistence.ts` y su prueba.
- `apps/api/src/quality-evaluation.ts`, `rag-provenance.test.ts`, `report-types.ts`, `sensitive-data.ts`, `text-normalization.ts`.
- `apps/api/src/rag-analysis-integration.test.ts` (fixtures con evidencia de servidor).
- `apps/api/src/ai-analysis-service.test.ts`, `config.ts`, `config.test.ts`, `index.ts` (propagación y presupuestos).
- `apps/web/src/App.tsx`, `App.test.tsx`, `report-pdf.ts`, `report-pdf.test.ts`, `styles.css`.

Nuevos (13):

- `apps/api/src/autel-compatibility.test.ts`.
- `apps/api/src/report-review-schema.ts`, `report-review.ts`, `report-review.test.ts`.
- `apps/api/src/report-validation-regressions.test.ts`, `apps/api/test-support/report-proof.ts`.
- `apps/api/src/vehicle-confirmation.ts` (helper de la fase anterior conservado).
- `apps/web/src/ReportReviewPanel.tsx`, `report-review-data.ts`.
- `apps/web/src/ReportReviewPanel.test.tsx` (acciones manuales desde controles).
- Este documento.
- `shared/technical-text.mjs`, `shared/technical-text.d.mts`.

Inventario previo al cierre autorizado: 44 archivos de este bloque en
`fix/autel-vehicle-compatibility`. No incluye entornos privados ni archivos de
otros worktrees. No se modificaron otros worktrees durante esta implementación.

## Diagnóstico y prueba temporal de timeout (2026-10-29)

El script `npm run dev --workspace @autodiag/api` ejecuta desde `apps/api`
`tsx watch --env-file=../../.env src/index.ts`. Por tanto, carga el `.env`
de **este worktree**, no el del worktree principal. La inspección se limitó
a las variables numéricas de presupuestos: aquí `OPENAI_TIMEOUT_MS` era
60000, mientras que en el worktree principal era 120000. No se encontraron
esas variables heredadas en los ámbitos Process/User/Machine de la sesión
de inspección; esto no acredita el entorno interno de un proceso ya abierto.
Las variables previamente exportadas al lanzar Node prevalecen sobre el
archivo de entorno: ante una discrepancia, revisar únicamente estos nombres
en la terminal de arranque y el diagnóstico numérico de inicio.

Además, `DiagnosticAnalysisService` recortaba cada intento mediante
`Math.min(60_000, attemptTimeoutMs)`. Se retiró ese recorte; se conserva el
mínimo entre el timeout configurado y el tiempo restante del deadline
integral, tanto para el SDK como para la cancelación. El SDK mantiene
`maxRetries: 0`. El coordinador, el árbitro de deadlines, la vigencia de las
revisiones y las reglas de persistencia/capacidad no se modificaron.

Configuración temporal preparada exclusivamente en el `.env` privado de
este worktree:

```dotenv
OPENAI_TIMEOUT_MS=120000
ANALYSIS_TOTAL_TIMEOUT_MS=150000
```

El máximo integral validado es ahora 150000 ms; sus valores predeterminados
siguen siendo 60000 por intento y 80000 totales. El navegador espera hasta
160000 ms para el análisis, por encima del máximo integral; no se cambian
los timeouts de las demás peticiones. El guardado conserva su presupuesto
propio predeterminado de 2000 ms, contenido en el deadline integral.
Los 150 s incluyen preparación/RAG, generación, eventuales reintentos y
guardado: no equivalen a dos intentos garantizados de 120 s.

Detener y volver a iniciar **la API de este worktree** para cargar el archivo;
una edición del `.env` no garantiza reinicio del watcher. Verificar
`ANALYSIS_TIMEOUT_CONFIGURATION` con `attemptTimeoutMs: 120000`,
`totalTimeoutMs: 150000` y `historySaveTimeoutMs: 2000`. Recargar la web
para usar el nuevo presupuesto del navegador. No se inició otra API ni
se realizó ninguna solicitud real de análisis durante esta corrección.
La prueba manual reportada posteriormente se registra abajo. Un presupuesto
mayor no garantiza éxito ni explica la demora del proveedor.

La política sigue evitando un segundo intento mientras la llamada física
anterior no haya terminado. `attempt: 1, maxAttempts: 2` no demuestra por
sí solo un defecto de reintento ni revela cuál de sus condiciones lo impidió.

Para revertir la prueba, restaurar en este mismo archivo los valores
60000 y 80000, o quitar ambas variables para usar sus defaults, y reiniciar
la API. El máximo de espera del navegador permanece en 160 s como margen
acotado compatible con los presupuestos admitidos, sin extender el trabajo
del backend. No se necesita cambiar modelo, historial ni fingerprints.

Regresiones desconectadas: configuración 120/150 s y rechazo de valores
incoherentes; SDK real con transporte `fetch` simulado que completa a los
61 s; transporte limitado por el deadline integral y por el límite propio;
rechazo tardío observado y capacidad física retenida hasta finalizar.
Se usa reloj falso, no esperas reales prolongadas ni timeouts de Vitest mayores.

Verificación de esta corrección: API 152/152 en cinco archivos
(`config`, `ai-analysis-service`, `analysis-coordinator`,
`report-validation-regressions`, `analysis-idempotency-integration`);
frontend 94/94 (`App`, `api-client`); lint y ambos builds aprobados.
Permanece la advertencia de bundle mayor de 500 kB. `git diff --check`
aprobado. El primer comando, mediante el script que ya incluye `src`,
seleccionó accidentalmente la suite API completa y se interrumpió; mostró
fallos en `profiles-migration` y `supabase-clients`, no investigados ni
atribuidos aquí a una causa. Esa ejecución no está aprobada y no se repitió.

Delta de esta tarea: `config.ts`, `config.test.ts`, `ai-analysis-service.ts`,
`ai-analysis-service.test.ts`, `index.ts`, `App.tsx`, `App.test.tsx`, esta
documentación y únicamente las dos asignaciones numéricas del `.env`
privado/ignorado. El inventario acumulado pasa a 31 archivos rastreados
modificados y 13 nuevos, con staging vacío; no se modificaron dependencias.

### Configuración de producción y evidencia manual de cierre

Después de integrar y desplegar este bloque, introducir privadamente en las
variables del servicio Render (no en el bundle ni en Git):

```dotenv
OPENAI_TIMEOUT_MS=120000
ANALYSIS_TOTAL_TIMEOUT_MS=150000
```

Ambos valores están admitidos y comprobados por los esquemas de configuración.
La segunda variable es obligatoria para esta prueba de 120 s: omitirla dejaría
el default integral de 80 s y el arranque rechazaría esa combinación. Las demás
variables privadas ya configuradas se conservan; no cambiar modelo, secretos
ni configuración RAG. Aplicar la configuración mediante un despliegue autorizado
por separado y comprobar el log numérico de inicio. El frontend del mismo bloque
debe estar compilado y servido para usar su espera de **160 segundos**.
No se ha hecho ese despliegue como parte del cierre local.

Mantener **una sola instancia API**. La autoridad de revisión y el coordinador
residen en memoria: no proporcionan coordinación distribuida y un reinicio
invalida las pruebas de reporte pendientes. Recargar el PDF tras reiniciar;
el historial guardado no se elimina. El límite integral de 150 s incluye todas
las etapas, no garantiza dos llamadas de 120 s ni garantiza una respuesta exitosa.

Evidencia manual **reportada por el usuario el 2026-10-29**, no ejecutada por las
herramientas automatizadas: Honda HR-V completó el análisis **local** con
**HTTP 200 en aproximadamente 1,3 minutos** y el usuario reportó funcionamiento
correcto. No se revisó aquí una captura nueva ni se instrumentó esa medición;
no se deduce precisión diagnóstica, estabilidad permanente, percentiles ni
validación en Render a partir de esa observación. Los ensayos restantes del
panel y los otros documentos no quedan acreditados por este único resultado.

Se reutilizan las verificaciones automatizadas descritas arriba: el último
cambio funcional aprobó API focalizada 152/152, frontend focalizado 94/94,
lint y builds; este cierre solo actualiza documentación y verifica el diff y
el staging. **La suite API global sigue sin aprobarse**: las dos expectativas
n8n reproducidas en la base se distinguen del timeout PDF de causa desconocida.
No se ocultó ni corrigió ese timeout en este bloque.
