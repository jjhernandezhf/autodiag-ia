# Automatización mínima — preparación local, no activada

Efecto único: recepción validada y transición persistente a completed. No envía
datos clínicos/automotrices, PDF, VIN, usuario o referencia histórica. No modifica
historial ni invoca IA/RAG. El identificador opaco es correlacionable entre
reintentos: tratarlo como dato técnico restringido, no como anonimización absoluta.

La acción del detalle histórico verifica sesión y propiedad antes de enviar.
HMAC de identidad y firma usan claves distintas; las credenciales de ambos
sentidos son distintas. HTTPS fijo en backend, sin query/fragmento/credenciales
en URL ni redirects. Payload estricto, firma canónica y vigencia de cinco minutos
(máximo 30 segundos de adelanto). Reintentar renueva fecha/firma, no eventId.

Configuración futura privada (no habilitada ahora): AUTOMATION_ENABLED=true,
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

## SQL y permisos: preparado, no aplicado

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

## n8n Cloud: pasos pendientes

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

Antes de activar: aplicar migración con autorización separada; probar PostgreSQL
real con conexiones concurrentes, rollback, complete/fail/recover, permisos y
respuesta perdida; probar workflow con eventos sintéticos. Un mock NO demuestra
atomicidad SQL ni importación/funcionamiento n8n real. No prometer exactamente
una ejecución del workflow: solo una transición completed. El MVP no incluye
ningún efecto externo adicional que necesite otra garantía transaccional.

Reversión operativa: deshabilitar AUTOMATION_ENABLED, no borrar eventos ni
historial. Conservar IDs para deduplicación. No reaplicar migraciones anteriores.

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
localmente, no aplicados ni importados en n8n. La verificación real sigue pendiente.
