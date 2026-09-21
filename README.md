# AutoDiag IA

AutoDiag IA recibe reportes Autel PDF, valida el archivo y extrae información estructurada del vehículo, sistemas escaneados y códigos DTC sin almacenamiento permanente.

## Aplicaciones

- `apps/web`: interfaz accesible con React, TypeScript y Vite.
- `apps/api`: API con Node.js, TypeScript, Express, Multer y PDF.js.

## Requisitos

- Node.js `^20.19.0 || >=22.12.0`.
- npm 10 o superior.
- Reportes Autel con texto digital. Los PDFs compuestos únicamente por imágenes no son compatibles porque esta iteración no usa OCR.

## Configuración segura

La API requiere `VIN_HMAC_SECRET` para seudonimizar el VIN. Debe contener al menos 32 bytes y no tiene valor predeterminado. La API falla al iniciar si la variable falta o es demasiado corta.

Genera una clave local con Node.js:

```bash
node --input-type=module -e "import { randomBytes } from 'node:crypto'; console.log(randomBytes(48).toString('base64'))"
```

Copia `.env.example` como referencia, pero configura la variable en el entorno del proceso. No guardes una clave real en el repositorio.

En PowerShell:

```powershell
$env:VIN_HMAC_SECRET="valor-generado-localmente"
npm run dev
```

En una terminal compatible con sintaxis POSIX:

```bash
VIN_HMAC_SECRET="valor-generado-localmente" npm run dev
```

## Instalación y desarrollo

```bash
npm install
npm run dev
```

La aplicación web se sirve en `http://localhost:5173` y la API en `http://localhost:3000`. Vite redirige `/api` hacia la API durante el desarrollo.

## Carga y extracción

`POST /api/reports/upload` recibe `multipart/form-data` con un único archivo en el campo `report`.

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

El número de páginas se comprueba antes de recorrer el documento. Los elementos y caracteres se contabilizan incrementalmente antes de conservar cada fragmento. PDF.js se ejecuta en un `worker_threads.Worker` con límite de memoria; al vencer el plazo, la API termina el Worker y espera su cierre, por lo que el trabajo subyacente no continúa en segundo plano.

El PDF y el texto extraído existen únicamente en memoria durante la solicitud. No se guardan en disco, base de datos ni servicios externos. Tampoco se usa OCR, OpenAI, RAG, Supabase, n8n o almacenamiento permanente.

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
- `PDF_EXTRACTION_TIMEOUT` (`422`): el Worker de extracción excede el tiempo permitido y se termina.
- `AUTEL_FORMAT_NOT_RECOGNIZED` (`422`): estructura Autel no reconocida.
- `PDF_EXTRACTION_ERROR` (`500`): fallo interno seguro durante la extracción.

Los mensajes no incluyen texto del reporte, VIN, datos del cliente, rutas locales ni errores internos de la biblioteca.

## Orientación diagnóstica con OpenAI

`POST /api/reports/analyze` es una operación separada de la carga y extracción. Recibe JSON estructurado y admite observaciones técnicas opcionales del vehículo. No acepta PDF, VIN, odómetro, nombres de archivo, hashes ni identificadores del reporte.

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

La integración usa el SDK oficial `openai` 6.49.0 y Responses API con Structured Outputs. El reporte estructurado y las observaciones se envían en mensajes separados; las observaciones se marcan como entrada no confiable y nunca pueden alterar el reporte ni agregar DTC. Las solicitudes usan `store: false`, cero reintentos, un timeout configurable y no incluyen herramientas externas.

Variables necesarias:

- `OPENAI_API_KEY`: clave del proyecto configurada solo en el entorno del backend.
- `OPENAI_MODEL`: modelo compatible con Responses API y Structured Outputs disponible para el proyecto.
- `OPENAI_TIMEOUT_MS`: timeout opcional; el valor predeterminado es 20,000 ms.

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

Ninguno expone la clave, el prompt interno, trazas o mensajes internos del proveedor.

### Flujo manual en la interfaz

La carga del PDF nunca solicita orientación automáticamente. Después de una extracción completa y coherente con DTC válidos:

1. La interfaz muestra los datos documentales extraídos.
2. La sección **Orientación asistida por IA** habilita **Analizar DTC con IA**.
3. El técnico puede escribir observaciones opcionales; el campo se bloquea durante solicitudes activas y se limpia al reemplazar o eliminar el reporte.
4. Una confirmación enumera exactamente los datos técnicos y, cuando corresponda, las observaciones que se enviarán. También aclara que no se enviarán VIN, PDF, odómetro ni datos del cliente.
5. Solo **Confirmar y analizar** ejecuta `POST /api/reports/analyze` mediante el proxy de Vite.
6. La orientación se presenta separada de la extracción y siempre muestra que requiere confirmación del técnico.
7. Si las observaciones cambian después de obtener un resultado, este permanece visible y solo una acción explícita inicia una nueva confirmación y análisis.

Si se cambia el reporte mientras existe una solicitud pendiente, el navegador la cancela con `AbortController`, limpia la orientación anterior e ignora cualquier respuesta tardía. Los reintentos requieren una acción explícita.

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
$env:OPENAI_TIMEOUT_MS="20000"
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

Invoke-RestMethod -Method Post -Uri "http://localhost:3000/api/reports/analyze" -ContentType "application/json" -Body $body
```

No pegues claves en solicitudes, archivos versionados, logs ni conversaciones.

Para probar el flujo manualmente, inicia API y frontend, carga un reporte Autel compatible con al menos un DTC y verifica que no se envíe ninguna solicitud a `/api/reports/analyze` hasta completar las dos acciones de confirmación. Usa únicamente datos ficticios en entornos de desarrollo.

## Persistencia preparada (FASE 3.1)

La migración versionada de `supabase/migrations` prepara un historial diagnóstico normalizado, pero todavía no existe una conexión ni una escritura real a Supabase. El modelo separa reportes, módulos, DTC, análisis de IA, hallazgos, causas posibles, comprobaciones, advertencias por hallazgo y advertencias generales. Las posiciones originales se conservan en cada relación ordenada.

Solo se contempla persistir marca, modelo, año, módulos, todas las filas DTC y la orientación estructurada completada. Cada fila conserva su orden, estado original, estado normalizado y clasificación accionable, histórica o desconocida. Los hallazgos se relacionan por separado con una fila accionable inequívoca y no se duplican por la existencia de un antecedente histórico equivalente.

Nunca se contempla almacenar VIN original, protegido o seudonimizado; odómetro; motor; observaciones libres del vehículo ni su correlación; PDF o texto completo extraído; contenido binario; nombre, hash o identificador del archivo; datos del cliente; claves o tokens; prompts; identificadores del proveedor; métricas ni respuestas crudas de OpenAI.

Todas las tablas del historial tienen RLS habilitado, no incluyen políticas públicas para `anon` o `authenticated` y reservan sus privilegios al rol de servicio del backend. Esas credenciales deben permanecer exclusivamente en el servidor. La ejecución de las migraciones contra un proyecto y las escrituras reales continúan pendientes.

## Fundamentos de Supabase Auth (FASE 3.3A)

Supabase Auth está preparado, **no activado**: no hay login, sesiones iniciadas, middleware ni historial conectado. AutoDiag IA será privado, con usuarios y perfiles previamente autorizados mediante un proceso administrativo controlado; no hay registro público desde la aplicación. En esta fase se realizaron cero conexiones reales a Supabase y cero llamadas reales a OpenAI.

Se utiliza el SDK oficial `@supabase/supabase-js` fijado en `2.109.0` en ambos workspaces para conservar compatibilidad con todo el rango Node declarado (incluido Node 20); versiones posteriores requieren Node 22. La configuración Supabase se valida únicamente al solicitar un cliente. Importar los módulos o ejecutar el flujo actual no requiere credenciales Supabase, no inicializa clientes y no realiza operaciones externas.

- Frontend: `apps/web/.env.example` prepara exclusivamente `VITE_SUPABASE_URL` y `VITE_SUPABASE_PUBLISHABLE_KEY`. `getSupabaseBrowserClient()` conserva una instancia por pestaña con persistencia, renovación y detección de sesión en URL preparadas; el almacenamiento es `window.sessionStorage`, nunca `localStorage` ni JWT guardados manualmente. El flujo implícito frente a PKCE se decidirá en la fase de recuperación de contraseña.
- Backend: `.env.example` raíz prepara `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` y `SUPABASE_SECRET_KEY`. `getSupabaseAdminClient()` es diferido y administrativo; `createSupabasePublicClient()` crea una instancia pública aislada por futuro intento. Ambos desactivan persistencia, renovación y detección de sesión en URL. Ninguno se importa en el arranque o endpoints actuales.
- Los contratos aceptan claves modernas según su responsabilidad (`sb_publishable_` o `sb_secret_`), no claves JWT heredadas. Las URLs deben usar HTTPS; HTTP solo se admite para loopback local. Los errores son fijos y no reflejan valores ni errores internos del SDK. La clave secreta omite RLS: debe mantenerse exclusivamente en servidor y **nunca** utilizarse en Vite, un prefijo `VITE_*` o un bundle público.

La migración local `20260917000100_create_profiles.sql` define `profiles.id -> auth.users.id` como relación uno a uno con eliminación en cascada. Incluye únicamente usuario, actividad y timestamps: `username` debe guardarse en minúsculas, sin espacios, con 3–64 caracteres ASCII y separadores controlados (`usuario.apellido`); un índice único sobre minúsculas evita duplicados. No duplica correo ni almacena contraseñas o tokens. El trigger solo mantiene `updated_at`, sin crear usuarios ni perfiles automáticamente.

RLS y permisos revocan acceso de `PUBLIC` y `anon`; `authenticated` solo puede leer su propio perfil mediante `auth.uid() = id`, nunca crearlo, modificarlo o eliminarlo. La administración queda reservada al backend. No se modificó la migración del historial ni se aplicó ninguna migración. Las pruebas de migración son estáticas; comprobar permisos en PostgreSQL y configurar el proyecto privado sin registro público quedan pendientes antes de activar Auth.

Los `.env.example` contienen solamente nombres y valores vacíos, no son configuración ejecutable: omite variables opcionales para utilizar los valores predeterminados documentados. Los `.env` reales permanecen ignorados por Git. No copies credenciales del servidor al frontend. La próxima FASE 3.3B implementará login, sesión y middleware de autenticación; recuperación y OAuth quedan para fases posteriores.

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
