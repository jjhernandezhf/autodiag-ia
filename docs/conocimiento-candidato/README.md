# Candidatos TPMS — revisión previa a ingestión

Estado: **preparados, no ingeridos ni activados**. Archivo: [mazda3-2019-tpms.json](mazda3-2019-tpms.json), conjunto versionado `mazda3_2019_usa_tpms_candidates_v1`. Contiene tres paráfrasis propias en español, basadas en documentación oficial; no son texto literal ni un informe de diagnóstico generado para un vehículo.

La [propuesta de incorporación revisable](propuesta-incorporacion-tpms.md), contrastada documentalmente el 2026-10-17, prepara metadata canónica, comandos futuros y retirada selectiva. Sigue pendiente de revisión humana y autorización; no activa ni reemplaza estos candidatos iniciales.

Aceptación experimental del usuario registrada el 2026-10-17 en la propuesta: información para el propietario y preparación local, sin aprobación técnica, licencia, compatibilidad confirmada o autorización de consumo externo. Esa aceptación no debe pedirse otra vez; la admisión y las revisiones pendientes siguen separadas.

## Fuente y trazabilidad

Se consultó directamente el HTML público del [manual del propietario Mazda3 2019, Mazda USA](https://www.mazdausa.com/static/manuals/2019/mazda3/contents/05120200.html) el **2026-10-16**, incluyendo el cuerpo TPMS de la página, no solo su índice ni resultados del buscador. Idioma original: inglés. Cada fragmento conserva URL, publicación, sección, modelo/año de la fuente, mercado de publicación, fecha, idioma de resumen, derivación, revisión pendiente, alcance y limitaciones en metadata plana compatible con `knowledgeChunkSchema`.

| Índice | Tema | Localización en la fuente |
| --- | --- | --- |
| 0 | Funcionamiento y limitaciones | Inicio del apartado TPMS y advertencias de ese apartado |
| 1 | Diferencia entre presión y anomalía | Advertencia sobre el indicador combinado y subapartados de anomalía y disminución de presión |
| 2 | Sensores e identificación | Apartado de neumáticos/ruedas y sus notas sobre identificación |

La procedencia oficial no confirma que el mercado o equipamiento del caso exploratorio coincidan. Esa correspondencia sigue pendiente. Ningún fragmento interpreta los cuatro DTC del baseline, asigna causas, recomienda reemplazar piezas, declara frecuencias o extiende compatibilidad a cualquier Mazda. No se copiaron imágenes, procedimientos completos ni el manual íntegro. Su consulta pública tampoco se presenta como una licencia de redistribución del manual: antes de activar, revisar el uso permitido de los resúmenes y la política de fuentes.

## Por qué permanecen separados

La estructura admite esos metadatos escalares, pero la validación del corpus ingerible rechaza estos candidatos: su revisión sigue pendiente y todavía no usan el contrato aprobado de procedencia. Que cada registro tenga estructura de chunk válida no autoriza su activación.

La pérdida detectada al preparar los candidatos ocurría al construir la evidencia: la metadata almacenada no llegaba al contexto, fuentes públicas o PDF. Ahora existe un [contrato acotado de procedencia y aplicabilidad](../rag-provenance.md), conservado en todo ese recorrido. El encabezado completo participa en el presupuesto y no se trunca; si no cabe, se descarta el fragmento entero. Las fuentes específicas requieren metadata válida y revisión aprobada; los tres candidatos permanecen bloqueados.

Para esta preparación **no se conectan los candidatos a `DEMONSTRATION_KNOWLEDGE_CORPUS` ni al CLI de ingestión**. Tampoco se habilita su recuperación. Las pruebas comprueban el rechazo de la combinación en memoria, sin llamadas externas.

Cambio mínimo pendiente para incorporarlos con seguridad, sin requerir otra tabla:

1. Revisar técnicamente contenido, traducción, mercado/equipamiento y condiciones de uso. No cambiar `reviewStatus` a aprobado sin esa revisión.
2. Tras esa revisión, preparar metadata según `rag_provenance_v1`, sin inventar mercado/equipamiento del vehículo ni marcarlo compatible. Registrar el editor, sección y limitaciones completas. Elegir solo material aprobado para el conjunto activo; no activar automáticamente candidatos pendientes.
3. Verificar nuevamente el recorrido y presupuesto con los candidatos revisados. El transporte ya está implementado y no requiere otra tabla ni migración: se usa el JSONB existente. Esto no sustituye la revisión competente ni autoriza procedimientos específicos.
4. Versionar el corpus activo al cambiar su contenido. `app.ts` incorpora `KNOWLEDGE_CORPUS_VERSION` en `createAnalysisFingerprint`; el fixture comprueba que cambiar ese valor cambia la huella. Esta preparación conserva `demonstration_corpus_v1` porque el conjunto ingerible sigue intacto: no afirma que la base remota contenga los candidatos. Coordinar futura activación de código/versión con ingestión verificada y recuperación; cambiar una constante no actualiza Supabase.

El prompt base, modelo, umbrales y consulta no cambian. El contexto de evidencia incorpora ahora procedencia y cautelas; la versión funcional pasa a `analysis_pipeline_v2_rag_provenance` para separar resultados anteriores. No se fuerza recuperación mediante los DTC del caso. No se usa la orientación generada por IA como fuente técnica.

## Baseline y evaluación posterior

Los tres archivos `exploratorio-mazda3-2019.*` se conservan íntegramente como registro inicial. No actualizar retrospectivamente sus versiones, fuentes o métricas para atribuirle conocimiento preparado después. El caso sigue siendo desarrollo ya inspeccionado; no es una evaluación ciega.

Después de revisión y autorización separada para ingestión/consumo, definir una nueva ejecución comparable, con input realmente capturado y saneado, versiones y origen generación/reutilización verificables, y juicios de relevancia independientes. No basta con que aparezcan los títulos nuevos o suba la similitud. Evaluar además si las afirmaciones están respaldadas y si la persona competente considera pertinente la documentación al vehículo. **No se ha medido una mejora real de recuperación ni de diagnóstico.**

## Verificación desconectada

```powershell
npm exec --workspace @autodiag/api -- vitest run src/tpms-knowledge-candidates.test.ts src/knowledge-corpus.test.ts src/rag-ingest.test.ts src/analysis-fingerprint.test.ts src/quality-evaluation.test.ts
```

No ejecutar `rag:ingest` en esta fase, ni siquiera el CLI dry-run que carga configuración de entorno. La preparación y validación de registros se prueban como funciones puras con fixtures, sin embeddings, RPC, escrituras ni consultas de secretos.
