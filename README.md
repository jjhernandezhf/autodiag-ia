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
        "message": "El reporte no contiene DTC válidos para analizar."
      }
    ],
    "warnings": []
  }
}
```

El VIN completo nunca forma parte de la respuesta. `vinMasked` revela como máximo sus últimos cuatro caracteres y `vinPseudonym` es un HMAC-SHA-256 determinista con prefijo versionado.

`completed` indica que las secciones principales y sus totales coinciden. `partial` y `requiresManualReview: true` indican diferencias de totales, datos incompatibles o filas que no pudieron interpretarse completamente. Una ausencia opcional, como el motor, puede producir una advertencia sin convertir por sí sola el resultado en parcial.

La API conserva las descripciones y estados originales de los DTC sin traducirlos ni generar diagnósticos, causas, reparaciones o recomendaciones.

`analysisPreparation` indica si la extracción está preparada para solicitar orientación por IA. Cuando `available` es `true`, también incluye `input`, un DTO sanitizado que contiene exclusivamente marca, modelo, año, módulos y DTC. Cuando no está disponible, `input` se omite por completo y `reasons` explica la causa de forma controlada.

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

`POST /api/reports/analyze` es una operación separada de la carga y extracción. Recibe exclusivamente JSON estructurado y no acepta PDF, VIN, odómetro, nombres de archivo, hashes ni identificadores del reporte.

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
          "status": "current"
        }
      ]
    }
  ]
}
```

La entrada admite como máximo 40 módulos, 20 DTC por módulo y 100 DTC totales. También aplica límites de longitud a todos los textos y rechaza propiedades desconocidas.

El cuerpo JSON tiene un límite acotado de **256 KiB**. Este tamaño cubre el peor DTO actualmente válido (40 módulos, 100 DTC y todos los textos en sus longitudes máximas), pero rechaza cuerpos ajenos o sobredimensionados con HTTP `413`. El límite multipart del PDF es independiente.

La respuesta contiene un resumen técnico, hallazgos priorizados, DTC relacionado, explicación sencilla, causas posibles, comprobaciones recomendadas, advertencias de seguridad, confianza y la indicación obligatoria de que requiere confirmación del técnico. Es una orientación sugerida, no un diagnóstico definitivo.

La integración usa el SDK oficial `openai` 6.49.0 y Responses API con Structured Outputs. Las solicitudes usan `store: false`, un timeout configurable y no incluyen herramientas externas.

Variables necesarias:

- `OPENAI_API_KEY`: clave del proyecto configurada solo en el entorno del backend.
- `OPENAI_MODEL`: modelo compatible con Responses API y Structured Outputs disponible para el proyecto.
- `OPENAI_TIMEOUT_MS`: timeout opcional; el valor predeterminado es 20,000 ms.

Los errores seguros incluyen:

- `OPENAI_API_KEY_MISSING` (`503`).
- `OPENAI_MODEL_MISSING` (`503`).
- `AI_INPUT_INVALID` (`400`, o `413` para un cuerpo excesivo).
- `OPENAI_TIMEOUT` (`504`).
- `OPENAI_LIMIT_EXCEEDED` (`429`).
- `OPENAI_RESPONSE_INVALID` (`502`).
- `OPENAI_UNAVAILABLE` (`503`).

Ninguno expone la clave, el prompt interno, trazas o mensajes internos del proveedor.

### Flujo manual en la interfaz

La carga del PDF nunca solicita orientación automáticamente. Después de una extracción completa y coherente con DTC válidos:

1. La interfaz muestra los datos documentales extraídos.
2. La sección **Orientación asistida por IA** habilita **Analizar DTC con IA**.
3. Una confirmación enumera exactamente los datos técnicos que se enviarán y aclara que no se enviarán VIN, PDF, odómetro ni datos del cliente.
4. Solo **Confirmar y analizar** ejecuta `POST /api/reports/analyze` mediante el proxy de Vite.
5. La orientación se presenta separada de la extracción y siempre muestra que requiere confirmación del técnico.

Si se cambia el reporte mientras existe una solicitud pendiente, el navegador la cancela con `AbortController`, limpia la orientación anterior e ignora cualquier respuesta tardía. Los reintentos requieren una acción explícita.

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
        @{ code = "P0001"; description = "Descripción técnica de ejemplo"; status = "current" }
      )
    }
  )
} | ConvertTo-Json -Depth 6

Invoke-RestMethod -Method Post -Uri "http://localhost:3000/api/reports/analyze" -ContentType "application/json" -Body $body
```

No pegues claves en solicitudes, archivos versionados, logs ni conversaciones.

Para probar el flujo manualmente, inicia API y frontend, carga un reporte Autel compatible con al menos un DTC y verifica que no se envíe ninguna solicitud a `/api/reports/analyze` hasta completar las dos acciones de confirmación. Usa únicamente datos ficticios en entornos de desarrollo.

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
- No existe OCR; un PDF escaneado como imagen devuelve `PDF_NO_USABLE_TEXT`.
- La extracción estructura datos presentes, pero no interpreta fallas ni recomienda reparaciones.
- Un escaneo con cero DTC no demuestra que el vehículo esté libre de fallas.
