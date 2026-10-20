# Entrega operativa — 21 de octubre de 2026

Guía operativa para la entrega. URL comunicada por el usuario: **https://autodiag-ia.onrender.com/**. El usuario reportó funcionamiento del flujo en Render; esta actualización documental no visitó el servicio ni reprodujo esas comprobaciones. Funcionamiento observado no equivale a calidad diagnóstica medida ni a una validación integral de seguridad de producción.

Base PDF preservada: `8b486ca205cf34d3c074d27257910bf915a2fbe2`. La preparación Render y la corrección de referencias internas están integradas en `main`, base de este cierre documental: `61ab3ea16fc6e69a4ca511734fb17f31c5eee4e0`. No se ha comprobado aquí el SHA desplegado ni la configuración privada del servicio. Las secciones de pruebas locales posteriores conservan su fecha y alcance históricos; no son nuevas pruebas remotas.

## Arquitectura actual y evidencia reportada

React compilado y la API Express se sirven juntos desde un único Render Web Service, bajo el mismo origen HTTPS; el navegador utiliza rutas relativas `/api`. Express valida el PDF y ejecuta su extracción en procesos hijos supervisados. Supabase proporciona Auth e historial estructurado por usuario; la integración RAG usa pgvector cuando está habilitada y configurada. OpenAI proporciona el análisis estructurado y, cuando corresponde, embeddings para recuperación. El PDF descargable se genera localmente desde los datos disponibles, sin repetir el análisis. No se inspeccionó la configuración remota para inferir modelos o estado efectivo de RAG.

**Alcance de esta entrega: demostración con una cuenta autorizada, no apertura multiusuario general.** Esto no desactiva autenticación, RLS ni aislamiento por identidad. La API protege upload, análisis e historial; las consultas de historial filtran por el UUID autenticado y las migraciones versionadas mantienen RLS. Las pruebas con mocks no certifican el estado real de las políticas remotas. El pendiente de proxies sigue abierto incluso con una sola cuenta: otros intentos fallidos podrían compartir cupo si llegan por el mismo proxy.

### Versiones comprobables y trazabilidad

| Elemento | Valor comprobable localmente | Límite |
| --- | --- | --- |
| Código base | `61ab3ea16fc6e69a4ca511734fb17f31c5eee4e0`, merge Render/referencias en `main` | Este cierre solo cambia documentación en `docs/final-delivery`; no acredita el SHA servido por Render |
| Paquetes de la aplicación | `0.1.0` en raíz y ambos workspaces | No identifica por sí solo un despliegue; conservar también el SHA |
| Prompt de análisis | `diagnostic_prompt_v2_reference_ids` | Incluido en fingerprint; no atribuirlo retrospectivamente a capturas sin versión |
| Pipeline / huella | `analysis_pipeline_v2_rag_provenance`; `analysis_v1`, `pdf_v1` | Modelo, esfuerzo explícito, inputs y configuración RAG participan en identidad; no borrar historial para cambiar de versión |
| Esquema público / historial | `diagnostic_output_schema_v1`; historial `1` | Las referencias internas se restituyen al contrato público antes de guardar/exportar |
| Corpus activo en el repositorio | **16 fragmentos**, `demonstration_corpus_v1` | No se comprobó el contenido remoto de pgvector; los tres candidatos TPMS no están activados |
| Modelo de análisis | Selección privada mediante `OPENAI_MODEL`, sin modelo predeterminado en el servidor | Nombre efectivo **no verificado aquí**. El usuario comunicó conservar el anterior; no se infiere leyendo ejemplos o tiempos. Un detalle histórico validado incluye `analysisModel` para esa ejecución, no para todas |
| Esfuerzo / embeddings | Esfuerzo opcional; omitido conserva comportamiento previo. Default de embeddings en código: `text-embedding-3-small` | No se verificó configuración efectiva remota; no cambiarla para la entrega |
| Entorno local de este cierre | Node **24.16.0**, npm **11.13.0** | No certifica la versión del proceso remoto |

El operador puede anotar únicamente SHA, modelo declarado para la demostración y versiones técnicas, sin compartir claves o archivos de entorno. Si no se capturaron, conservarlos como desconocidos. No se exige cambiar modelo ni regenerar un diagnóstico para completar este registro.

### Pruebas manuales comunicadas por el usuario

| Caso/recorrido | Resultado reportado | Alcance de la evidencia |
| --- | --- | --- |
| BMW, ejecución inicial | HTTP 200 en **24,81 s** | Una medición manual; sin captura independiente de inputs, versiones, tokens o `reused` en este registro |
| BMW, repetición | **287 ms** | Compatible con reutilización del diagnóstico; no demuestra generación del modelo en ese tiempo. No se aportó aquí un HTTP separado para esta repetición |
| Toyota | HTTP 200 en **33,22 s** | Una medición manual, no percentil ni compromiso de latencia |
| Historial y exportación PDF | Funcionando según el usuario | Recorrido manual reportado; no acredita por sí solo todas las políticas RLS, variantes de documentos o navegadores |

Estos datos no fueron reproducidos por el agente. No se reconstruyen inputs ni se inventan modelo efectivo, versiones desplegadas, consumo, calidad de causas o revisión profesional. Confirmar `reused` para separar generación nueva de recuperación; las repeticiones rápidas no se incluyen como latencia de generación. La muestra es exploratoria y pequeña: no demuestra precisión, superioridad general ni ausencia de fallos. Véanse el [evaluador y sus límites](evaluacion-calidad/README.md) y el [baseline Mazda exploratorio](evaluacion-calidad/exploratorio-mazda3-2019.md), que permanece intacto.

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
npm start
```

El nuevo `start` raíz ejecuta `node apps/api/dist/index.js`; el comando individual `npm run start --workspace @autodiag/api` sigue disponible. Ninguno carga dotenv automáticamente. **Configurar `NODE_ENV=production`** para servir también la web; en desarrollo se conserva Vite y el arranque API no necesita build web. En hosting se inyecta la configuración en el entorno del proceso. Alternativa local explícita, desde la raíz y solo por el operador con `NODE_ENV=production`: `node --env-file=.env apps/api/dist/index.js`. No incorporar este flag al extractor. El build web normal carga las variables públicas locales: debe hacerlo el operador con configuración autorizada del destino. Cambiar las variables públicas requiere reconstruir la web.

Artefactos: conservar **todo** `apps/api/dist`, incluidos `pdf-extractor-child.mjs`, `pdf-extractor-worker.mjs` y `pdf-process-protocol.js`, y las dependencias de producción instaladas desde el lockfile; no basta copiar `index.js`. El hijo compilado no requiere tsx. Conservar `apps/web/dist` completo (HTML y assets con hash/logo). No publicar la raíz del repositorio, sourcemaps API, `.env` ni `node_modules` como archivos estáticos. El proceso API necesita poder lanzar Node hijo, IPC y permisos mínimos de ejecución; PDF.js tiene módulos nativos y debe instalarse en el sistema/arquitectura de destino, no copiar node_modules entre sistemas.

### Render: un único Web Service, sin Nginx ni Vite en producción

Decisión autorizada: React compilado y Express bajo el mismo origen en un **Render Web Service Node**. Supabase y OpenAI existentes no cambian. Las solicitudes relativas `/api` ya apuntan a este mismo servicio; no hay `VITE_API_URL`, CORS abierto ni segunda aplicación web que configurar. Render termina HTTPS y reenvía al puerto HTTP de Express. La API escucha explícitamente en `0.0.0.0` y usa `PORT` validado entre 1 y 65535.

En producción Express resuelve `apps/web/dist` desde la ubicación de su módulo, no desde cwd. Falla al arrancar si falta index. Solo expone index y assets de extensiones autorizadas dentro del build (verificación de realpath); no sirve sourcemaps, dotfiles, fuentes, dependencias o directorios del repositorio. Fallback React solo para GET/HEAD de rutas sin extensión que aceptan HTML y representan navegación, nunca `/api`, assets ausentes u otros métodos. Los 404 desconocidos de API son JSON. Las respuestas llevan `Cache-Control: no-store`, incluidos errores y datos privados; no activar edge caching de `/api`. Se conserva Vite en desarrollo. No publicar la raíz del repo como carpeta estática.

#### Campos de referencia del servicio existente

Receta de configuración conservada para revisión por el operador; no crear otro servicio. La existencia y funcionamiento del destino fueron reportados por el usuario, pero los campos reales del Dashboard no se inspeccionaron en este cierre.

| Campo Render | Valor |
| --- | --- |
| Tipo | Web Service |
| Repository | `https://github.com/jjhernandezhf/autodiag-ia` |
| Branch | `main` tras el merge aprobado; confirmar privadamente la rama y el SHA efectivos en el servicio existente |
| Root Directory | Vacío (raíz del monorepo; no `apps/api`) |
| Runtime / Language | Node, runtime nativo, sin Docker |
| Node | `.node-version`: `24.16.0`; quitar un `NODE_VERSION` remoto contradictorio o fijarlo al mismo valor |
| Build Command | `npm ci --include=dev --no-fund && npm run build` |
| Start Command | `npm start` |
| Health Check Path | `/api/health` |
| Pre-Deploy Command | Vacío; ninguna migración ni ingesta automática |
| Instances | 1, sin autoscaling inicial |
| Auto-Deploy | Desactivado inicialmente; despliegue manual autorizado después de revisar variables y commit |
| Plan / Region | Decisión del operador según memoria medida y proximidad al Supabase existente; no contratado aquí |

`--include=dev` es necesario para TypeScript/Vite aunque `NODE_ENV=production`. No se actualiza ni regenera lockfile; `npm ci` instala desde él. No copiar node_modules de Windows a Linux. Se comprobaron nombres de imports con TypeScript `forceConsistentCasingInFileNames` y nombres reales. El flujo reportado en Render aporta evidencia operativa del destino, no una auditoría independiente de su instalación nativa, recursos o versión exacta de Node. Node se fija a la versión local comprobada, sin afirmar validación de otras versiones.

#### Variables en Environment del servicio

Introducir sus valores privadamente en Render Dashboard > servicio > Environment; nunca en Git, logs, capturas ni este documento. No subir `.env` o `.env.local`. Render pone a disposición variables del servicio durante build y runtime: no confundir acceso del proceso de build con exposición al navegador.

| Variables | Uso / configuración |
| --- | --- |
| `NODE_ENV` | `production`, imprescindible para servir el build web |
| `PORT` | Usar el proporcionado por Render (habitualmente 10000); no fijarlo a 5173 |
| `TRUSTED_PROXY_IPS` | Lista CSV opcional de hasta 32 IP **exactas** de proxies de entrada verificados; vacío conserva confianza deshabilitada. No usar direcciones de salida, alias, CIDR ni cantidad de saltos |
| `VIN_HMAC_SECRET` | Secreto backend obligatorio; conservar el existente, no regenerarlo durante despliegue |
| `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` | Backend del proyecto existente; el contrato actual exige claves publishable/secret con formato moderno, no sustituir por un JWT `service_role` legacy |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | Backend; conservar modelo y cuenta ya operativos sin inferir sus valores privados |
| `OPENAI_REASONING_EFFORT` | Opcional; preservar selección existente, vacío conserva comportamiento anterior |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` | Públicas, usadas en build; deben apuntar al mismo proyecto de Auth que el backend |
| Variables RAG y límites de `.env.example` | Replicar configuración operativa existente; vacíos opcionales conservan defaults. No activar/desactivar RAG ni cambiar modelos, umbrales o presupuestos por este despliegue |

Nunca introducir `VITE_OPENAI_API_KEY`, `VITE_SUPABASE_SECRET_KEY`, secretos HMAC ni credenciales con ningún prefijo `VITE_`. El navegador solo lee las dos variables públicas indicadas; una configuración pública faltante produce una pantalla segura de configuración, no acceso al workspace. El backend sin configuración de Auth devuelve error público seguro. Health no detecta estos errores funcionales.

#### Memoria, coordinación y cierre

La API comparte la memoria del servicio con hasta **dos extractores Node hijos**. Cada hijo usa old-space V8 de 192 MiB y stack 4096 KiB por defecto; esos números no incluyen todo el heap, código, buffers, IPC, PDF.js ni memoria nativa. Dos old-spaces suman 384 MiB, **no** una estimación de RSS ni un tamaño recomendado de plan. No asegurar que el plan mínimo alcanza: medir picos de API + hijos, carga simultánea, límite de archivo, páginas y documentos autorizados en Linux. No hay disco persistente para PDFs.

Al recibir SIGTERM/SIGINT se deja de aceptar conexiones, se bloquean nuevas extracciones y se terminan los hijos; el cierre espera su terminación física antes de salir normalmente. Conexiones restantes se cierran al completar esa limpieza. Hay una salida de emergencia a 25s (no es un cambio al timeout de análisis/PDF); Render documenta SIGKILL a los 30s por defecto. Un despliegue puede interrumpir solicitudes activas: no prometer que un análisis iniciado finalice durante el apagado. Mantener la supervisión IPC/deadline del hijo y las limitaciones nativas documentadas.

Idempotencia de transporte, rate limit, tokens temporales de upload y dos cupos viven en memoria de una API. Historial por usuario/fingerprint permanece en Supabase. Reinicios pierden coordinación en vuelo; una sola instancia configurada no elimina el solapamiento temporal entre instancia antigua y nueva durante un deploy. Evitar despliegues durante análisis y no garantizar deduplicación física entre procesos/replicas. Escalar exige coordinación compartida, no está implementado.

#### Proxies confiables y activación pendiente en Render

`TRUSTED_PROXY_IPS` ausente, vacío o solo espacios mantiene `trust proxy = false`: Express usa el peer directo e ignora las IP reenviadas para identificar al cliente. Una cabecera falsificada desde un peer no confiable no cambia su cupo. Se conservan los diagnósticos de express-rate-limit; si alguien envía X-Forwarded-For con confianza deshabilitada, puede aparecer `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR`. No se suprime esa validación ni se interpreta el aviso como habilitación de confianza.

La política opt-in acepta como máximo 32 IP exactas IPv4/IPv6, con longitud total de CSV de hasta 2048 caracteres. No admite `true`, números de saltos, nombres como `loopback`/`uniquelocal`, dominios, CIDR, puertos o zonas IPv6. Estos límites son de validación/recursos, **no una afirmación sobre cuántos proxies tiene Render**. La configuración inválida impide arrancar con un error de configuración sin reflejar el valor rechazado. Las IP equivalentes se normalizan, incluidas IPv4 mapeadas en IPv6.

Express recibe la lista explícita y recorre X-Forwarded-For desde el peer hacia atrás hasta el primer cliente no confiable; nunca se toma arbitrariamente la primera IP. Solo para login desde un peer declarado confiable, se exige una cadena de IP válida y acotada (hasta 32 entradas y 2048 caracteres). Cadena ausente, vacía, malformada o sin cliente no confiable devuelve `AUTH_REQUEST_INVALID` 400, antes del limitador/servicio Auth y sin imprimir la cadena. Las formas equivalentes de IP se normalizan sin cambiar el orden. El limitador conserva su clave y validaciones predeterminadas, agrupación IPv6 /56, ventana de 15 minutos y diez fallos; los logins exitosos no consumen el cupo. No se analiza `Forwarded` como identidad alternativa.

**No hay ninguna IP ni topología Render habilitada por defecto.** La documentación pública consultada no acredita para este servicio una lista estable de peers de entrada ni su política completa de cabeceras. No confundir IP dedicadas/de salida (egress) con proxies de entrada al proceso. El servicio ya tiene una URL comunicada, pero su aislamiento de cupos por cliente detrás del proxy **no está validado**; no se aprueba su uso público multiusuario como seguro por el mero hecho de funcionar. Sin confianza configurada, varios clientes pueden compartir el cupo del proxy. Un mock con loopback es solo un transporte de prueba y no justifica configurarlo en Render.

El diagnóstico de proxies se pospone para la entrega. Los siete archivos de la sonda permanecen sin publicar en `fix/render-login-rate-limit`, fuera de este worktree y de esta entrega. Su **P2 de registro literal del peer, que puede ser un cliente directo, sigue abierto**; no activar ni incorporar esa sonda. Posponerla no resuelve el aislamiento del limitador. Mantener diez fallos por quince minutos y no habilitar confianza supuesta, suprimir validaciones ni provocar bloqueos durante la demostración.

Procedimiento pendiente para habilitar y validar aislamiento multiusuario, no para ejecutar durante la entrega:

1. Obtener de Render la identificación autorizada de los proxies de entrada, su estabilidad/rotación, todos los caminos hasta el servicio y cómo añaden o sobrescriben X-Forwarded-For. Comprobar que no se puede alcanzar la API por una ruta que eluda esos proxies. No deducir una allowlist a partir de una única IP observada. Si solo se documentan redes dinámicas o no se pueden acreditar IP exactas estables, **no habilitar confianza supuesta**: esta política estrecha aún no basta para ese destino y deberá revisarse con evidencia antes de abrir login multiusuario.
2. Configurar privadamente `TRUSTED_PROXY_IPS` con las IP exactas confirmadas, nunca IP de clientes finales ni de salida. Revisar equivalencia IPv4/mapped IPv4/IPv6 y reinicios/caminos alternativos. Conservar `NODE_ENV=production`; no activar autorregistro.
3. En una ventana de prueba sin usuarios activos y desde dos redes externas distintas A/B, enviar a `/api/auth/login` únicamente usuario inexistente y contraseña sintética. Diez fallos de A deben devolver 401; el siguiente de A, 429; una solicitud de B debe seguir devolviendo 401, no 429. Registrar solo etiquetas A/B, conteos, códigos y headers RateLimit, nunca IP reales, credenciales, tokens o cabeceras completas.
4. Desde A ya limitado, repetir añadiendo IP falsas en X-Forwarded-For (direcciones de documentación, no identidades de terceros): debe seguir 429. Probar IPv4/IPv6 si ambas rutas existen. La rotación de sufijos dentro del mismo /56 IPv6 no debe permitir evadir el límite. Una respuesta 400 por cadena o un diagnóstico del limitador requiere revisar la topología; no desactivar validaciones para conseguir 401.
5. Usar las respuestas de los endpoints existentes; **no añadir un endpoint permanente de depuración ni logs de req.ip/cabeceras**. Solicitar al proveedor evidencia del peer/cadena por su canal administrativo autorizado si falta. Esperar la ventana de 15 minutos y confirmar recuperación; no reiniciar solo para ocultar la agregación. No se ejecutaron estas comprobaciones remotas aquí.

Para revertir la opción, vaciar `TRUSTED_PROXY_IPS` y reiniciar restaura el modo directo; detrás de un proxy esto puede volver a agrupar clientes y **no es una solución para producción multiusuario**. Revisar logs del proveedor sin publicar tokens/Authorization. La exposición pública requiere validar HTTPS, permisos, registro público deshabilitado y acceso con dos usuarios autorizados.

Fundamento: [Express detrás de proxies](https://expressjs.com/en/guide/behind-proxies/), [errores y validaciones del limitador](https://express-rate-limit.mintlify.app/reference/error-codes), [guía de proxies del mantenedor](https://express-rate-limit.mintlify.app/guides/troubleshooting-proxy-issues). No se cambian auth, permisos ni límites para resolver la configuración.

#### Comprobación y reversión del despliegue (operador)

1. En el servicio existente, confirmar privadamente Node/commit/build y configuración esperada. Cualquier nuevo despliegue o cambio operativo requiere autorización independiente. No agregar base de datos, migraciones ni ingesta.
2. Abrir URL HTTPS, `/api/health`, recargar una navegación, comprobar carga de JS/CSS/logo y 404 JSON en `/api/inexistente`; comprobar que `.env`, fuentes y assets ausentes no devuelven HTML. Sin tokens, `/api/history` debe devolver 401 y no datos cacheables.
3. El usuario reportó login/flujo de análisis, historial y PDF funcionando. Para ampliar o repetir esa comprobación, usar configuración privada y autorización de consumo, distinguir análisis nuevo de reutilizado y revisar fuentes/guardado por usuario. **No se ejecutó en esta actualización documental**. No activar candidatos TPMS.
4. Medir memoria/latencia/cold start, dos cargas simultáneas y recuperación tras reinicio; revisar errores nativos y que no sobrevivan extractores. Health verde solo demuestra HTTP, no integración ni calidad.
5. Si falla, detener pruebas y auto-deploys. Si existe un despliegue anterior **compatible con servicio único**, usar Rollback del Dashboard o redeploy de su commit registrado y verificar variables/health/flujo. Si es el primer despliegue, no hay rollback Render probado: suspender el servicio y conservar la versión local estable. Volver a un commit anterior al servicio estático no conserva la web pública. El rollback de código no revierte variables, migraciones ni datos; no borrar historial, rotar secretos o reaplicar SQL para revertir.

Fuentes oficiales consultadas durante la preparación anterior: [Web Services y puerto](https://render.com/docs/web-services), [versión de Node](https://render.com/docs/node-version), [raíz monorepo](https://render.com/docs/monorepo-support), [health](https://render.com/docs/health-checks), [deploy y graceful shutdown](https://render.com/docs/deploys). No se accedió a cuenta Render, se creó servicio ni se consultaron fuentes externas durante esta actualización documental.

Health operativo: `GET /api/health` devuelve únicamente `{"status":"ok"}`. No demuestra conexión a proveedores ni disponibilidad de generación. La configuración HMAC inválida impide arrancar; Auth ausente devuelve error público seguro y no habilita endpoints privados. No sustituir estas validaciones con valores de ejemplo en producción.

## Comprobación desconectada reproducible

```sh
npm run build --workspace @autodiag/api
npm run build --workspace @autodiag/web -- --mode test
node --test apps/api/scripts/verify-compiled.test.mjs
npm test
npm run lint
```

El script compilado usa PDFs sintéticos, autenticación simulada y procesos con entorno explícito sin credenciales. Comprueba contención de exit 23 y siguiente Autel correcto; PDF vacío/dañado; protección HTTP/historial no configurado; arranque productivo desde cwd temporal, web/assets/navegación y API bajo un origen; cierre con extractor real activo. Cierra sus propios procesos. La prueba de shutdown emite SIGTERM dentro del proceso porque `kill` en Windows no ejecuta el handler JS; no demuestra recepción de señales del sistema en Linux. No usa `.env`, servidores de desarrollo ni proveedores. Requiere dependencias de desarrollo para PDF-lib/supertest; no se ejecuta en el host reducido de producción. Construir ambos workspaces antes de ejecutar el script.

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

### Preparación del servicio único Render: evidencia local histórica

- Rama de trabajo `feat/render-single-service`, base `cfdd2627a17a9faeee4c0e5782af71df9f2bbf98`. Aislamiento PDF anterior conservado, sin actualizar dependencias ni lockfile.
- Rutas estáticas, navegación, archivos privados, autenticación y shutdown: focalizadas **19/19**. Primer comando pasó también el filtro `src` del script npm y ejecutó una API completa **719/719**, más amplia de lo previsto; luego se usó `npm exec --workspace @autodiag/api -- vitest run src/production-web.test.ts src/pdf-shutdown.test.ts src/runtime-workflow.test.ts` para seleccionar exactamente los tres archivos.
- Comprobación compilada: primer intento **4/5**, por una solicitud `fetch` de Node que añadía `Sec-Fetch-Mode: cors`, no una navegación. El servidor rechazó correctamente el fallback HTML. Corregida la forma de esa solicitud en el test, **5/5**; no se relajó el control productivo. Incluye arranque desde directorio temporal, assets reales, mismo origen y extracción compilada, más handler de SIGTERM con extractor real activo. Procesos propios cerrados/observados, sin servicios externos.
- Lint inicial: una infracción `no-unexpected-multiline` en el formato de `it.each` del test nuevo. Corregida sin cambiar reglas; lint final aprobado.
- Una suite global final sobre el código productivo terminado: API **719/719**, frontend **205/205**, total **924/924**. Sin pérdida de worker en esa ejecución, no una garantía de estabilidad permanente.
- Build API y web (`--mode test`, sin dotenv real) aprobados; advertencia conocida del bundle mayor de 500 kB. No se ejecutó el build normal con variables privadas del operador. Artefacto de validación sin credenciales públicas no apto todavía para login real/publicación.
- La instalación Linux con `npm ci`, memoria del host Render, señales POSIX reales, TLS/proxy, configuración privada y recorrido con proveedores **siguen pendientes**. No se crearon servicios, se aplicaron migraciones ni se midió calidad diagnóstica. La evidencia anterior de 906/906 pertenece al cierre local previo, no debe sustituir ni confundirse con esta preparación.

Corrección posterior P2 de proxy: las 924 pruebas y compilado 5/5 anteriores no se presentan como repetidas después de este ajuste. Primeras focalizadas: 14 fallos (12 por campo omitido requerido en Zod, uno por una aserción de saneamiento que confundía la coma de JSON con el input rechazado, otro por representación hexadecimal de IPv4 mapeada con cupo distinto). Se corrigió el default del esquema, se afirmó el issue genérico exacto sin el input y se normalizaron las formas equivalentes de IP antes de la resolución de Express, manteniendo la clave y validaciones de la biblioteca. Focalizadas finales de proxies, configuración y autenticación: **101/101**. Lint API, build API y diff-check aprobados. Arranque compilado de mismo origen, sin la nueva variable y con entorno sintético: **1/1** (`node --test --test-name-pattern="actual compiled entry" apps/api/scripts/verify-compiled.test.mjs`), proceso temporal cerrado. Las pruebas simulan una topología controlada; no acreditan los proxies reales de Render.

## Guía de usuario y demostración de cinco minutos

Abrir https://autodiag-ia.onrender.com/ y preparar antes **una sola cuenta autorizada**, un PDF autorizado y anonimizado y un resultado guardado de respaldo. No proyectar credenciales, tokens, VIN ni datos personales. El siguiente guion es un plan de demostración; no certifica que se haya ensayado íntegramente en cinco minutos.

1. **0:00–0:40 — Login:** iniciar sesión privada con esa cuenta, sin autorregistro. Explicar que la orientación necesita confirmación profesional.
2. **0:40–1:40 — Carga y revisión:** seleccionar/arrastrar el PDF con texto digital, enviar y revisar vehículo, módulos, conteos, DTC, estados y advertencias. Añadir observaciones técnicas opcionales sin datos personales. Un reporte parcial o incompatible puede bloquear análisis: no eludirlo.
3. **1:40–3:00 — Confirmación y análisis:** solicitar y confirmar manualmente. Mostrar resumen, hallazgos, comprobaciones, prioridad, confianza y advertencias. Reservar margen de espera, sin prometer latencia. Revisar fuentes y su estado RAG: si no hay evidencia o RAG no está activo/disponible, explicarlo en vez de inventar fuentes. Similitud no confirma una causa; la procedencia conserva limitaciones. El corpus activo en código es demostrativo, no documentación oficial validada; TPMS sigue sin activar.
4. **3:00–4:20 — Historial y PDF:** comprobar guardado (`history.status` cuando esté capturado), abrir el historial propio y descargar el PDF desde snapshot. Abrir/exportar no repite modelo ni RAG. Consultar el archivo descargado sin conexión; no es el PDF original Autel. Si aparece unavailable, no afirmar que se guardó.
5. **4:20–5:00 — Reutilización y logout:** explicar `reused` cuando se haya capturado y la diferencia entre generación y recuperación; una repetición idéntica solo si tiempo/consumo están autorizados. No vender milisegundos de recuperación como generación. Cerrar sesión y comprobar desaparición del workspace, reporte, análisis, fuentes e historial visible.

Preparar caso autorizado y resultado guardado como respaldo; no fingir que una captura es ejecución nueva. No reproducir un fallo deliberado con datos reales en una exposición sin consentimiento.

### Lista breve antes de presentar

- Operador: confirmar URL, SHA desplegado y configuración esperada sin publicar secretos; verificar que autorregistro siga deshabilitado y no haya cambios de modelo/corpus para la exposición.
- Con autorización, comprobar HTTPS, carga de assets, login y sesión; health solo confirma respuesta de la API. Usar una sesión previamente comprobada, no agotar el cupo de login ni hacer pruebas de spoofing en la demo.
- Preparar PDF digital compatible y observaciones técnicas saneadas; comprobar conteos/módulos y advertencias antes de confirmar. Reservar tiempo para generación, sin prometer 24–33 segundos en cualquier ejecución.
- Comprobar guardado real frente a `history.status = unavailable`, apertura del historial propio y lectura del PDF descargado; tener respaldo claramente identificado como previo.
- Tener un mensaje de limitaciones: orientación para revisión competente, no reparación confirmada; corpus demostrativo de 16 fragmentos, TPMS sin activar y aislamiento del limitador pendiente.

## Recuperación operativa

- **API apagada/red**: no cerrar sesión por este solo hecho. Usar Comprobar conexión y Reintentar explícitamente cuando vuelva. Si no vuelve, comprobar proceso/logs saneados y gateway; health no certifica proveedores.
- **Timeout de análisis**: conservar extracción y revisar el error; reintento manual de la misma entrada puede recuperar/esperar la operación existente. No enviar múltiples análisis concurrentes ni cambiar observaciones accidentalmente. No cambiar modelo/timeouts durante la demo para esconder el fallo.
- **502 `OPENAI_RESPONSE_INVALID`**: la interfaz muestra una orientación que no pudo validarse, no pérdida de conexión. Conservar sesión, archivo y observaciones; no aceptar un resultado inválido como completo. No hay reintento automático ni guardado de esa respuesta. Si corresponde, reintentar explícitamente una vez o usar el respaldo identificándolo como previo; registrar solo código/estado/tiempo, nunca contenido interno del proveedor.
- **429 de login**: detener intentos y esperar la ventana de quince minutos. El aislamiento detrás del proxy sigue pendiente y el bloqueo podría afectar a otros clientes; no evadirlo con cabeceras, desactivar el límite o reiniciar para ocultarlo. Si impide continuar, usar material de respaldo sin simular login o generación en vivo.
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
| Arranque compilado y destino | API, web y extractor juntos comprobados localmente; URL Render y flujo manual reportados por usuario | Confirmar SHA/configuración del destino; memoria, señales, recuperación operativa y aislamiento IP/rate-limit no verificados integralmente |
| Evaluación | Formato/evaluador offline y baseline Mazda exploratorio | Casos autorizados, etiquetas técnicas, reserva ciega y criterios de aceptación |
| n8n/Power BI/aprendizaje supervisado | No implementados; no se encontró compromiso de entrega en documentación versionada | Confirmar rúbrica externa si los exige; no marcarlos completos |

La búsqueda documental solo demuestra lo que contiene el repositorio: no sustituye la rúbrica del curso. No hay porcentajes de avance ni precisión acreditados. La herramienta de evaluación y sus fixtures no son una evaluación real del modelo. La orientación generada nunca equivale a diagnóstico confirmado.

## Pendientes por prioridad

1. **Para la entrega:** confirmar con el operador SHA/configuración del servicio existente, acceso autorizado, privacidad del material y respaldo; ensayar el guion sin alterar producción. Contrastar la rúbrica académica externa y sus entregables: no se encontró compromiso versionado que haga obligatorios n8n, Power BI o aprendizaje supervisado, pero el repositorio no sustituye esa rúbrica.
2. **Pendientes operativos no resueltos:** aislamiento del limitador detrás del proxy y P2 de la sonda pospuestos, verificación de aislamiento remoto entre usuarios, memoria y recuperación en Linux/Render, reconciliación del historial de migraciones antes de automatizar cambios. Un flujo exitoso no cierra estos puntos ni autoriza reaplicar SQL. La entrega demostrativa no equivale a habilitación segura para uso multiusuario general.
3. **Evaluación y ampliaciones posteriores:** casos autorizados independientes, input realmente capturado y saneado, etiquetas/revisión técnica competente, reserva ciega y criterios de aceptación. La relevancia RAG y calidad diagnóstica siguen sin medición rigurosa. Los tres candidatos TPMS permanecen separados: la aceptación experimental ya registrada no es revisión profesional, licencia ni compatibilidad; faltan admisión/revisiones e ingestión autorizada. n8n, Power BI y entrenamiento supervisado no están implementados ni se incorporan a esta entrega.

Este cierre solo modifica la guía existente y no traslada la sonda ni cambia código, configuración, dependencias declaradas o lockfile. El worktree no tenía instalación: se ejecutó `npm ci --no-fund --no-audit` con Node 24.16.0/npm 11.13.0, instalando 408 paquetes desde el lockfile sin actualizaciones; se observó el aviso de deprecación de `whatwg-encoding@3.1.1`, no un fallo de instalación. Las comprobaciones locales posteriores se registran por separado; no acceden a proveedores, despliegan ni aplican migraciones y no constituyen una nueva validación funcional del destino.

### Cierre local de la versión entregable (una cuenta)

Se contrastó el recorrido login → carga Autel → extracción → revisión DTC → observaciones opcionales → confirmación/análisis → fuentes RAG → historial → PDF → logout con `App.tsx`, cliente API, rutas autenticadas, repositorio de historial, RAG, generador PDF y arranque compilado. No se identificó un bloqueante nuevo reproducible que requiera cambiar el código para ese guion. Se conservaron autenticación, RLS versionado, filtros por usuario, contratos, modelos/configuración y exclusión de candidatos. Un estado RAG sin fuentes sigue siendo un resultado explícito, no evidencia inventada; su disponibilidad real queda para el ensayo autorizado.

| Verificación ejecutada sobre esta base, una pasada | Resultado |
| --- | --- |
| API: `auth-integration`, `analysis-references`, `analysis-idempotency-integration`, `rag-analysis-integration`, `diagnostic-history-integration`, `production-web` | **100/100**, seis archivos; Vitest con rutas explícitas, no suite completa |
| Web: `App.test.tsx`, `App.auth.test.tsx`, `api-client.test.ts`, `report-pdf.test.ts` | **153/153**, cuatro archivos; mocks y generación PDF local, no proveedor real |
| `npm run lint` | Aprobado en ambos workspaces |
| `npm run build --workspace @autodiag/api` | Aprobado, artefactos del extractor incluidos |
| `npm run build --workspace @autodiag/web -- --mode test` | Aprobado sin dotenv real; advertencia conocida del bundle mayor de 500 kB. Artefacto de prueba, no bundle configurado para publicar |
| `node --test apps/api/scripts/verify-compiled.test.mjs` | **5/5**: extracción sintética compilada, contención, HTTP protegido, mismo origen y shutdown; procesos propios cerrados y esperados |

No hubo fallos de instalación, aserciones fallidas o pérdida de worker en esta pasada; no se repitieron controles aprobados. La evidencia global previa **975/975** corresponde a la corrección de referencias, con código productivo idéntico al de esta rama; no se presenta como una suite global ejecutada en este cierre. Los resultados de 100, 153 y 5 son verificaciones de alcance distinto, no una nueva cifra de suite global ni una medición de precisión diagnóstica. Las incidencias de la sonda pertenecen a la otra rama y no se trasladan a esta entrega.

**Resta el ensayo de cinco pasos descrito arriba**, con una sola cuenta y material autorizado. Anotar SHA desplegado, estado de guardado/RAG, origen nuevo/reutilizado cuando se capture y resultado del PDF/logout; registrar campos desconocidos sin reconstruirlos. Ante fallo, aplicar Recuperación operativa. Una reversión de producción la realiza únicamente el operador: elegir en Render un despliegue conocido compatible con servicio único, conservar configuración privada e historial y comprobar health/login/flujo tras revertir. No ejecutar SQL, rotar HMAC, cambiar modelos o borrar datos como mecanismo de rollback. Si no existe una versión anterior compatible, detener la demostración en vivo y usar el respaldo explícitamente identificado.

No se acredita seguridad multiusuario, comportamiento bajo carga ni calidad diagnóstica por completar un ensayo monousuario. El aislamiento de cupos detrás del proxy y el P2 de la sonda permanecen pendientes; tampoco se da por satisfecha una rúbrica académica externa no disponible. No hay autorización de commit, publicación o despliegue en este cierre local.
