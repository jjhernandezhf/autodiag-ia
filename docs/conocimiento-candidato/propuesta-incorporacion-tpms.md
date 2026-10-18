# Propuesta TPMS — pendiente, no activada

El [JSON propuesto](mazda3-2019-tpms.propuesta.json) contiene los tres textos y la metadata exacta. No reemplaza los candidatos v1 ni modifica el baseline Mazda. Propone 19 fragmentos: los 16 actuales, sin cambios, más índices 0–2 de `mazda-usa-mazda3-2019-tpms`. Versión futura: `demonstration_corpus_v2_mazda3_2019_tpms`. Hoy siguen activos 16 y `demonstration_corpus_v1`.

## Aceptación experimental registrada — 2026-10-17

El usuario confirmó: “Revisé los resúmenes y acepto su uso experimental como información para el propietario.” Se registra únicamente esa declaración y su alcance: documentarla y preparar localmente la incorporación. No se inventan identidad, firma ni credenciales. Esta aceptación ya fue concedida y no debe solicitarse otra vez.

No acredita revisión técnica profesional, licencia del fabricante o compatibilidad del vehículo, ni autoriza llamadas pagadas o ingestión externa. `humanTechnicalReview` y `usagePermissionReview` siguen null (pendientes); `admissionDecision` permanece `pending_requirements`. Los tres fragmentos expresan estos límites tanto en el contenido como en la procedencia que se transportaría al modelo, historial y PDF.

## Contraste documental directo

Fuente consultada el **2026-10-17**: [Mazda USA, manual Mazda3 2019, TPMS](https://www.mazdausa.com/static/manuals/2019/mazda3/contents/05120200.html), cuerpo de la página, no solo el índice.

| Fragmento | Localización que respalda las afirmaciones |
| --- | --- |
| 0 | Introducción: recepción por radio; nota: inspección periódica; cautela: demora ante pérdida rápida. |
| 1 | Cautela: secuencia de anomalía y limitación de detección; apartado de presión baja: luz encendida. |
| 2 | “Tires and Wheels”: identificadores y registro; apartado final: sensor nuevo. |

Son paráfrasis en español, no texto literal ni procedimientos de reparación. No se asignan significados a los DTC del caso ni se trasladan instrucciones operativas del manual. `publicationMarket: USA` identifica la publicación, no el mercado confirmado del vehículo. `vehicleMarket: null` y `applicability: unknown` permanecen explícitos.

## Parser y bloqueos

La metadata solo contiene `reviewStatus` y `provenance` como texto JSON: no mezcla restricciones planas. La procedencia es estructuralmente válida bajo `rag_provenance_v1`, pero **el parser de admisión debe rechazar estos candidatos mientras su estado sea `pending_technical_review`**. Que una copia sintética con estado aprobado pase las validaciones no constituye una aprobación real.

`reviewStatus` controla admisión al corpus, no certifica credenciales o calidad técnica. La aceptación experimental se registra separadamente y no se transforma en `approved`: los candidatos mantienen `pending_technical_review`, correspondiente a la revisión que realmente falta. No hace falta cambiar el parser productivo ni añadir una vía de admisión que eluda esa revisión. `approved` solo podría usarse después de resolver y registrar los requisitos de admisión; por sí mismo nunca constituye evidencia de revisión profesional o licencia.

Pendientes: revisión humana competente del resumen y su alcance; revisión de las condiciones de uso; decisión explícita de admisión/activación y autorización separada de consumo externo. No falta la aceptación experimental del usuario: ya está registrada. La consulta pública no demuestra una licencia de redistribución. No se atribuye ninguna aprobación a un técnico ni al fabricante. El mercado/equipamiento desconocidos permanecen como restricciones, no como compatibilidad confirmada ni permiso para procedimientos específicos.

## Incorporación futura, solo después de aprobación y autorización

1. Resolver y registrar las revisiones y decisión de admisión pendientes sin volver a pedir la aceptación experimental. Solo entonces cambiar los tres `reviewStatus` a `approved`. No copiar campos de auditoría como restricciones planas dentro de metadata. Mantener constancia independiente de qué revisión se realizó realmente.
2. En un cambio de código expresamente autorizado, incluir esos tres chunks en la definición activa y cambiar `KNOWLEDGE_CORPUS_VERSION` a la versión propuesta. Conservar las etiquetas demostrativas de los otros 16. No cambiar umbrales, modelos o parámetros.
3. El CLI actual **no recibe un archivo de candidatos**: ingiere exclusivamente la definición activa. No ejecutar sus comandos hoy esperando que lean el JSON propuesto. Tras integrar y revisar esa definición, ejecutar desde la raíz:

```powershell
npm exec --workspace @autodiag/api -- vitest run src/tpms-knowledge-candidates.test.ts src/rag-provenance.test.ts src/knowledge-corpus.test.ts src/rag-ingest.test.ts src/analysis-fingerprint.test.ts
npm run rag:ingest -- --dry-run
```

Antes de esa integración deben actualizarse las expectativas de pruebas que hoy protegen los 16 fragmentos y la exclusión; no quitarlas ni aprobar los candidatos como efecto colateral. El dry-run del CLI carga configuración privada, pero no llama a embeddings ni repositorio. Debe contar 19 válidos; aún no comprueba el estado remoto.

4. Antes de escribir, consultar con autorización administrativa y guardar fuera del repositorio los hashes técnicos para compararlos después, sin embeddings ni contenido:

```sql
select source_id, chunk_index, is_active, content_hash, record_hash
from public.knowledge_chunks
order by source_id, chunk_index;
```

Si no corresponde a los 16 registros esperados o aparecen candidatos de una operación anterior, detenerse y reconciliar el estado antes de ingerir. Solo con autorización de llamadas pagadas/escritura externa y credenciales configuradas por su titular:

```powershell
npm run rag:ingest
```

Con los 16 actuales ya sincronizados se esperan 3 inserciones y 16 omitidos: **3 vectores de embeddings nuevos**, normalmente en una solicitud por lote, no tres llamadas de análisis. Si cambia algún registro anterior, la cantidad aumenta según los hashes; no conocemos el estado remoto. Una repetición sin cambios debería requerir cero embeddings. No se estima precio ni se autoriza consumo con esta previsión.

Si los contadores difieren, investigar sin afirmar éxito parcial. La operación no es una transacción global entre generación de embeddings y base: verificar su resultado. Tras validar la definición activa y sincronizarla con la base, reiniciar la API mediante el flujo habitual para cargar la versión nueva y vaciar cachés en memoria. No afirmar que cambiar la constante ingiere datos. La versión participa en el fingerprint y evita reutilizar análisis anteriores como si usaran el corpus nuevo.

5. Comprobar en el editor SQL administrativo, sin exponer embeddings/contenido ni secretos:

```sql
select source_id, chunk_index, is_active,
       metadata->>'reviewStatus' as review_status,
       (metadata->>'provenance')::jsonb->>'applicability' as applicability,
       (metadata->>'provenance')::jsonb->>'publicationMarket' as publication_market
from public.knowledge_chunks
where source_id = 'mazda-usa-mazda3-2019-tpms'
  and chunk_index in (0, 1, 2)
order by chunk_index;
```

Esperar exactamente tres filas activas, aprobadas, de aplicabilidad desconocida. Confirmar por separado que los 16 registros anteriores siguen activos y sin cambios; la consulta anterior no lo demuestra. Repetir la ingesta autorizada debe omitir 19 registros sin embeddings nuevos si nada cambió. Una comprobación real de recuperación requiere autorización adicional de consumo: usar la misma entrada capturada y saneada, distinguir generación de reutilización y verificar límites en contexto/fuentes/historial/PDF. El SQL solo acredita almacenamiento, no relevancia ni recuperación efectiva. No reinterpretar el baseline original; registrar una ejecución separada y revisión técnica posterior.

## Retirada selectiva futura

No ejecutar ahora. Tras autorización administrativa, quitar solo los tres chunks de la definición activa, conservar los otros 16 y avanzar a `demonstration_corpus_v3_tpms_withdrawn`. Desactivar únicamente esas identidades en una transacción:

```sql
begin;
update public.knowledge_chunks
set is_active = false, updated_at = now()
where source_id = 'mazda-usa-mazda3-2019-tpms'
  and chunk_index in (0, 1, 2)
returning source_id, chunk_index, is_active;
-- Comprobar las identidades devueltas. Si falta alguna o no coincide, ROLLBACK.
-- Solo después de verificar, ejecutar COMMIT manualmente.
```

Reiniciar la API con la versión de retirada, evitando resultados en memoria previos. Verificar tres filas inactivas y los 16 originales intactos. Quitar elementos del array e ingerir no desactiva registros antiguos: por eso es necesario el UPDATE selectivo. No borrar historial ni PDFs existentes; son registros de la evidencia de aquella ejecución. Una futura reactivación requiere revisión y acción explícita: la ingesta omite un hash idéntico y no reactiva automáticamente filas desactivadas.
