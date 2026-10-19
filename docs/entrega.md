# Entrega operativa — 21 de octubre de 2026

Estado preparado localmente el 19 de octubre. No implica despliegue realizado ni calidad diagnóstica medida. Base PDF preservada: `8b486ca205cf34d3c074d27257910bf915a2fbe2`. Este cierre no cambia modelos, prompts, huellas, corpus, permisos ni timeouts.

## Instalación y configuración

Entorno verificado: Node 24.16.0 y npm 11.13.0. La limitación de Node 20 y concurrently es preexistente; no se valida aquí ese entorno. Desde la raíz:

```sh
npm ci --no-fund
npm run dev
```

Los archivos privados se preparan sin sobrescribir los existentes según el README. Nunca se incluyen en el artefacto web ni se sirven por HTTP. Nombres relevantes:

| Destino | Variables |
| --- | --- |
| API obligatoria | `VIN_HMAC_SECRET` (al menos 32 bytes, estable y privado) |
| API Auth e historial | `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` |
| Análisis | `OPENAI_API_KEY`, `OPENAI_MODEL`; `OPENAI_REASONING_EFFORT` opcional, sin cambiar su default |
| RAG opcional backend | `RAG_ENABLED`, `OPENAI_EMBEDDING_MODEL`, `RAG_MATCH_COUNT`, `RAG_MATCH_THRESHOLD`, `RAG_MAX_CONTEXT_CHARACTERS` |
| Red/recursos backend | `PORT` y los límites numéricos documentados en README y `.env.example` |
| Web, públicos y de build | `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` |

El secreto HMAC puede generarse localmente con `node --input-type=module -e "import { randomBytes } from 'node:crypto'; console.log(randomBytes(48).toString('base64'))"`. Guardarlo solo en el gestor de secretos/archivo privado. No rotarlo inadvertidamente: cambiarlo altera identidad de VIN y fingerprints privados. Ninguna clave secreta puede usar prefijo `VITE_`.

Desarrollo: API `http://localhost:3000`, web `http://localhost:5173`; `npm run dev` inicia ambos y Ctrl+C los detiene. Alternativas: `npm run dev --workspace @autodiag/api` y `npm run dev --workspace @autodiag/web`.

## Build y arranque fuera de Vite dev

```sh
npm run build
npm run start --workspace @autodiag/api
```

`start` ejecuta `node dist/index.js` desde el workspace API, no carga dotenv automáticamente. En hosting se inyecta la configuración en el entorno del proceso. Alternativa local explícita, desde la raíz y solo por el operador: `node --env-file=.env apps/api/dist/index.js`. No incorporar este flag al extractor. El build web normal carga las variables públicas locales: debe hacerlo el operador con configuración autorizada del destino. Cambiar las variables públicas requiere reconstruir la web.

Artefactos: conservar **todo** `apps/api/dist`, incluidos `pdf-extractor-child.mjs`, `pdf-extractor-worker.mjs` y `pdf-process-protocol.js`, y las dependencias de producción instaladas desde el lockfile; no basta copiar `index.js`. El hijo compilado no requiere tsx. Conservar `apps/web/dist` completo (HTML y assets con hash/logo). No publicar la raíz del repositorio, sourcemaps API, `.env` ni `node_modules` como archivos estáticos. El proceso API necesita poder lanzar Node hijo, IPC y permisos mínimos de ejecución; PDF.js tiene módulos nativos y debe instalarse en el sistema/arquitectura de destino, no copiar node_modules entre sistemas.

### Comunicación y topologías compatibles

Las solicitudes del navegador son relativas a `/api`. **No hay URL API configurable en la web actual**: el despliegue compatible debe presentar web y API bajo un mismo origen público. No depende del proxy Vite en producción y no requiere CORS abierto. Dos alternativas sin elegir proveedor:

1. Servidor estático y API en una máquina/contenedor compuesto, detrás de proxy inverso HTTPS.
2. Hosting estático y API en servicios separados, con gateway/rewrites que publique `/api/*` bajo el mismo origen del frontend. No redirigir el navegador al origen interno.

Ejemplo de reglas Nginx para el operador (no aplicado; rutas y TLS por definir):

```nginx
# Dentro del server HTTPS del dominio elegido:
root /srv/autodiag/web;
client_max_body_size 11m;
location /api/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_read_timeout 90s;
    proxy_send_timeout 90s;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    access_log off;
}
location / { try_files $uri $uri/ /index.html; }
```

`proxy_pass` sin sufijo URI conserva `/api`. Los 90s corresponden al presupuesto API máximo de 80s, sin cambiarlo. El límite de proxy 11 MiB admite multipart con un PDF default de 10 MiB; si se cambia el límite API, ajustar el del proxy y comprobar sus errores (un rechazo del proxy puede no devolver JSON API). No cachear `/api`, tokens ni respuestas autenticadas. Evitar logs de bodies, credenciales, Authorization y parámetros privados. Mantener la API interna no expuesta directamente; verificar IP del limitador de login y política de proxy confiable antes de un despliegue multiusuario: la API no configura `trust proxy` y no se debe habilitar confianza indiscriminada. El rate limiter/idempotencia/cupos son por proceso, no distribuidos. Verificar timeouts del gateway/hosting y soporte de procesos hijos; una plataforma estática/serverless restringida no equivale a un host Node compatible.

Publicar web y API en orígenes distintos sin gateway **no está preparado**: requeriría una decisión posterior de URL y CORS con allowlist, no `*`. No se selecciona hosting, dominio ni certificado en este cierre. `vite preview` no es servidor de producción. La web se sirve en la raíz `/`; un subpath requiere configuración y verificación adicional de assets.

Health operativo: `GET /api/health` devuelve únicamente `{"status":"ok"}`. No demuestra conexión a proveedores ni disponibilidad de generación. La configuración HMAC inválida impide arrancar; Auth ausente devuelve error público seguro y no habilita endpoints privados. No sustituir estas validaciones con valores de ejemplo en producción.

## Comprobación desconectada reproducible

```sh
npm run build --workspace @autodiag/api
node --test apps/api/scripts/verify-compiled.test.mjs
npm test
npm run lint
```

El script compilado usa PDFs sintéticos, autenticación simulada y un proceso API con entorno explícito sin credenciales. Comprueba cuatro escenarios: contención de exit 23 y siguiente Autel correcto; PDF vacío/dañado; protección HTTP/historial no configurado; arranque de `dist/index.js`, health y fallo Auth seguro. Cierra su propio proceso. No usa `.env`, servidores de desarrollo ni proveedores. Requiere dependencias de desarrollo para PDF-lib/supertest; no se ejecuta en el host reducido de producción.

Para comprobar el build web **sin leer archivos de entorno reales**, desde la raíz:

```sh
npm exec --workspace @autodiag/web -- tsc --noEmit
npm exec --workspace @autodiag/web -- vite build --mode test
```

La configuración existente `envDir: false` en modo test evita archivos dotenv. Este artefacto sin claves públicas sirve para comprobar empaquetado y error de configuración, **no para login real ni publicación**. El build de entrega normal debe reconstruirse con las variables públicas correctas. No confundir una compilación exitosa con comprobación visual/red del gateway real.

### Evidencia y límites

- Aislamiento anterior al último P2: suite 902/902 y comprobación compilada 3/3.
- Último P2 de supervisión: 43 focalizadas, comprobación compilada y revisión final aprobadas; no atribuirle retroactivamente la suite anterior.
- El usuario confirmó ensayo manual completo, historial/PDF y recuperación después de reiniciar API. No se repitieron aquí llamadas reales.
- Los resultados de este cierre se registran al final de este documento. Mocks verifican contratos, no credenciales remotas, RLS real ni relevancia de recuperación.
- No se demuestra estabilidad permanente ni la instrucción nativa responsable de la AV anterior. Véase [diagnóstico PDF](diagnostico-worker-pdf.md). Heap V8 no limita toda la memoria nativa; IPC/watchdog no sustituye supervisor del sistema ante bloqueo nativo absoluto.

### Resultado de este cierre (19 de octubre)

| Control ejecutado | Resultado observado |
| --- | --- |
| Build API (`npm run build --workspace @autodiag/api`) | Aprobado, incluido hijo `.mjs` |
| Script compilado de cuatro escenarios | 4/4; repetido tras hacer explícitos imports/globales de lint, 4/4 |
| Suite normal `npm test` (una ejecución) | API 701/701, 36 archivos; frontend 205/205, 7 archivos; total 906/906, sin errores del pool en esta ejecución |
| Lint | Primer intento: cinco errores `no-undef` del nuevo script `.mjs`; corregidos con imports explícitos y `globalThis.fetch`, sin cambiar configuración; segundo intento aprobado |
| Build web sin dotenv | TypeScript y `vite build --mode test` aprobados; advertencia conocida de chunk mayor de 500 kB |
| Assets referenciados por HTML compilado | Dos entradas JS/CSS presentes; no equivale a inspección visual en navegador |
| Diff y archivos nuevos | Diff-check y whitespace aprobados; escaneo razonable sin candidatos sensibles; entornos ignorados/no rastreados, manifiestos/lockfile intactos |

Una comprobación auxiliar inicial de assets falló por escape de comillas del comando Node en PowerShell; se corrigió la comprobación usando PowerShell y pasó. No fue fallo del artefacto. No hubo aserciones fallidas ni pérdida de worker en la suite de este cierre. El proceso API temporal creado por el script se cerró y esperó explícitamente; no se iniciaron servicios de desarrollo. No se hicieron instalaciones, auditorías repetidas, llamadas a proveedores ni conexiones remotas. La suite completa no incluye el script Node: sus 4 casos se informan separadamente, no dentro de los 906.

## Guía de usuario y demostración de cinco minutos

1. **0:00–0:40**: iniciar sesión privada; no hay autorregistro. Explicar que la orientación necesita confirmación profesional.
2. **0:40–1:40**: seleccionar/arrastrar un PDF Autel autorizado con texto digital. Revisar vehículo, conteos, estados y advertencias; un reporte parcial puede bloquear análisis. No utilizar datos personales en una demostración compartida.
3. **1:40–2:50**: añadir observaciones técnicas sin datos personales y revisar la confirmación. Solo la acción explícita solicita análisis. Reservar margen para generación; no presentar la espera como latencia garantizada.
4. **2:50–3:40**: mostrar resumen, hallazgos, comprobaciones, prioridad, confianza y advertencias. Una coincidencia RAG no confirma la causa. Explicar procedencia y aplicabilidad desconocida; el corpus activo es demostrativo, 16 fragmentos `demonstration_corpus_v1`, no documentación oficial validada. TPMS sigue separado y sin activar.
5. **3:40–4:30**: comprobar `history.status`; abrir historial propio y regenerar PDF desde snapshot. Abrir/exportar no repite modelo ni RAG. El PDF descargado se consulta sin conexión, no es el original Autel.
6. **4:30–5:00**: repetir idéntica entrada para explicar reutilización cuando corresponda (`reused`), no vender milisegundos de recuperación como velocidad de generación. Cerrar sesión y comprobar desaparición del workspace.

Preparar caso autorizado y resultado guardado como respaldo; no fingir que una captura es ejecución nueva. No reproducir un fallo deliberado con datos reales en una exposición sin consentimiento.

## Recuperación operativa

- **API apagada/red**: no cerrar sesión por este solo hecho. Usar Comprobar conexión y Reintentar explícitamente cuando vuelva. Si no vuelve, comprobar proceso/logs saneados y gateway; health no certifica proveedores.
- **Timeout de análisis**: conservar extracción y revisar el error; reintento manual de la misma entrada puede recuperar/esperar la operación existente. No enviar múltiples análisis concurrentes ni cambiar observaciones accidentalmente. No cambiar modelo/timeouts durante la demo para esconder el fallo.
- **Carga fallida**: revisar PDF digital, tamaño, formato y mensaje controlado. Volver a seleccionar/cargar explícitamente; no hay retry automático de extracción. Saturación: esperar a que cierre otra extracción.
- **Historial unavailable**: el análisis puede seguir siendo válido con HTTP 200, pero no se confirmó guardado. Descargar localmente si procede; no anunciar persistencia exitosa.
- **Fallo temporal de Auth**: esperar/reintentar sin mostrar datos del workspace anterior durante validación neutral. Un 401 definitivo o logout sí requiere nueva sesión; un 403 no es logout automático.

## Migraciones: orden y comprobación administrativa

No ejecutar SQL por seguir esta guía sin reconciliar el destino. El usuario reportó `profiles` aplicado manualmente y funcionamiento del historial; este cierre no inspeccionó la base remota. El historial de migraciones de Supabase y los objetos reales pueden diferir. Realizar backup y revisión administrativa antes de cualquier futura aplicación; no automatizar `db push` ni reparar historial a ciegas.

Orden local:

1. `20260821000100_create_diagnostic_history.sql`
2. `20260917000100_create_profiles.sql`
3. `20260922000100_create_rag_knowledge.sql`
4. `20261013000100_add_diagnostic_analysis_fingerprints.sql`
5. `20261016000100_correct_diagnostic_history_uniqueness.sql`

Consultas de solo lectura para un administrador autorizado, **no ejecutadas aquí** (no extraen filas de clientes ni secretos):

```sql
select version from supabase_migrations.schema_migrations order by version;
select n.nspname, c.relname, c.relrowsecurity, c.relforcerowsecurity
from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname in ('profiles','diagnostic_history','knowledge_chunks');
select schemaname, tablename, policyname, roles, cmd, qual, with_check
from pg_catalog.pg_policies where schemaname='public'
and tablename in ('profiles','diagnostic_history','knowledge_chunks');
select indexname, indexdef from pg_catalog.pg_indexes
where schemaname='public' and tablename='diagnostic_history';
select column_name, data_type, character_maximum_length
from information_schema.columns where table_schema='public'
and table_name='diagnostic_history' order by ordinal_position;
select grantee, table_name, privilege_type from information_schema.table_privileges
where table_schema='public' and table_name in ('profiles','diagnostic_history','knowledge_chunks');
select grantee, column_name, privilege_type from information_schema.column_privileges
where table_schema='public' and table_name='diagnostic_history';
select e.extname, e.extversion, n.nspname from pg_catalog.pg_extension e
join pg_catalog.pg_namespace n on n.oid=e.extnamespace where e.extname='vector';
select pg_catalog.pg_get_functiondef(p.oid) from pg_catalog.pg_proc p
join pg_catalog.pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname='match_knowledge_chunks';
```

La existencia de políticas no prueba su eficacia: comprobar con dos usuarios autorizados el aislamiento y acceso denegado, sin compartir tokens. El índice por fingerprint y el parcial legacy deben coexistir. El RPC requiere vector en `extensions` y permisos de service_role; no habilitar candidatos ni ingesta como parte de reconciliar migraciones.

## Matriz de entrega

| Requisito | Implementación/evidencia | Pendiente |
| --- | --- | --- |
| Login/sesión privada | Implementado; mocks y ensayo reportado por usuario | Comprobar configuración del destino, registro deshabilitado y usuarios autorizados |
| PDF Autel/extracción aislada | Implementado; sintéticos reales en hijo compilado y ensayo usuario | Smoke del artefacto en sistema de entrega; no garantía de ausencia de AV |
| Análisis/confirmación/idempotencia | Implementado; contratos simulados y ensayo usuario | No se ha medido precisión diagnóstica |
| RAG/procedencia | Implementado; transporte validado mediante mocks | Relevancia real, revisión técnica y TPMS pendientes; no activar candidatos |
| Historial/PDF | Implementado; aislamiento probado localmente y ensayo usuario | Reconciliación administrativa y prueba del destino |
| Arranque compilado | API y extractor comprobados; web empaquetada sin dotenv real | Dominio, HTTPS, gateway, IP/rate-limit y prueba de navegador en destino |
| Evaluación | Formato/evaluador offline y baseline Mazda exploratorio | Casos autorizados, etiquetas técnicas, reserva ciega y criterios de aceptación |
| n8n/Power BI/aprendizaje supervisado | No implementados; no se encontró compromiso de entrega en documentación versionada | Confirmar rúbrica externa si los exige; no marcarlos completos |

La búsqueda documental solo demuestra lo que contiene el repositorio: no sustituye la rúbrica del curso. No hay porcentajes de avance ni precisión acreditados. La herramienta de evaluación y sus fixtures no son una evaluación real del modelo. La orientación generada nunca equivale a diagnóstico confirmado.

## Pendientes por prioridad

1. Confirmar si la entrega es local o exige URL; fijar sistema de destino y contrastar rúbrica (especialmente integraciones externas).
2. Operador: revisar migraciones/seguridad sin reaplicar SQL y ejecutar smoke de navegador sobre artefacto de entrega, con datos autorizados.
3. Revisar este diff y preparar la demostración con respaldo y límites de evidencia; publicación solo con autorización posterior.
