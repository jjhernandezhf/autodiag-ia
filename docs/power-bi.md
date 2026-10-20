# Power BI — exportación del historial propio

Esta fase inicia la preparación de datos para Power BI Desktop. **No se ha construido un tablero**, no se ha conectado a Power BI/Supabase/OpenAI ni exportado datos reales durante la implementación. No sustituye ni cierra la mejora pendiente de relevancia/evaluación RAG. Los fixtures prueban el exportador, no la calidad diagnóstica.

## Qué se cuenta y de dónde sale

Unidad: **una fila de historial guardada = un análisis guardado**, no un vehículo único, una reparación ni una ejecución nueva del modelo. Variantes de observaciones/configuración pueden generar varios análisis del mismo PDF/vehículo; recuperar un diagnóstico existente no añade por sí solo otra fila. Solo se exportan filas que realmente existen, no análisis que terminaron con historial `unavailable`.

| Archivo / columna | Origen persistido / significado |
| --- | --- |
| `autodiag-analisis.csv`: `analysis_reference` | Clave aleatoria nueva por análisis y exportación, solo para relacionar los dos archivos. No es UUID interno del historial, ID de usuario, VIN o fingerprint |
| `created_at` | `diagnostic_history.created_at`, normalizada a UTC ISO 8601. Fecha de guardado, **no duración/latencia** |
| `make`, `model`, `year` | Columnas persistidas del historial |
| `dtc_count` | Cantidad persistida, contrastada con la longitud de los DTC extraídos guardados |
| `rag_status` | Estado guardado: `used`, `disabled`, `not_configured`, `no_matches`, `unavailable` |
| `autodiag-dtc.csv`: `analysis_reference` | Misma clave del archivo de análisis de **este lote** |
| `dtc_code`, `module_code`, `module_name` | `extraction_snapshot.dtcs[].code/moduleCode/moduleName`. Código de módulo vacío significa desconocido, no se inventa |

Una fila DTC es **una referencia registrada en la extracción del análisis guardado**, incluidos actuales/históricos según el snapshot. Un mismo código en módulos distintos conserva filas distintas. No es necesariamente un código único ni acredita una avería confirmada. El exportador conserva ocurrencias persistidas, no deduce causas ni elimina referencias para alterar el conteo. La suma de `dtc_count` debe coincidir con las filas DTC del lote.

No se exportan VIN ni seudónimos, odómetro, IDs de usuario/historial/upload, observaciones, descripciones libres, explicaciones, posibles causas, archivos PDF, nombres de archivo originales, hashes, tokens o credenciales. Las claves de relación no permiten cruzar lotes: **no mezclar un CSV nuevo con otro anterior**.

## Obtener los archivos reales (usuario, tras publicación autorizada)

1. Iniciar sesión en AutoDiag IA con la cuenta autorizada y abrir **Historial**. La versión desplegada actual no incorpora este cambio hasta su revisión/publicación; no hay que introducir claves en Power BI.
2. Elegir **Preparar CSV de mi historial**. La petición autenticada es `GET /api/history/export`, sin parámetros, body o `user_id` del navegador. No analiza PDFs ni llama al modelo/RAG; solo lee el historial del UUID autenticado.
3. Si finaliza, descargar **ambos** enlaces: análisis y DTC. Cada enlace requiere acción explícita para evitar bloqueos de descargas múltiples del navegador. Un historial vacío genera encabezados y conteos cero, no registros ficticios. Las URLs temporales se revocan al abandonar la vista, regenerar o cerrar sesión.
4. Guardar los dos archivos de la misma preparación en una carpeta local protegida. Evitar carpetas públicas y no añadirlos al repositorio. Aunque minimizados, contienen datos técnicos del usuario; no se presentan como anónimos absolutos.

## Importar y relacionar en Power BI Desktop

1. **Obtener datos → Texto/CSV**, seleccionar `autodiag-analisis.csv`, origen UTF-8 (65001), delimitador **coma**, comillas dobles. Usar **Transformar datos**. Repetir para DTC y nombrar las consultas/tablas `Analisis` y `DTC`.
2. Fijar `analysis_reference`, marca, modelo, `rag_status`, DTC y ambos campos de módulo como **texto** (conservar ceros, hexadecimales y sufijos). `year`, `dtc_count` como números enteros. Mantener `created_at` como **texto ISO 8601** para la siguiente expresión (corregir el paso automático de tipos si Desktop lo convirtió). Añadir columna personalizada UTC `Fecha` en Power Query y asignarle tipo fecha:

   ```powerquery
   Date.From(DateTimeZone.SwitchZone(DateTimeZone.FromText([created_at]), 0))
   ```

3. Crear relación `Analisis[analysis_reference]` **1 → muchos** `DTC[analysis_reference]`, filtro simple desde Analisis. Una clave de Analisis debe ser única y cada clave DTC debe existir en Analisis. Si no ocurre, detenerse y revisar el lote, no ocultar las filas huérfanas. Conjunto vacío puede requerir fijar tipos manualmente antes de modelar.
4. Crear medidas (los separadores pueden adaptarse a la configuración regional de Desktop):

   ```dax
   Total análisis = COUNTROWS(Analisis)
   Total DTC registrados = COUNTROWS(DTC)
   DTC esperados del lote = SUM(Analisis[dtc_count])
   Análisis con RAG usado = CALCULATE([Total análisis], Analisis[rag_status] = "used")
   Proporción RAG usado = DIVIDE([Análisis con RAG usado], [Total análisis])
   ```

   Formatear la proporción como porcentaje de **uso**, nunca precisión/confianza. `DIVIDE` sin denominador devuelve vacío, no aprobación ficticia. Comparar los dos conteos DTC sin filtros de código/módulo para comprobar el lote completo; filtros solo en la tabla DTC pueden hacerlos diferir legítimamente.

5. Propuesta de visuales todavía por construir: tarjetas de análisis y DTC registrados; evolución por `Fecha` con total de análisis; barras por `make`; distribución por `rag_status` y tarjeta de proporción `used`. Opcionalmente tabla DTC por código y módulo bajo filtros del análisis. `used` acredita uso guardado de evidencia, **no relevancia ni causa confirmada**. No crear medidas de precisión, reparación exitosa o latencia: faltan esas mediciones/etiquetas.

Para actualizar, preparar otro lote completo y **reemplazar ambas fuentes juntas**, no anexar exportaciones acumuladas: se duplicarían análisis y las claves de relación cambian. No conectar Power BI directamente con una clave administrativa, JWT o credenciales del servicio. No hay publicación automática, refresh programado ni `.pbix` creado en esta fase.

## Límites, coherencia y errores

- Corte `cutoff` UTC fijado al inicio, mostrado por la interfaz. Solo se consultan filas con `created_at <= cutoff`. Paginación keyset descendente por fecha e ID, conservando microsegundos de PostgreSQL, 25 filas y una de lookahead por consulta. Se exige conteo exacto en cada consulta de metadata para detectar un límite inferior de filas de PostgREST: si la página está truncada o no hay count, se falla sin entregar una falsa exportación completa. Las nuevas filas posteriores al corte se incluyen en la próxima exportación, no se presentan como parte de este lote. No es una transacción/snapshot de PostgreSQL: una modificación administrativa concurrente puede causar error o alterar lo observado; evitarla durante la exportación. El flujo normal mantiene historial inmutable.
- Máximo **200 análisis**, **500 DTC por análisis**, **10000 DTC totales**, **4 MiB UTF-8 entre ambos CSV**, **10 segundos** y **dos exportaciones físicas simultáneas por proceso API**. Son límites del exportador, no de análisis/PDF. La metadata y sus conteos se validan antes de leer los DTC por página. No se ofrece selección parcial silenciosa ni se exporta solo la página visible del historial.
- Error en cualquier página, campo contaminado/inválido, relación inconsistente, exceso de límites o timeout: **no se ofrecen CSV parciales**. Se recibe error controlado, sin mensajes internos. `422 ANALYTICS_LIMIT` indica límite/capacidad; `502 ANALYTICS_INVALID`, datos no válidos; `503 ANALYTICS_UNAVAILABLE`, servicio/plazo no disponible. La interfaz conserva la sesión y permite un reintento explícito cuando corresponda; no hay retry automático de exportación (la renovación de autenticación sigue el patrón existente).
- Las consultas de metadata y DTC filtran explícitamente por el UUID autenticado, incluso con cliente administrativo. No se aceptan parámetros de selección/usuario; se mantienen Auth y RLS existentes, sin migraciones ni permisos nuevos. Las respuestas tienen `Cache-Control: no-store`.
- Solo los campos permitidos se serializan. Textos técnicos acotados y detector central de datos sensibles; si fallan, se rechaza todo el lote, sin omitir filas contaminadas. CSV con BOM UTF-8, CRLF, todos los campos entre comillas y comillas internas duplicadas. Celdas susceptibles de fórmula reciben un apóstrofo inicial; conservar esa protección y no quitarla al abrir en hojas de cálculo. Los valores no se ejecutan como DAX, HTML o SQL.

## Pendiente de comprobación real

Revisión/publicación autorizada, exportar historial real desde una cuenta, importar el par completo en Desktop, comprobar conteos/relación/tipos y construir/verificar los visuales. El transporte de PostgREST se prueba mediante mocks contra la proyección real `dtcs:extraction_snapshot->dtcs`; no se ejecutó aquí contra Supabase ni se comprobó un tablero. La mejora RAG, revisión técnica y candidatos TPMS continúan pendientes por separado.

## Verificación local de la implementación

- API: **83/83** en cinco archivos focalizados (exportador, historial HTTP/repositorio, autenticación y servicio web). Incluye conteo exacto/truncamiento del proveedor, límites, fechas con microsegundos, aislamiento A/B, datos sensibles, fórmulas y rechazo físico tardío tras timeout; no se observaron rechazos sin manejar.
- Frontend: **116/116** en cuatro archivos (exportación, App, autenticación de App y cliente API). Incluye ausencia de exportación automática, doble clic, cancelación/desmontaje, respuesta tardía y revocación de URLs.
- Lint de ambos workspaces, build API y build web `--mode test` aprobados; este último evita dotenv real y conserva la advertencia conocida del bundle mayor de 500 kB. No es un bundle configurado para publicar.
- Arranque compilado con entorno sintético: **1/1**, seleccionando `actual compiled entry` del script existente; el proceso propio se cerró y esperó. No se inició un servidor de desarrollo ni se usaron credenciales reales.
- Fallos iniciales corregidos: lint rechazó la regex de caracteres de control (sustituida por comprobación equivalente sin desactivar reglas); TypeScript detectó los cuatro códigos de error nuevos no declarados en `ErrorCode` (añadidos sin cambiar códigos existentes). Las comprobaciones afectadas se repitieron tras corregirlos, sin cambiar tests, timeouts o runner para ocultarlos.
- Worktree independiente `feat/power-bi-analytics`, desde `main`/`origin/main` local coincidentes en `61ab3ea16fc6e69a4ca511734fb17f31c5eee4e0`; sin fetch por la restricción de llamadas externas. Dependencias instaladas **offline** desde el lockfile, sin nuevas dependencias ni cambios de versiones. No se leyó ningún entorno real ni se trasladó la sonda de proxies.

Estos resultados verifican la herramienta con fixtures sintéticos y transportes simulados, no conteos de clientes reales, un tablero Power BI ni calidad diagnóstica. Las pruebas completas anteriores se conservan como evidencia de su propio estado; no se presentan como ejecutadas sobre esta funcionalidad nueva.
