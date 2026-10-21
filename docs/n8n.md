# Automatización mínima — recepción idempotente y evidencia de producción

## Estado y alcance de la evidencia

Actualización documental del 21 de octubre de 2026. El usuario reportó la
configuración y prueba manual en producción; no se realizaron conexiones desde
esta revisión ni se adjuntaron capturas para inspección independiente en este
cierre. No se conoce aquí el momento exacto del ensayo ni el commit desplegado.

- Migración `20261020000100` aplicada en Supabase; RLS habilitado y forzado.
- `anon` y `authenticated` sin permisos de tabla ni ejecución RPC;
  `service_role` con SELECT/INSERT/UPDATE y ejecución RPC, sin DELETE,
  conservando su BYPASSRLS existente.
- Workflow publicado en n8n Cloud. AutoDiag mostró: “Recepción del evento
  confirmada. El diagnóstico no fue modificado”.
- La consulta administrativa mostró una fila `completed`, `completed_at`
  informado y `failure_code NULL`. Al repetir el envío del mismo diagnóstico,
  permaneció una fila con el mismo `event_id`.

Son resultados manuales reportados, no comprobaciones remotas ejecutadas por el
asistente. Respaldan el recorrido ensayado y su repetición, no una garantía de
concurrencia real, recuperación ante toda falla o estabilidad permanente. No se
capturó una medición HTTP completa de latencia; no se atribuye un tiempo ni un
código HTTP no informado. Las pruebas automatizadas previas se detallan aparte.
El alcance no incluye notificaciones, entrenamiento ni mejora automática del
RAG. Guion y recuperación: [guía de entrega](entrega.md).

Efecto único: recepción validada y transición persistente a completed. No envía
datos clínicos/automotrices, PDF, VIN, usuario o referencia histórica. No modifica
historial ni invoca IA/RAG. El identificador opaco es correlacionable entre
reintentos: tratarlo como dato técnico restringido, no como anonimización absoluta.

La acción del detalle histórico verifica sesión y propiedad antes de enviar.
HMAC de identidad y firma usan claves distintas; las credenciales de ambos
sentidos son distintas. HTTPS fijo en backend, sin query/fragmento/credenciales
en URL ni redirects. Payload estricto, firma canónica y vigencia de cinco minutos
(máximo 30 segundos de adelanto). Reintentar renueva fecha/firma, no eventId.

Configuración privada para habilitación explícita: AUTOMATION_ENABLED=true,
AUTOMATION_WEBHOOK_URL, AUTOMATION_OUTBOUND_TOKEN, AUTOMATION_CALLBACK_TOKEN,
AUTOMATION_ID_KEY, AUTOMATION_SIGNING_KEY. Secretos independientes de 32–256
caracteres alfanuméricos/guion/guion bajo; nunca VIN_HMAC_SECRET. No incluirlos
en Vite ni JSON exportado. URL y credenciales solo las configura el operador.
Ausente/false mantiene integración apagada y botón oculto. Configuración
habilitada inválida impide el arranque con error local sin valores secretos.

Límites: diez solicitudes por usuario/15 minutos; callbacks 60/minuto por IP
(con la política de proxy ya existente; no cambiar confianza para activarlo).
Cuatro operaciones físicas simultáneas por emisor y cuatro por receptor;
deadline lógico de diez segundos, abort y observación de promesas tardías.
Un timeout puede haber ocurrido después del commit: resultado desconocido,
no fracaso persistido. No hay reintentos automáticos. Cancelar el navegador
no garantiza cancelar una entrega ya iniciada; repetir conserva la identidad.

## SQL y permisos: prueba local y aplicación remota reportada

Migración 20261020000100_create_automation_events.sql. SECURITY INVOKER necesita
SELECT/INSERT/UPDATE del service_role existente y su atributo BYPASSRLS para
operar con FORCE ROW LEVEL SECURITY sin políticas de acceso de usuarios. La
migración verifica ese atributo y falla si falta: no lo concede ni deshabilita
RLS. PUBLIC/anon/authenticated carecen de acceso a tabla y RPC. n8n no recibe
credenciales Supabase: llama únicamente callbacks restringidos del backend.
El backend conserva su cliente administrativo existente, con su riesgo conocido
de privilegios; no se concede DELETE ni permisos en otras tablas.

La PK arbitra inserción; SELECT FOR UPDATE serializa transiciones. completed es
terminal. register devuelve también estados ya existentes; complete/fail no
crean eventos. fail solo cambia received. recover solo cambia failed a received
y no está expuesto por HTTP: requiere operación administrativa manual autorizada
con eventId exacto. No recuperar por timeout ni reintentar efectos externos.
No hay purga automática. Rotar ID_KEY cambia identidades: requiere plan previo.
La tabla registra únicamente un tipo/versionado de evento mediante el prefijo
automation_v1; validar tipo y schemaVersion en backend antes de llamar RPC.

## n8n Cloud: referencia de configuración para un entorno nuevo

El usuario reportó estos componentes configurados y el workflow publicado en su
entorno. Los pasos siguientes no ordenan reimportar ni reaplicar la migración en
ese destino; sirven para una instalación nueva autorizada.

Importar el workflow INACTIVO, revisar compatibilidad de nodos con la versión
real y fijar URL backend HTTPS en ambos nodos HTTP. Configurar dos credenciales
Header Auth: Authorization con Bearer del token de entrada para Webhook y
X-Automation-Callback para callbacks. Nunca incrustarlas en JSON o expresiones.
No activar hasta conectar esas credenciales; un workflow importado sin ellas
no está listo para recibir tráfico. Restringir acceso a ejecuciones y desactivar
guardado de payload/cabeceras según capacidades verificadas de la instancia.

Webhook → validar estructura → register → complete → responder. La firma
X-Autodiag-Signature se retransmite; su clave solo existe en backend. La RPC
controla duplicados aunque haya ejecuciones n8n concurrentes. Error de nodo
detiene el flujo; un recibido incompleto se puede finalizar al reintentar. No
marcar failed por una desconexión ambigua. El receptor ofrece fail únicamente
para un fallo explícito y autenticado anterior a completed.

En un entorno nuevo, antes de activar: aplicar migración con autorización separada; probar PostgreSQL
real con conexiones concurrentes, rollback, complete/fail/recover, permisos y
respuesta perdida; probar workflow con eventos sintéticos. Un mock NO demuestra
atomicidad SQL ni importación/funcionamiento n8n real. No prometer exactamente
una ejecución del workflow: solo una transición completed. El MVP no incluye
ningún efecto externo adicional que necesite otra garantía transaccional.

Reversión operativa: fijar `AUTOMATION_ENABLED=false` en la configuración privada
de Render y aplicar el cambio mediante despliegue autorizado del servicio.
Comprobar después que la capacidad esté deshabilitada y que, al volver a abrir
el detalle, no se ofrezca el botón. No elimina eventos ni historial: conservar
IDs para deduplicación y las claves existentes. No reaplicar migraciones ni
rotar ID_KEY. No revierte recepciones completadas ni garantiza detener una
entrega ya iniciada; no desplegar durante una operación en vuelo. Esta revisión
no ejecutó la desactivación ni el despliegue.

Recuperación manual futura, solo con autorización administrativa: comprobar el
event_id exacto y estado failed; invocar automation_event_transition con
p_operation='recover'. La RPC cambia únicamente failed a received. Después el
usuario propietario puede repetir la acción para obtener una firma vigente.
No reutilizar una firma expirada, cambiar ID_KEY ni borrar filas para reintentar.
No se ofrece endpoint HTTP de recuperación. Si el estado ya es completed,
la RPC lo conserva; no se debe repetir el efecto ni modificarlo a failed.

## Evidencia local de esta implementación

88/88 pruebas API focalizadas (automatización, historial, configuración y app);
41/41 frontend (nuevo componente, autenticación y CSV); tras corregir la limpieza
del componente se repitieron sus 4/4. Lint y ambos builds aprobados; build web en
modo test para no cargar entornos reales, con aviso preexistente de bundle >500 kB.
La regresión de body >1 KiB detectó inicialmente HTTP 500; se corrigió a 413 sin
ampliar límite. Los duplicados concurrentes se probaron con repositorio simulado:
NO acreditan el comportamiento transaccional real. SQL y JSON inspeccionados
localmente, sin aplicación ni importación remota en aquella etapa. La prueba
PostgreSQL posterior y el reporte manual de producción de arriba son evidencias
separadas; no convierten estos mocks en pruebas remotas.

## Validación PostgreSQL local posterior

Se aplicó exclusivamente la nueva migración en `autodiag_automation_test`, dentro
del contenedor desechable `autodiag-automation-pg-validation`, imagen oficial
`postgres:17.6-bookworm`, PostgreSQL 17.6 Debian x86_64.
Digest: `sha256:f3bd19c606e442c3d7bdfa8002e03fe260a1023351e0ea4598032022b68dd6e3`.
Red `none`, sin puertos ni bind mounts; 256 MiB/una CPU. Autenticación trust
exclusivamente en este contenedor aislado sin credenciales reales, accediendo
por socket mediante docker exec. No usar esta configuración en un servidor
compartido, con puertos publicados o en producción.

Preparación reproducible, solo bajo autorización de pruebas locales, desde una
instancia NUEVA (no reutilizar el nombre si ya pertenece a otro contenedor):

```powershell
docker run --detach --name autodiag-automation-pg-validation --network none --memory 256m --cpus 1 --env POSTGRES_DB=autodiag_automation_test --env POSTGRES_HOST_AUTH_METHOD=trust postgres:17.6-bookworm
docker exec autodiag-automation-pg-validation pg_isready -U postgres -d autodiag_automation_test
docker exec autodiag-automation-pg-validation psql -X -U postgres -d autodiag_automation_test -v ON_ERROR_STOP=1 -c "CREATE ROLE anon LOGIN NOSUPERUSER NOBYPASSRLS; CREATE ROLE authenticated LOGIN NOSUPERUSER NOBYPASSRLS; CREATE ROLE service_role LOGIN NOSUPERUSER BYPASSRLS; CREATE ROLE rls_probe LOGIN NOSUPERUSER NOBYPASSRLS;"
Get-Content -Raw supabase/migrations/20261020000100_create_automation_events.sql | docker exec -i autodiag-automation-pg-validation psql -X -U postgres -d autodiag_automation_test -v ON_ERROR_STOP=1
node --test apps/api/scripts/verify-automation-postgres.test.mjs
```

Detenerse si cualquier paso falla. El script exige el nombre y aislamiento
indicados y usa IDs sintéticos fijos: ejecutar sobre una base recién preparada,
no sobre datos existentes. No aplica la migración ni crea contenedores por sí solo.

Resultado observado: 11 subpruebas aprobadas; Node informa **12/12** incluyendo
el grupo principal. Cero fallos, omisiones o cancelaciones. Se comprobaron:

- Llamante service_role no superusuario; atributos RLS/FORCE y SECURITY INVOKER.
- 12 registros concurrentes del mismo ID: una fila; 12 finalizaciones concurrentes.
- Estado completed terminal y timestamp invariable en duplicados.
- received → failed → recuperación explícita → completed; complete no recupera failed.
- Carrera fail/complete: un estado coherente, sin sobrescribir completed.
- Rollback de inserción y finalización; entradas inválidas y restricciones de fila.
- Denegación real a anon/authenticated; DELETE denegado a service_role.
- Rol sin BYPASSRLS con grants temporales de tabla/RPC: lectura vacía y escritura
  rechazada por RLS, no solo por ausencia de grants. Grants retirados al terminar.
- Bloqueo retenido hasta rollback, seguido de registro correcto por el competidor.
- Terminación de una conexión sintética con transacción abierta: rollback y
  liberación de bloqueos; una nueva solicitud puede registrar el evento.

Las operaciones funcionales se ejecutaron con conexiones service_role directas;
postgres se utilizó para setup, introspección, grants de prueba y terminación
del backend sintético identificado por application_name, nunca de otros procesos.
El contenedor y su volumen de datos de prueba se retiran al finalizar; la imagen
puede permanecer en caché. No se modificó código productivo ni migración.

Esta evidencia reemplaza la limitación de SQL meramente estático SOLO para el
PostgreSQL local probado. No demuestra PostgREST, roles/permisos reales de Supabase,
n8n Cloud ni el recorrido HTTP real. La pérdida de respuesta tras un commit y los
fallos de red entre proveedores siguen pendientes de ensayo de integración;
las pruebas de rollback/terminación no equivalen a ese escenario. Durante esta
validación local la integración permaneció apagada, sin migraciones remotas ni
secretos reales. La activación posterior fue reportada por el usuario.

## Comprobación manual breve del evento

Con una cuenta autorizada, abrir un análisis propio guardado y pulsar
“Registrar evento en n8n”. Esperar la confirmación; no crear otro análisis para
repetir la prueba. Un operador autorizado puede comprobar privadamente la fila
del evento de prueba con la consulta siguiente, sustituyendo únicamente el
marcador por su identificador exacto (no publicar el identificador ni resultados
de otros eventos):

```sql
select count(*) as filas,
       count(*) filter (where status = 'completed'
                        and completed_at is not null
                        and failure_code is null) as completadas_validas
from public.automation_events
where event_id = '<event_id de la prueba>';
```

Esperado: `filas = 1` y `completadas_validas = 1` antes y después de repetir la
acción sobre el mismo diagnóstico, usando el mismo identificador para ambas
consultas. No borrar filas para preparar la repetición. Esta consulta no se
ejecutó en el cierre documental. Mantener credenciales y consola administrativa
fuera de la pantalla compartida. Ante timeout, el resultado puede ser desconocido:
comprobar el estado antes de cualquier recuperación; no marcar failed por inferencia.
