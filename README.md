# AutoDiag IA

Primera iteración de AutoDiag IA: recepción segura de reportes Autel exclusivamente en PDF.

## Aplicaciones

- `apps/web`: frontend accesible con React, TypeScript y Vite.
- `apps/api`: API con Node.js, TypeScript, Express y Multer.

## Requisitos

- Node.js `^20.19.0 || >=22.12.0`.
- npm 10 o superior.

## Instalación y desarrollo

```bash
npm install
npm run dev
```

La aplicación web se sirve en `http://localhost:5173` y la API en `http://localhost:3000`. Vite redirige las solicitudes a `/api` hacia la API durante el desarrollo.

## Carga de reportes

`POST /api/reports/upload` recibe `multipart/form-data` con un único archivo en el campo `report`.

La API valida:

- extensión `.pdf` (sin distinguir mayúsculas);
- MIME `application/pdf`;
- firma `%PDF-` al inicio del contenido;
- tamaño máximo permitido.

El archivo se mantiene únicamente en memoria durante la solicitud. No se almacena en disco, base de datos ni servicios externos. La respuesta exitosa usa HTTP `201`:

```json
{
  "id": "UUID",
  "originalName": "reporte-autel.pdf",
  "size": 123456,
  "hash": "sha256-en-hexadecimal",
  "type": "application/pdf",
  "status": "received"
}
```

Los errores tienen una estructura consistente:

```json
{
  "error": {
    "code": "INVALID_FILE_FORMAT",
    "message": "Descripción clara del error."
  }
}
```

El límite predeterminado es **10 MiB** (`10485760` bytes). Se puede configurar antes de iniciar la API mediante `REPORT_MAX_SIZE_BYTES`, con un máximo de seguridad de 100 MiB:

```bash
REPORT_MAX_SIZE_BYTES=5242880 npm run dev
```

En PowerShell:

```powershell
$env:REPORT_MAX_SIZE_BYTES=5242880
npm run dev
```

## Verificación

```bash
npm run lint
npm run build
npm test
```

Las pruebas del endpoint cubren un PDF válido, archivo ausente, formato inválido, firma falsa y tamaño excedido.

## Fuera de alcance

Esta iteración no extrae diagnósticos ni integra almacenamiento permanente, Supabase, OpenAI o n8n. Tampoco registra el contenido del PDF, VIN ni datos personales.
