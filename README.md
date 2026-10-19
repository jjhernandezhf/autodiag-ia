# AutoDiag IA

AutoDiag IA recibe reportes Autel PDF, valida el archivo y extrae información estructurada del vehículo, sistemas escaneados y códigos DTC. El PDF y texto bruto son temporales; el historial configurado conserva únicamente snapshots estructurados y sanitizados.

La [guía de entrega y operación](docs/entrega.md) reúne arranque compilado, topología frontend/API, guía de usuario, demostración, migraciones y evidencia con sus límites.

## Aplicaciones

- `apps/web`: interfaz accesible con React, TypeScript y Vite.
- `apps/api`: API con Node.js, TypeScript, Express, Multer y PDF.js.

## Requisitos

- Node.js `^20.19.0 || >=22.12.0`.
- npm 10 o superior.
- Entorno comprobado para la entrega: Node **24.16.0**, npm **11.13.0**. El rango declarado no demuestra compatibilidad probada en todas esas versiones; véase [la limitación preexistente de Node 20](docs/seguridad-dependencias-3.6a.md).
- Reportes Autel con texto digital. Los PDFs compuestos únicamente por imágenes no son compatibles porque esta iteración no usa OCR.

## Configuración segura

Prepara los archivos locales a partir de los ejemplos, sin reemplazarlos si ya existen:

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
if (-not (Test-Path apps/web/.env.local)) { Copy-Item apps/web/.env.example apps/web/.env.local }
```

La API carga automáticamente el `.env` de la raíz durante el desarrollo. Vite carga `apps/web/.env.local` para el frontend. Ambos archivos reales están ignorados por Git y nunca deben versionarse, compartirse ni contenerse en logs.

La API requiere `VIN_HMAC_SECRET` para seudonimizar el VIN. Debe contener al menos 32 bytes y no tiene valor predeterminado. La API falla al iniciar si la variable falta, está vacía o es demasiado corta. Genera una clave local segura con Node.js:

```bash
node --input-type=module -e "import { randomBytes } from 'node:crypto'; console.log(randomBytes(48).toString('base64'))"
```

Guarda el valor generado exclusivamente en el `.env` local. Las variables numéricas opcionales pueden quedar vacías para utilizar sus valores predeterminados seguros; un valor no vacío continúa sujeto a sus límites de validación.

## Instalación y desarrollo

```bash
npm ci --no-fund
npm run dev
```

El comando raíz inicia y etiqueta conjuntamente ambos procesos. La aplicación web se sirve en `http://localhost:5173` y la API en `http://localhost:3000`. Vite redirige `/api` hacia la API durante el desarrollo y `Ctrl+C` detiene ambos procesos.

Como alternativa, pueden iniciarse individualmente en dos terminales:

```powershell
npm run dev --workspace @autodiag/api
npm run dev --workspace @autodiag/web
```

La sesión autenticada se restaura dentro de la pestaña. El PDF original y el trabajo no guardado son temporales y se limpian al abandonar el workspace o recargar. Cuando el análisis informa `history.status = "saved"`, sus snapshots sanitizados permanecen en el historial del usuario; la recarga no elimina esos registros. La descarga PDF es un archivo local independiente.

## Carga y extracción

`POST /api/reports/upload` recibe `multipart/form-data` con un único archivo en el campo `report`. Es un endpoint privado y requiere `Authorization: Bearer <Supabase access token>`.

La API valida:

- extensión `.pdf`;
- MIME `application/pdf`;
- firma `%PDF-` al inicio del contenido;
- tamaño máximo permitido;
- presencia de texto digital utilizable;
- señales estructurales del formato Autel.

El límite predeterminado del archivo comprimido es **10 MiB** (`10485760` bytes). Puede configurarse con `REPORT_MAX_SIZE_BYTES`, hasta un máximo de seguridad de 100 MiB.

La extracción también aplica estos límites conservadores, configurables mediante variables de entorno:

| Variable | Valor predeterminado | Alcance validado |
| --- | ---: | ---: |
| `PDF_EXTRACTION_MAX_PAGES` | `100` | 1 a 1,000 páginas |
| `PDF_EXTRACTION_MAX_TEXT_ITEMS` | `100000` | 1 a 1,000,000 elementos |
| `PDF_EXTRACTION_MAX_CHARACTERS` | `2000000` | 1 a 20,000,000 caracteres |
| `PDF_EXTRACTION_TIMEOUT_MS` | `15000` | 100 a 120,000 ms |
| `PDF_EXTRACTION_WORKER_MEMORY_MB` | `192` | 16 a 512 MiB |

El número de páginas se comprueba antes de recorrer el documento. Los elementos y caracteres se contabilizan incrementalmente antes de conservar cada fragmento. PDF.js se ejecuta en el hilo principal de un proceso hijo independiente, sin shell, credenciales de proveedores ni flags heredados de la API. Se mantienen como máximo dos procesos de extracción por proceso API, sin cola ni reintentos: la saturación devuelve `PDF_EXTRACTION_LIMIT_EXCEEDED`. Al vencer el plazo o cancelarse la solicitud HTTP, la API termina el hijo y espera su cierre físico antes de liberar capacidad. Un cierre inesperado devuelve `PDF_EXTRACTION_ERROR` sin publicar diagnósticos internos.

`PDF_EXTRACTION_WORKER_MEMORY_MB` conserva su nombre por compatibilidad y configura `--max-old-space-size` de V8 (192 MiB por defecto); el stack se configura en 4096 KiB. El límite anterior del Worker tampoco limitaba toda la memoria nativa. Estos límites no son un techo de RSS ni un sandbox del sistema operativo: PDF.js y sus bibliotecas nativas pueden consumir memoria adicional. Los canales privados validan estrictamente cabecera, tamaño y respuesta, con presupuestos derivados de los límites de extracción. Desarrollo usa el loader tsx explícito y compilación usa el hijo `.mjs`, sin cargar archivos de entorno dentro del extractor.

Un canal IPC dedicado supervisa la vida del padre durante toda la extracción; no transporta PDF ni credenciales. El hijo termina al perderlo y mantiene un watchdog propio con el mismo deadline absoluto, sin ampliar el presupuesto. La API conserva el puesto hasta confirmar salida física, cierre de pipes y desconexión IPC, incluso si Node no emite el evento `close` en una carrera de desconexión. El watchdog del hijo requiere que su event loop pueda ejecutarse; no sustituye supervisión del sistema operativo ante un bloqueo nativo absoluto y muerte simultánea del padre.

El PDF y el texto extraído existen únicamente en memoria durante la solicitud. No se guardan en disco, base de datos ni servicios externos. La carga no usa OCR ni envía el PDF a RAG, n8n o almacenamiento permanente. Supabase Auth se utiliza para autenticar y autorizar la solicitud; no recibe el PDF ni su extracción.

La extracción utiliza `pdfjs-dist` 5.4.624. Esta versión requiere Node `>=20.16.0 || >=22.3.0`, compatible con todo el rango declarado por el proyecto.

### Respuesta exitosa

La respuesta usa HTTP `201` y conserva los metadatos del archivo junto con el resultado estructurado:

```json
{
  "id": "UUID",
  "originalName": "reporte-autel.pdf",
  "size": 123456,
  "sha256": "hash-sha-256-en-hexadecimal",
  "type": "application/pdf",
  "status": "received",
  "extraction": {
    "status": "completed",
    "format": "autel_vehicle_diagnostic_report",
    "requiresManualReview": false,
    "vehicle": {
      "year": 2025,
      "make": "Marca de ejemplo",
      "model": "Modelo de ejemplo",
      "engine": null,
      "odometer": { "value": 1000, "unit": "km" },
      "vinMasked": "*************1234",
      "vinPseudonym": "vin_v1_hash-hmac"
    },
    "scanSummary": {
      "declaredSystems": 1,
      "parsedSystems": 1,
      "declaredDtcs": 0,
      "parsedDtcs": 0
    },
    "systems": [],
    "dtcs": [],
    "warnings": []
  },
  "analysisPreparation": {
    "available": false,
    "reasons": [
      {
        "code": "NO_VALID_DTCS",
        "message": "El reporte no contiene DTC accionables válidos para analizar."
      }
    ],
    "warnings": [],
    "counts": {
      "detected": 0,
      "actionable": 0,
      "historical": 0
    }
  }
}
```

El VIN completo nunca forma parte de la respuesta. `vinMasked` revela como máximo sus últimos cuatro caracteres y `vinPseudonym` es un HMAC-SHA-256 determinista con prefijo versionado.

`completed` indica que las secciones principales y sus totales coinciden. `partial` y `requiresManualReview: true` indican diferencias de totales, datos incompatibles o filas que no pudieron interpretarse completamente. Una ausencia opcional, como el motor, puede producir una advertencia sin convertir por sí sola el resultado en parcial.

La API conserva las descripciones y estados originales de los DTC sin traducirlos ni generar diagnósticos, causas, reparaciones o recomendaciones.

`analysisPreparation` indica si la extracción está preparada para solicitar orientación por IA y siempre incluye los conteos detectados, accionables e históricos. Cuando `available` es `true`, también incluye `input`, un DTO sanitizado que contiene exclusivamente marca, modelo, año, módulos y DTC accionables. Cuando no está disponible, `input` se omite por completo y `reasons` explica únicamente las causas activas de forma controlada.

El DTO sanitizado nunca contiene VIN protegido o seudonimizado, odómetro, motor, PDF, nombre de archivo, SHA-256, identificador del reporte ni datos del cliente. Tampoco se truncan módulos o DTC para ajustarlos silenciosamente a los límites.

### Errores

Todos los errores conservan la estructura:

```json
{
  "error": {
    "code": "PDF_NO_USABLE_TEXT",
    "message": "El PDF no contiene texto digital utilizable."
  }
}
```

Además de los errores de carga existentes, la extracción puede devolver:

- `PDF_ENCRYPTED` (`422`): PDF protegido con contraseña.
- `PDF_UNREADABLE` (`422`): PDF dañado o ilegible.
- `PDF_NO_USABLE_TEXT` (`422`): PDF sin texto digital, incluido un documento basado solo en imágenes.
- `PDF_EXTRACTION_LIMIT_EXCEEDED` (`422`): el PDF supera un límite seguro de páginas, elementos, caracteres o memoria.
- `PDF_EXTRACTION_TIMEOUT` (`422`): el proceso hijo de extracción excede el tiempo permitido y se termina.
- `AUTEL_FORMAT_NOT_RECOGNIZED` (`422`): estructura Autel no reconocida.
- `PDF_EXTRACTION_ERROR` (`500`): fallo interno seguro durante la extracción.

Los mensajes no incluyen texto del reporte, VIN, datos del cliente, rutas locales ni errores internos de la biblioteca.

## Orientación diagnóstica con OpenAI

La [base de evaluación de calidad (FASE 3.7A)](docs/evaluacion-calidad/README.md) separa extracción, recuperación RAG, análisis y fiabilidad/latencia. Incluye un evaluador desconectado de resultados previamente obtenidos y casos sintéticos para probarlo; sus pruebas no demuestran precisión diagnóstica. Etiquetas o mediciones ausentes se informan como no evaluables, sin umbrales de aceptación inventados.

La evaluación exploratoria de las FASES 3.5A y 3.5B queda cerrada: se mantiene el modelo anterior para el uso actual y se pospone `gpt-6.1-sol`, según el comportamiento manual reportado por el usuario. Los tiempos, su procedencia y limitaciones están documentados en [Evaluación controlada del modelo](docs/evaluacion-gpt-6-1-sol.md#cierre-de-las-fases-35a-y-35b). Las repeticiones rápidas son consistentes con reutilización, no con velocidad de generación; las pocas muestras no demuestran superioridad general.

La selección operativa de `OPENAI_MODEL` pertenece al `.env` privado del backend, no a un cambio de valor predeterminado en el código. Este cierre no lee ni modifica ese archivo ni realiza llamadas reales.

La [FASE 3.5B del protocolo](docs/evaluacion-gpt-6-1-sol.md#fase-35b--preparación-opcional-de-low) añade `OPENAI_REASONING_EFFORT=low` como opción del backend. Ausente o en blanco conserva la petición y huellas anteriores; `low` se separa en la huella y no cambia timeouts ni garantiza resolver demoras.

`POST /api/reports/analyze` es una operación privada separada de la carga y extracción. Requiere `Authorization: Bearer <Supabase access token>` y un encabezado `Idempotency-Key` con un UUID opaco, recibe JSON estructurado y admite observaciones técnicas opcionales del vehículo. No acepta PDF, VIN, odómetro, nombres de archivo, hashes ni identificadores del reporte.

Entrada resumida:

```json
{
  "vehicle": {
    "make": "Marca de ejemplo",
    "model": "Modelo de ejemplo",
    "year": 2024
  },
  "modules": [
    {
      "code": "PCM",
      "name": "Módulo de control",
      "dtcs": [
        {
          "code": "P0001",
          "description": "Descripción técnica de ejemplo",
          "status": "current",
          "alsoHistorical": false
        }
      ]
    }
  ],
  "observations": "Vibración intermitente al acelerar con el motor caliente."
}
```

`observations` es opcional, debe ser texto de hasta 1,000 caracteres y se normaliza recortando solo los espacios exteriores. Si se omite, es `null`, está vacío o contiene solo espacios, se trata como ausente. No debe incluir VIN, nombres, teléfonos, claves, tokens ni datos del cliente. El backend es la autoridad final y rechaza tipos, longitudes, propiedades desconocidas y patrones sensibles mediante errores controlados.

La extracción conserva todas las filas y sus estados originales. Para análisis, los registros se agrupan por módulo+código: un DTC accionable que también aparece como histórico se envía una sola vez con `alsoHistorical: true`; un registro exclusivamente histórico permanece como antecedente documental y no se envía para generar un hallazgo. Los estados accionables aceptados son `current`, `confirmed`, `stored`, `pending`, `permanent` e `intermittent`; `history` se clasifica como antecedente y un estado desconocido exige revisión manual.

La entrada admite como máximo 40 módulos con DTC accionables, 20 DTC accionables por módulo y 100 DTC accionables totales. Los límites se aplican después de la agrupación, nunca truncando las filas extraídas. También aplica límites de longitud a todos los textos y rechaza propiedades desconocidas.

El cuerpo JSON tiene un límite acotado de **256 KiB**. Este tamaño cubre el peor DTO actualmente válido (40 módulos, 100 DTC y todos los textos en sus longitudes máximas), pero rechaza cuerpos ajenos o sobredimensionados con HTTP `413`. El límite multipart del PDF es independiente.

La respuesta contiene un resumen técnico, hallazgos priorizados, una referencia `relatedDtc` con código, código de módulo y nombre de módulo, explicación sencilla, causas posibles, comprobaciones recomendadas, advertencias de seguridad, confianza y la indicación obligatoria de que requiere confirmación del técnico. También incluye `observationCorrelation` con un estado `not_provided`, `no_clear_match` o `matches_found`, un resumen y asociaciones prudentes a DTC accionables. Una coincidencia no confirma causalidad y siempre requiere comprobación profesional.

El backend exige cero asociaciones para `not_provided` y `no_clear_match`, al menos una para `matches_found`, referencias existentes y no duplicadas, y coherencia entre la presencia de observaciones y el estado. Rechaza referencias ajenas a los DTC accionables y hallazgos duplicados para la misma combinación módulo+código. Es una orientación sugerida, no un diagnóstico definitivo.

La integración usa el SDK oficial `openai` 6.49.0 y Responses API con Structured Outputs. El reporte estructurado y las observaciones se envían en mensajes separados; las observaciones se marcan como entrada no confiable y nunca pueden alterar el reporte ni agregar DTC. Las solicitudes usan `store: false`, `maxRetries: 0` en el SDK y no incluyen herramientas externas. El backend permite como máximo dos intentos físicos de la generación final ante transporte demostrado o HTTP 408, 429, 500, 502, 503 y 504, con espera abortable y presupuesto compartido. No repite embeddings, recuperación RAG ni guardado. Una respuesta incompleta, rechazada, sin texto o inválida no se reintenta automáticamente.

Cada intento tiene un timeout propio de hasta 60 s que cubre la lectura del cuerpo y el procesamiento del SDK, dentro del deadline integral de 80 s. El consumidor recibe un error acotado aunque el proveedor ignore abort; la operación física permanece observada y bloquea otra generación equivalente hasta finalizar. La caché aplica su TTL desde la finalización física y no expulsa trabajo activo; si la capacidad está ocupada, responde con un error controlado. Los motivos de validación se registran como códigos enumerados sin contenido del modelo ni datos del reporte. La causa del HTTP 502 histórico sigue siendo desconocida.

Variables necesarias:

- `OPENAI_API_KEY`: clave del proyecto configurada solo en el entorno del backend.
- `OPENAI_MODEL`: modelo compatible con Responses API y Structured Outputs disponible para el proyecto.
- `OPENAI_REASONING_EFFORT`: opcional; esta evaluación admite solo `low` con `gpt-6.1-sol` o `gpt-5.6-luna`. Ausente/vacío/espacios omite `reasoning` y mantiene el comportamiento anterior. Otros valores o modelos se rechazan al validar la configuración, sin fallback.
- `OPENAI_TIMEOUT_MS`: timeout por intento, incluido el consumo del cuerpo; el valor predeterminado y máximo efectivo es 60,000 ms, y debe ser menor que el presupuesto total.
- `ANALYSIS_TOTAL_TIMEOUT_MS`: presupuesto total del procesamiento en el backend; el valor predeterminado y máximo es 80,000 ms. Al agotarse, responde `ANALYSIS_TIMEOUT`; un timeout propio del intento anterior a ese deadline conserva `OPENAI_TIMEOUT`.

La migración correctiva `20261016000100_correct_diagnostic_history_uniqueness.sql` sustituye exclusivamente la unicidad antigua por referencia: los registros legacy sin fingerprint siguen siendo únicos por usuario y referencia; las variantes con fingerprint se distinguen por usuario y huella de análisis. Debe revisarse y aplicarse manualmente después de la migración de fingerprints; no modifica filas, RLS ni permisos. Las búsquedas de reutilización usan la huella, nunca una referencia de upload potencialmente compartida.

El presupuesto de guardado del historial cubre conjuntamente inserción, resolución de conflictos y recuperación y validación del ganador. Si se agota, se devuelve el análisis validado con historial `unavailable`, sin declarar `saved` anticipadamente. Si ya no queda margen integral para ese presupuesto completo, no se inicia el guardado y también se conserva el análisis con historial `unavailable`. Las operaciones físicas pendientes permanecen observadas y contabilizadas hasta terminar.
- `ANALYSIS_IDEMPOTENCY_TTL_MS`: retención en memoria de resultados idempotentes; el valor predeterminado es 600,000 ms.
- `ANALYSIS_IDEMPOTENCY_MAX_ENTRIES`: máximo de operaciones idempotentes retenidas por proceso; el valor predeterminado es 500.

Las variables numéricas vacías o compuestas solo por espacios aplican sus valores predeterminados. La jerarquía predeterminada es OpenAI 60 s, backend 80 s y navegador 90 s, sin modificar los timeouts específicos de login, salud, carga o historial.

La idempotencia de transporte se aísla por UUID autenticado y `Idempotency-Key`. Además, cargas independientes convergen cuando el backend verifica que pertenecen al mismo usuario y tienen la misma huella canónica de análisis. Esa huella considera el contenido del PDF, extracción sanitizada, DTO y observaciones normalizadas, modelos, versiones de prompt, esquema, corpus y pipeline, así como los parámetros RAG relevantes. Solicitudes simultáneas esperan la misma operación; un resultado persistido se reconstruye sin repetir OpenAI, embeddings, RPC RAG ni historial. Cambiar una entrada o versión genera otra huella y permite un análisis nuevo.

El upload emite un token opaco autenticado por el backend. Se deriva del contenido mediante HMAC con claves separadas por dominio a partir de `VIN_HMAC_SECRET`, se liga al UUID autenticado y nunca se usa como autorización. El navegador solo lo devuelve al endpoint de análisis; no se muestra, registra, exporta ni almacena de forma persistente. El historial conserva exclusivamente las huellas HMAC privadas, nunca el SHA-256 bruto, el PDF o su nombre. La caché en memoria permanece acotada por tiempo y cantidad, y el índice persistente mantiene el aislamiento por `user_id`.

Los errores seguros incluyen:

- `OPENAI_API_KEY_MISSING` (`503`).
- `OPENAI_MODEL_MISSING` (`503`).
- `AI_INPUT_INVALID` (`400`, o `413` para un cuerpo excesivo).
- `OBSERVATIONS_INVALID` (`400`): tipo o longitud inválidos.
- `OBSERVATIONS_SENSITIVE_CONTENT` (`400`): posible VIN, clave, token o secreto.
- `OPENAI_TIMEOUT` (`504`).
- `OPENAI_LIMIT_EXCEEDED` (`429`).
- `OPENAI_RESPONSE_INVALID` (`502`).
- `OPENAI_UNAVAILABLE` (`503`).
- `ANALYSIS_TIMEOUT` (`504`): se agotó el presupuesto total del servidor.
- `IDEMPOTENCY_KEY_INVALID` (`400`).
- `IDEMPOTENCY_CONFLICT` (`409`).
- `ANALYSIS_CAPACITY_EXCEEDED` (`503`).

Ninguno expone la clave, el prompt interno, trazas o mensajes internos del proveedor.

### Flujo manual en la interfaz

La carga del PDF nunca solicita orientación automáticamente. Después de una extracción completa y coherente con DTC válidos:

1. La interfaz muestra los datos documentales extraídos.
2. La sección **Orientación asistida por IA** habilita **Analizar DTC con IA**.
3. El técnico puede escribir observaciones opcionales; el campo se bloquea durante solicitudes activas y se limpia al reemplazar o eliminar el reporte.
4. Una confirmación enumera exactamente los datos técnicos y, cuando corresponda, las observaciones que se enviarán. También aclara que no se enviarán VIN, PDF, odómetro ni datos del cliente.
5. Solo **Confirmar y analizar** ejecuta `POST /api/reports/analyze` mediante una ruta del mismo origen: proxy Vite en desarrollo y proxy inverso `/api` en producción.
6. La orientación se presenta separada de la extracción y siempre muestra que requiere confirmación del técnico.
7. Si las observaciones cambian después de obtener un resultado, este permanece visible y solo una acción explícita inicia una nueva confirmación y análisis.

Si se cambia el reporte mientras existe una solicitud pendiente, el navegador cancela solo su consumo HTTP con `AbortController`, limpia la orientación anterior e ignora cualquier respuesta tardía. La operación pertenece al servidor, conserva su propio presupuesto y puede finalizar aunque ese consumidor se desconecte; un reintento manual con la misma preparación reutiliza la misma clave y recupera o espera el resultado sin iniciar otro análisis. Cambiar el reporte, la preparación o las observaciones genera una clave nueva. El frontend no realiza reintentos automáticos del análisis.

### Identidad visual y descarga local del informe

El encabezado utiliza el logo oficial de AutoDiag IA como recurso local. Después de completar y validar una orientación, **Descargar informe PDF** construye en el navegador un documento A4 con vehículo (marca, modelo y año), contadores documentales, DTC accionables e históricos, observaciones realmente utilizadas, correlaciones validadas, resumen técnico, hallazgos, causas, comprobaciones, advertencias, confianza y confirmación obligatoria del técnico.

La exportación usa únicamente una instantánea explícita de campos autorizados. Excluye VIN y sus derivados, odómetro, motor, datos del cliente, identificadores, nombre y hash del archivo, PDF y texto originales, prompts, claves, tokens y respuestas crudas. Si las observaciones cambian, la descarga queda inhabilitada hasta que el técnico solicite expresamente un nuevo análisis.

El PDF se genera localmente con texto seleccionable y no realiza otra llamada a OpenAI, no consume tokens adicionales y no se envía a Supabase. Se necesita conexión para solicitar un análisis nuevo; una vez descargado, el documento puede conservarse y consultarse sin conexión. Su contenido es orientación técnica, no un diagnóstico definitivo, y siempre requiere confirmación profesional.

### Inicio y prueba manual en PowerShell

Configura las variables solo en la terminal local:

```powershell
$env:VIN_HMAC_SECRET="valor-generado-localmente"
$env:OPENAI_API_KEY="clave-configurada-localmente"
$env:OPENAI_MODEL="modelo-habilitado-en-tu-proyecto"
$env:OPENAI_TIMEOUT_MS="60000"
$env:ANALYSIS_TOTAL_TIMEOUT_MS="80000"
$env:ANALYSIS_IDEMPOTENCY_TTL_MS="600000"
$env:ANALYSIS_IDEMPOTENCY_MAX_ENTRIES="500"
npm run dev --workspace @autodiag/api
```

En otra terminal, envía exclusivamente datos sintéticos o ya estructurados y revisados:

```powershell
$body = @{
  vehicle = @{ make = "Marca de ejemplo"; model = "Modelo de ejemplo"; year = 2024 }
  modules = @(
    @{
      code = "PCM"
      name = "Módulo de control"
      dtcs = @(
        @{ code = "P0001"; description = "Descripción técnica de ejemplo"; status = "current"; alsoHistorical = $false }
      )
    }
  )
  observations = "Vibración intermitente al acelerar."
} | ConvertTo-Json -Depth 6

$headers = @{
  Authorization = "Bearer token-de-sesion-local"
  "Idempotency-Key" = [guid]::NewGuid().ToString()
}
Invoke-RestMethod -Method Post -Uri "http://localhost:3000/api/reports/analyze" -Headers $headers -ContentType "application/json" -Body $body
```

No pegues claves en solicitudes, archivos versionados, logs ni conversaciones.

Para probar el flujo manualmente, inicia API y frontend, carga un reporte Autel compatible con al menos un DTC y verifica que no se envíe ninguna solicitud a `/api/reports/analyze` hasta completar las dos acciones de confirmación. Usa únicamente datos ficticios en entornos de desarrollo.

## Historial seguro de diagnósticos (FASE 3.4A)

La migración `20260821000100_create_diagnostic_history.sql` define un registro inmutable por diagnóstico. La migración adicional `20261013000100_add_diagnostic_analysis_fingerprints.sql` agrega huellas privadas anulables y un índice único parcial por `(user_id, analysis_fingerprint)`; mantiene válidos y sin modificar los registros anteriores. `20261016000100_correct_diagnostic_history_uniqueness.sql` permite variantes fingerprinted del mismo upload y conserva la unicidad legacy. Ninguna migración se aplica automáticamente. El historial conserva escalares mínimos para el listado y snapshots JSONB validados de extracción, análisis y evidencia RAG. El backend intenta guardarlo solamente después de un análisis correcto; si Supabase no está configurado, la escritura falla o excede `DIAGNOSTIC_HISTORY_SAVE_TIMEOUT_MS`, la orientación mantiene HTTP 200 y devuelve `history.status = "unavailable"`. El límite predeterminado es 2,000 ms y solo acepta valores entre 100 y 10,000 ms.

El historial almacena marca, modelo, año, odómetro opcional, códigos DTC, observaciones sanitizadas, modelos utilizados y el VIN exclusivamente como HMAC existente y, cuando está disponible, sus últimos cuatro caracteres. No almacena el PDF, nombre o ruta del archivo, texto bruto, VIN completo, embeddings, respuestas sin validar, datos del usuario, credenciales ni tokens. El snapshot público conserva únicamente el VIN enmascarado y nunca expone su seudónimo HMAC.

`public.diagnostic_history` tiene RLS habilitado y forzado. `authenticated` puede leer únicamente sus propias filas y no puede escribirlas; `anon` no tiene privilegios; `service_role` dispone solo de lectura e inserción. Además de RLS, todas las consultas administrativas del backend filtran explícitamente por el UUID obtenido de la sesión autenticada. El usuario confirmó funcionamiento manual del historial; este cierre no consulta el estado remoto. Antes de automatizar futuras migraciones debe reconciliarse el historial aplicado manualmente, sin reaplicar SQL por asumir que sigue pendiente.

Endpoints protegidos:

- `GET /api/history?limit=20&cursor=...`: lista paginada en orden estable por fecha e id descendentes; el máximo es 50.
- `GET /api/history/:id`: devuelve el detalle público validado o `404` tanto si no existe como si pertenece a otro usuario.

La interfaz permite alternar entre un diagnóstico nuevo y el historial, cargar páginas adicionales, abrir un detalle y regenerar el PDF localmente desde el snapshot guardado. Abrir o exportar un registro histórico no vuelve a invocar OpenAI, embeddings ni el RPC pgvector. El cierre de sesión o cambio de UUID desmonta el área de trabajo y elimina de memoria el listado y detalle anteriores.

## Login privado y Supabase Auth (FASE 3.3B)

AutoDiag IA es un sistema privado sin registro público. El usuario inicia sesión con `nombre_usuario` y contraseña mediante `POST /api/auth/login`. El backend normaliza el username, consulta un perfil existente y activo en `public.profiles`, obtiene internamente el correo del usuario de Supabase Auth y delega la comprobación de contraseña a `auth.signInWithPassword`. AutoDiag IA nunca almacena, compara ni devuelve contraseñas o correos.

El login devuelve exclusivamente los tokens de sesión requeridos por el SDK. El frontend los entrega a `supabase.auth.setSession`; no los copia manualmente a `localStorage`, cookies propias ni estado global. `getSupabaseBrowserClient()` conserva una instancia por pestaña y configura `window.sessionStorage`, persistencia y renovación automática. Al recargar, la interfaz recupera la sesión con `getSession()` y exige además una validación protegida mediante `GET /api/auth/me` antes de mostrar datos diagnósticos.

El navegador observa `INITIAL_SESSION`, `SIGNED_IN`, `SIGNED_OUT` y `TOKEN_REFRESHED`. Un cambio de UUID, un cierre de sesión o una sesión rechazada desmontan el área diagnóstica, cancelan upload/análisis pendientes y eliminan archivo, extracción, observaciones, orientación y estado PDF de memoria. Una renovación del mismo UUID conserva el trabajo. El cierre usa `signOut({ scope: "local" })`, por lo que no termina otras sesiones del usuario.

### Endpoints de autenticación

- `GET /health`: público.
- `POST /api/auth/login`: público; body estricto `{ "nombre_usuario": "usuario.apellido", "password": "..." }`.
- `GET /api/auth/me`: protegido; devuelve únicamente `{ "id": "uuid", "username": "usuario.apellido" }`.
- `POST /api/reports/upload`: protegido con Bearer.
- `POST /api/reports/analyze`: protegido con Bearer.
- `GET /api/history`: protegido con Bearer.
- `GET /api/history/:id`: protegido con Bearer.

El backend valida cada access token con `supabase.auth.getUser(token)`; no confía en un JWT decodificado, `getSession()` del servidor ni datos enviados por el navegador. Después exige que el perfil asociado exista y tenga `is_active = true`. La identidad añadida a la solicitud contiene exclusivamente UUID y username.

El login limita por IP diez intentos fallidos en una ventana de 15 minutos, utiliza headers estándar y no penaliza permanentemente respuestas exitosas. El almacén en memoria es suficiente para el prototipo local; un despliegue distribuido requerirá un almacén compartido. Credenciales inválidas, usuario inexistente y perfil inactivo producen el mismo mensaje genérico.

### Configuración

El backend utiliza las variables vacías documentadas en `.env.example`:

- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_SECRET_KEY`

El frontend utiliza exclusivamente las variables públicas vacías de `apps/web/.env.example`:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`

La clave `SUPABASE_SECRET_KEY` permanece exclusivamente en el servidor y nunca debe usar prefijo `VITE_*`. Sin configuración pública válida, la aplicación muestra un error controlado y no permite acceder al área protegida. Los `.env` reales siguen ignorados por Git.

La migración local `20260917000100_create_profiles.sql` define `profiles.id -> auth.users.id`, username normalizado y `is_active`. No crea usuarios automáticamente. Fue aplicada y verificada manualmente; antes de automatizar migraciones futuras se deberá reconciliar ese estado remoto con el historial local para evitar una aplicación duplicada. Las pruebas usan únicamente clientes simulados: no realizan conexiones reales a Supabase ni llamadas reales a OpenAI.

El usuario confirmó Supabase Auth, registro público deshabilitado y ensayo manual del recorrido completo. Esto no sustituye una verificación administrativa independiente de políticas, usuarios y migraciones en el entorno de entrega. Google OAuth, recuperación/restablecimiento de contraseña y Auth Hooks están fuera del alcance actual.

## RAG demostrativo con pgvector (RAG-MVP-1)

El RAG es una etapa opcional y tolerante a fallos previa al análisis final. El backend construye una consulta exclusivamente con marca, modelo, año, sistemas, códigos y descripciones DTC y observaciones técnicas ya sanitizadas. No incorpora VIN —ni completo, enmascarado o seudonimizado—, usuario, correo, nombre o hash del archivo, identificadores del reporte ni contenido completo del PDF.

Cuando está habilitado y configurado, el flujo es:

1. `text-embedding-3-small` genera un vector de 1536 dimensiones para la consulta técnica.
2. El backend invoca `public.match_knowledge_chunks` con umbral y cantidad acotados.
3. El RPC realiza búsqueda coseno exacta únicamente sobre chunks activos.
4. La respuesta se valida, ordena, deduplica y limita por cantidad y caracteres totales.
5. Los bloques `[K1]`, `[K2]`, etc. se entregan al modelo final entre delimitadores de datos no confiables. El prompt prohíbe seguir instrucciones del corpus y recuerda que similitud no confirma una causa.
6. La API devuelve estado y fuentes públicas sanitizadas; la interfaz y el PDF las muestran por separado de los DTC y observaciones.

`OPENAI_MODEL` continúa seleccionando el modelo de análisis con Responses API y Structured Outputs. `OPENAI_EMBEDDING_MODEL` selecciona únicamente el modelo vectorial y por defecto usa `text-embedding-3-small`. Ambos propósitos son independientes.

Variables backend nuevas:

- `RAG_ENABLED`: `false` por defecto. Solo `true` activa la recuperación.
- `OPENAI_EMBEDDING_MODEL`: `text-embedding-3-small` por defecto.
- `RAG_MATCH_COUNT`: `4` por defecto; acepta de 1 a 10.
- `RAG_MATCH_THRESHOLD`: `0.7` por defecto; acepta de 0 a 1.
- `RAG_MAX_CONTEXT_CHARACTERS`: `6000` por defecto; acepta de 500 a 20000.

Los valores vacíos de `.env.example` se interpretan como ausentes y reciben esos valores predeterminados. Las claves reales permanecen únicamente en `.env`, que no debe versionarse.

### Procedimiento administrativo de migración e ingesta

La migración `supabase/migrations/20260922000100_create_rag_knowledge.sql` instala `vector` en `extensions` o relocaliza allí una instalación existente antes de crear objetos dependientes. Si faltan permisos para relocalizarla, aborta con una acción administrativa explícita. Después crea `public.knowledge_chunks` con `extensions.vector(1536)`, RLS y permisos exclusivos de `service_role`, y define el RPC `public.match_knowledge_chunks` como `security invoker` con `search_path` vacío. El MVP usa búsqueda exacta porque el corpus es pequeño; HNSW o IVFFlat quedan para una fase posterior de escalamiento.

Este cierre no aplica migraciones ni ejecuta ingesta real. El procedimiento siguiente es para un entorno nuevo, tras comprobar qué está ya aplicado; no debe repetirse automáticamente en el entorno existente:

1. Reconciliar el historial remoto de migraciones, incluida la migración `profiles` aplicada manualmente.
2. Revisar y aplicar la nueva migración mediante el procedimiento administrativo aprobado.
3. Validar localmente el corpus sin red:

   ```bash
   npm run rag:ingest -- --dry-run
   ```

4. Con la tabla ya disponible y secretos configurados solo en el backend, ejecutar una vez:

   ```bash
   npm run rag:ingest
   ```

5. Establecer `RAG_ENABLED=true` y reiniciar únicamente la API.

El script valida el corpus con Zod y calcula dos SHA-256: `content_hash` identifica el contenido y `record_hash` cubre canónicamente todos los campos persistidos, con metadata ordenada de forma estable. La comparación de `record_hash` hace el upsert idempotente por `(source_id, chunk_index)` y vuelve a generar el embedding cuando cambia cualquier campo real. Su salida contiene solo cantidades de leídos, válidos, insertados, actualizados y omitidos; no imprime claves ni contenido completo.

El corpus contiene 16 chunks originales y se identifica honestamente como **AutoDiag IA — Corpus demostrativo interno**. Sirve para demostrar recuperación semántica sobre prácticas generales de diagnóstico; no representa ni sustituye manuales de Autel, Mazda, SAE u otros fabricantes.

La [procedencia y aplicabilidad de fuentes RAG](docs/rag-provenance.md) se conserva en el contexto, fuentes públicas, historial y PDF mediante metadata opcional acotada. Una fuente incompatible se excluye; una de aplicabilidad desconocida no autoriza procedimientos específicos. Los registros legacy mantienen su atribución original, sin promoverse a oficiales. Los [tres candidatos TPMS](docs/conocimiento-candidato/README.md) siguen fuera del corpus activo y bloqueados para ingestión mientras su revisión esté pendiente. Las nuevas reglas se identifican como `analysis_pipeline_v2_rag_provenance` en la huella de análisis, sin cambiar `demonstration_corpus_v1`.

Estados devueltos:

- `used`: se recuperaron y utilizaron fuentes.
- `disabled`: RAG está desactivado.
- `not_configured`: se solicitó RAG, pero faltan dependencias de servidor válidas.
- `no_matches`: no hubo resultados sobre el umbral.
- `unavailable`: embedding o RPC falló; el análisis normal continuó sin RAG.

Para rollback operativo, establecer `RAG_ENABLED=false` y reiniciar la API; el análisis existente continúa sin embeddings ni RPC. Si además se necesita retirar el esquema, primero detener la ingesta y RAG, luego crear y revisar una migración inversa que revoque el RPC y elimine `knowledge_chunks`. No eliminar la extensión `vector` sin comprobar otros consumidores.

Guion breve de demostración: iniciar sesión, cargar un PDF Autel compatible, revisar la extracción, confirmar manualmente el análisis y comprobar la sección **Evidencia recuperada por RAG**. Descargar el PDF y verificar **Fuentes de conocimiento recuperadas**. Repetir con `RAG_ENABLED=false` para demostrar el fallback sin fuentes.

El PDF original y el texto bruto continúan siendo temporales en memoria. Con historial configurado, solo los snapshots estructurados y sanitizados se conservan; RAG no almacena el PDF ni embeddings asociados al diagnóstico.

## Verificación

```bash
npm run lint
npm run build
npm test
npm ls pdfjs-dist
git diff --check
```

Las pruebas generan contenido completamente sintético en memoria. El PDF real de referencia no se incorpora al repositorio ni se utiliza como fixture.

## Limitaciones actuales

- Solo se admite la estructura observada en reportes Autel de diagnóstico de vehículo, con tolerancia a variaciones razonables de espacios, acentos, saltos y paginación.
- Los códigos BMW hexadecimales de seis caracteres, incluso si comienzan con números, solo se reconocen dentro de una sección DTC, un módulo declarado y la columna estructural de código; números de metadatos fuera de ese contexto no se interpretan como DTC.
- No existe OCR; un PDF escaneado como imagen devuelve `PDF_NO_USABLE_TEXT`.
- La extracción estructura datos presentes, pero no interpreta fallas ni recomienda reparaciones.
- Un escaneo con cero DTC no demuestra que el vehículo esté libre de fallas.
