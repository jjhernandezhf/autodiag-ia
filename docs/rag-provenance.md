# Procedencia y aplicabilidad RAG

Este soporte transporta restricciones, no demuestra relevancia de recuperación ni calidad diagnóstica. El corpus activo conserva **16 fragmentos** y **`demonstration_corpus_v1`**; los tres candidatos TPMS siguen separados y pendientes.

## Contrato y almacenamiento

`rag_provenance_v1` es un objeto estricto. Se almacena como texto JSON en `metadata.provenance`, junto con `metadata.reviewStatus: "approved"`, aprovechando la metadata plana y la columna JSONB existentes. La aprobación es responsabilidad de quien prepara el corpus, no una verificación automática del fabricante. El fixture `fixtures/rag-provenance.synthetic.json` ilustra el formato; es ficticio y no se ingiere.

`reviewStatus` es una barrera de admisión, no una certificación profesional ni una licencia. La aceptación de uso experimental, la revisión técnica humana y la revisión de permisos se documentan por separado en la propuesta; ninguna se infiere de las otras. La aceptación experimental no convierte `pending_technical_review` en `approved`. Mientras falten requisitos, el parser debe seguir rechazando la fuente completa. Si alguna vez se admite, los límites reales de revisión y aplicabilidad deben permanecer en `provenance.limitations`.

| Campo | Regla |
| --- | --- |
| `version` | `rag_provenance_v1` |
| `origin` | `official_documentation`, `internal_demonstration`, `unverified` |
| `publisher` | Hasta 120 caracteres o null |
| `documentType` | `owner_manual`, `service_manual`, `internal_notes`, `unknown` |
| `section` | Hasta 200 caracteres o null |
| `make`, `model`, `year` | Marca hasta 80, modelo hasta 120, año entero 1886–9999, o null |
| `publicationMarket` | Mercado de la publicación, hasta 80 caracteres o null |
| `vehicleMarket` | Siempre null: el input actual no acredita este dato |
| `applicability` | `unknown` o `incompatible`; nunca compatibilidad inferida |
| `limitations` | Obligatorio, hasta 500 caracteres; incluir límites de equipamiento y alcance |
| `derivation` | `summary`, `literal`, `internal`, `unknown` |

Los textos no pueden contener datos sensibles. Una atribución oficial exige editor y `sourceUrl` HTTPS seguro en el chunk; esa URL se conserva como `source.url`, sin duplicarla dentro de provenance. Los campos desconocidos se rechazan. La revisión pendiente, el JSON malformado, los campos excesivos o contaminados excluyen toda la fuente, no solo el campo problemático.

## Recorrido y cautelas

1. La validación y preparación de ingestión preservan la metadata. Su hash de registro existente incluye estos campos; un cambio de alcance requiere actualización del registro. No se ha ejecutado ingestión.
2. La tabla y RPC existentes ya transportan `metadata`: no se necesita migración ni cambio de permisos.
3. Recuperación valida el contrato. Una incompatibilidad explícita o discrepancia conocida de marca/modelo/año excluye la fuente. La comparación es conservadora y exacta, sin inferir equivalencias de modelos, mercados o equipamiento.
4. El contexto incluye URL y procedencia como evidencia no confiable; escapa delimitadores y referencias incrustadas. Declara aplicabilidad desconocida y que no autoriza procedimientos específicos. No es una defensa absoluta frente a prompt injection; la revisión de fuentes sigue siendo necesaria.
5. El encabezado completo cuenta dentro de `RAG_MAX_CONTEXT_CHARACTERS`. Solo puede recortarse el contenido; si el encabezado y contenido mínimo no caben, se descarta la fuente y no aparece en la lista pública.
6. El DTO público admite `provenance` opcional. Historial conserva el mismo objeto en el snapshot existente; abrirlo no vuelve a recuperar ni generar conocimiento. La interfaz y PDF muestran atribución, sección, mercado de publicación, desconocimiento del mercado del vehículo, derivación y limitaciones. No se envía metadata arbitraria ni contenido completo adicional al navegador.

Los registros/snapshots legacy sin provenance siguen siendo válidos. Conservan su etiqueta original, incluida la atribución al corpus demostrativo, y muestran cautela de aplicabilidad no verificada. No se convierten en documentación oficial. Metadata específica incompleta no se degrada silenciosamente a legacy.

En preparación y recuperación se aplica el mismo parser: los campos de procedencia y alcance deben estar exclusivamente dentro de `metadata.provenance`. Se rechaza mezclarlos con campos planos, aunque coincidan o sean null, incluidos los campos de candidatos como `sourceModelYear`, `applicabilityStatus`, `scope` y `limitations`. Una propiedad `provenance` presente pero null, vacía, indefinida o malformada siempre es inválida; tampoco se interpreta como legacy. `reviewStatus` acompaña al contrato nuevo y no es suficiente por sí solo. Metadata legacy descriptiva como `topic` y `language` sigue admitida. La preparación aborta ante registros inválidos; recuperación omite la fuente entera, sin publicar ni enviar al modelo una versión despojada de restricciones.

La versión funcional del fingerprint cambia a **`analysis_pipeline_v2_rag_provenance`** porque cambian contexto y reglas de admisión. No cambia el corpus activo, modelo, embeddings, umbral, timeout o reintentos. Los diagnósticos anteriores permanecen consultables, pero no se reutilizan como si hubieran sido generados bajo las reglas nuevas.

## Activación pendiente

Revisar técnicamente los candidatos, traducción y uso permitido; documentar mercado/equipamiento y sus incertidumbres; convertir la metadata al contrato acotado y aprobarla explícitamente. Solo en una fase autorizada separada se podrá cambiar el conjunto activo/versionarlo, ingerir y verificar la recuperación real. Cambiar una constante no actualiza la base remota. Conservar el baseline Mazda sin reinterpretarlo retrospectivamente.

Las pruebas con fixtures y mocks comprueban transporte, exclusión, presupuesto y presentación; no prueban mejor recuperación, compatibilidad mecánica ni precisión del modelo.
