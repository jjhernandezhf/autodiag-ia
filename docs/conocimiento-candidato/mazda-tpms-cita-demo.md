# Una cita TPMS: incorporación y recuperación observadas

2026-10-27. Alcance autorizado: una cita breve, no el manual completo ni los
tres resúmenes pendientes. Fuente consultada directamente:
[2019 Mazda3 Owner's Manual, TPMS — Mazda USA](https://www.mazdausa.com/static/manuals/2019/mazda3/contents/05120200.html).
Texto exacto, atribución, traducción propia y restricciones están en
[`owner-manual-quote.ts`](../../apps/api/src/owner-manual-quote.ts).
La cita inglesa consta de 20 palabras. No se atribuyen licencia verificada,
revisión profesional, interpretación DTC ni compatibilidad del vehículo.

## Admisión y compatibilidad

`quote_verified_demo` significa cotejo de esta cita y admisión experimental
autorizada; no equivale a `approved`. Solo se acepta el texto y contexto exactos
de esta entrada. Se rechazan alteraciones, restricciones mixtas/parciales,
documentos de reparación y vehículos incompatibles. La procedencia conserva el
contrato v1; sus limitaciones explicitan el estado al modelo, fuentes, snapshot
y presentación PDF. No se cambian prompts diagnósticos ni modelos.

Los 16 fragmentos de `DEMONSTRATION_KNOWLEDGE_CORPUS` permanecen intactos. La
definición operativa es `ACTIVE_KNOWLEDGE_CORPUS` (17), con versión
`demonstration_corpus_v2_mazda_tpms_quote`. App usa esa versión en la huella; el
CLI ingiere explícitamente ese conjunto. Las herramientas antiguas de propuesta
conservan el baseline de 16, no representan el nuevo inventario operativo. Su
comparador señalará la cita como inesperada; no usarlo para declarar corrupción
ni eliminarla. Los tres candidatos `mazda-usa-mazda3-2019-tpms:0..2` siguen pendientes.

## Ejecución real observada (no mocks)

Se cargó la configuración mediante Node `--env-file`, sin imprimir secretos.
Se comparó el origen Supabase configurado con el bundle público de AutoDiag,
y se comprobaron las 16 identidades, estados y hashes antes de escribir.
No se acreditó el SHA desplegado en Render: el health no lo publica.

- Primera comprobación de lectura falló sin fase registrada; causa desconocida,
  sin embeddings ni escritura. Se añadió diagnóstico de fase, sin datos sensibles;
  la comprobación siguiente confirmó destino e inventario.
- Ingestión: 17 leídos/válidos; **1 insertado, 0 actualizados, 16 omitidos**.
- Identidad nueva: `mazda-usa-2019-tpms-inspection-quote:0`.
- Registro activo, embedding finito de 1536 dimensiones comprobado por lectura.
- Servicio real `RagRetrievalService` → embedding → `match_knowledge_chunks` →
  validación/aplicabilidad/presupuesto → fuentes: estado `used`, cita incluida,
  cuatro fuentes devueltas. Umbral **0.45** y cantidad **4**, leídos de la
  configuración existente, sin reducción ni selección forzada por source_id.
- Dos textos enviados a embeddings (fragmento y consulta), máximo autorizado
  tres. Cero generaciones diagnósticas. El adaptador existente no expone usage
  ni importe: no se inventa coste monetario ni conteo de tokens.

Consulta usada: «¿El sistema TPMS sustituye la inspección periódica de los
neumáticos por parte del propietario?». Contexto sintético: Mazda/Mazda3/2019,
BCM/Body Control Module, C1A56:87-0B con descripción explícitamente no disponible,
sin interpretación del código. No se usó un PDF ni se guardó un diagnóstico.
Una recuperación de esta pregunta no acredita relevancia general ni precisión.

## Consultas de solo lectura para el operador

No exponen vectores completos ni registros privados:

```sql
select source_id, chunk_index, title, source_label, source_url, content,
       is_active, extensions.vector_dims(embedding) as embedding_dimensions,
       content_hash, record_hash,
       metadata->>'reviewStatus' as admission,
       (metadata->>'provenance')::jsonb as provenance
from public.knowledge_chunks
where source_id = 'mazda-usa-2019-tpms-inspection-quote'
  and chunk_index = 0;
```

Para reproducir el RPC con un vector de consulta ya generado, parámetro `$1`
de 1536 dimensiones (no el embedding almacenado del fragmento):

```sql
prepare inspect_tpms_query(extensions.vector) as
select * from public.match_knowledge_chunks($1, 0.45, 4);
-- Ejecutar con el vector real de la pregunta; no sustituirlo por el del fragmento.
-- EXECUTE inspect_tpms_query('[...1536 números de la consulta...]'::extensions.vector);
deallocate inspect_tpms_query;
```

La consulta SQL no crea embeddings y por sí sola no aplica todos los filtros
posteriores del servicio. La comprobación real ya realizada sí los aplicó.
No generar otro vector sin contabilizarlo en el presupuesto autorizado.

## Herramienta reproducible y despliegue pendiente

`apps/api/scripts/verify-owner-quote.mts --check` verifica destino/inventario sin
embeddings; `--execute` inserta solo la identidad exacta ausente y recupera una
vez, sin reintentos automáticos. Usa el entorno configurado por el operador:

```sh
node --import tsx apps/api/scripts/verify-owner-quote.mts --check
# Solo con autorización de consumo disponible; no repetir automáticamente:
node --import tsx apps/api/scripts/verify-owner-quote.mts --execute
```

Si se requiere archivo privado, el operador añade `--env-file=<ruta privada>`
antes de `--import`; nunca se copia su contenido. El límite del script es por
ejecución, no un saldo persistente entre ejecuciones. Esta tarea consumió dos
de tres textos: no volver a ejecutar ingestión genérica ni múltiples consultas.

Para aparecer en Render falta revisar/publicar/desplegar este código y comprobar
el SHA efectivo y la versión del corpus. El código anterior rechaza el nuevo
estado en vez de interpretarlo como revisión profesional. El RPC puede incluir
la fila entre sus primeros resultados y el parser antiguo la excluirá, reduciendo
fuentes útiles; almacenamiento activo no equivale a uso por Render.
No se hizo commit, push ni despliegue. Los snapshots anteriores mantienen su forma.

## Reversión selectiva (solo con autorización)

Desactivar únicamente `source_id='mazda-usa-2019-tpms-inspection-quote' AND
chunk_index=0`, verificando una fila afectada, sin DELETE. Conservar los otros
16 y todo el historial. Retirar la cita del conjunto operativo y avanzar a una
versión de retirada para separar huellas; reiniciar mediante despliegue autorizado.
No usar la versión nueva con corpus retirado ni reaplicar migraciones. Una ingesta
con hashes idénticos no reactiva automáticamente una fila desactivada.

## Verificaciones locales de este cambio

- Focalizadas iniciales: 85/85 en cinco archivos, incluida la admisión y
  propagación hasta el contrato usado por historial/PDF.
- Suite API: 867/870, **no aprobada**. Dos expectativas preexistentes no incluyen
  la migración n8n ni su import administrativo en index; se comprobó que esos
  archivos no cambiaron. Otra prueba PDF excedió 5 s; no se atribuye causa.
- Archivo PDF aislado tras el fallo: 10/10; no convierte en aprobada la suite
  inicial ni demuestra que desapareció la intermitencia.
- Frontend completo: 228/228. Lint y builds API/web aprobados; advertencia del
  bundle >500 kB. Web en modo test, sin archivos de entorno reales.
- No se modificaron migraciones, permisos ni timeouts para ocultar fallos.
