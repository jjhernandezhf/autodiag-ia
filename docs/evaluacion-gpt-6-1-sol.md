# FASE 3.5A — Evaluación controlada de gpt-6.1-sol

## Cierre de las FASES 3.5A y 3.5B

**Decisión:** mantener el modelo anterior en el uso actual y posponer la evaluación de `gpt-6.1-sol`. Es una decisión operativa basada en el mejor comportamiento observado por el usuario en estas pocas pruebas, no una conclusión de superioridad general del modelo anterior ni una garantía de ausencia de fallos.

La siguiente evidencia fue reportada por el usuario mediante capturas. No fue reproducida por el asistente ni se inspeccionaron reportes o entornos privados durante este cierre.

| Configuración reportada | Caso | Resultado reportado | Interpretación y límites |
| --- | --- | --- | --- |
| `gpt-6.1-sol` | Pruebas de evaluación | `OPENAI_TIMEOUT` | Sin atribución demostrada de la causa de la demora; no se dispone aquí del HTTP de cada fallo. |
| `gpt-6.1-sol`, esfuerzo `low` | Pruebas de evaluación | Respuestas exitosas cercanas al minuto | Sin tiempo exacto, HTTP individual ni consumo atribuible aportados para cada ejecución. No demuestra que `low` resuelva los timeouts. |
| `gpt-6.1-sol` | Toyota RAV4, 14 DTC | Falló inicialmente y respondió al reintentar | Sin código, tiempo exacto ni origen verificable de cada respuesta; el reintento reportado no demuestra un reintento interno del servicio. |
| Modelo anterior restaurado | BMW | HTTP 200, 25,51 s | Medición inicial reportada; generación nueva no verificada independientemente. |
| Modelo anterior restaurado | Toyota RAV4, 14 DTC | HTTP 200, 29,92 s | Medición inicial reportada; generación nueva no verificada independientemente. |
| Modelo anterior restaurado | Repeticiones | HTTP 200, 819 ms y 891 ms | Consistentes con reutilización del diagnóstico; no son medidas de velocidad de generación. No se aportó atribución inequívoca de cada tiempo a un vehículo. |

No se verificaron de forma independiente igualdad exacta de inputs/observaciones, origen generación/recuperación, cobertura o calidad técnica, número de llamadas físicas ni consumo de tokens. No se atribuye el timeout a un defecto o a una causa concreta del proveedor. Una muestra exploratoria pequeña, sin control completo de condiciones, no permite extrapolar fiabilidad, calidad o latencia general. Las valoraciones técnicas requieren revisión por una persona competente.

La selección local de modelo pertenece exclusivamente al `.env` privado del backend. El usuario reportó haber restaurado el modelo anterior; este documento no comprueba su valor ni lo sustituye por un identificador supuesto. No se cambia el modelo predeterminado del código ni se activa `low` por defecto. Se conserva el soporte opcional aprobado de `OPENAI_REASONING_EFFORT`: ausente, vacío o espacios mantienen petición y huellas anteriores; `low` identifica una variante separada cuando la combinación está admitida.

Las secciones siguientes conservan el protocolo de preparación y sus comprobaciones históricas. Sus referencias a pruebas reales pendientes o a acciones no ejecutadas describen el trabajo automatizado de preparación, no niegan las pruebas manuales posteriormente reportadas arriba. No se implementó una fase adicional de optimización. Una reapertura requerirá autorización para consumo real, verificar acceso y aplicar el mismo protocolo de comparación, distinguiendo recuperación de generación sin prometer mejoras.

Para activación futura y reversión, seguir las instrucciones de 3.5B al final de este documento: conservar privadamente los valores previos, editar personalmente modelo/esfuerzo y reiniciar la API. Para volver al comportamiento previo, restaurar el identificador local exacto y omitir o vaciar el esfuerzo si así estaba antes; no basta con cambiar solo el modelo dejando un `low` experimental. No borrar historial ni modificar huellas, timeouts o reintentos para forzar una comparación. En este cierre no se editan entornos ni se ejecutan esos comandos.

## Estado y compatibilidad

Esta fase prepara la evaluación; no activa el modelo, modifica entornos ni realiza llamadas reales. La versión estable permanece en `main`, base `4b32d88b0a63c99e15398e130d1ed95f6e4dc9cd`. El trabajo se prepara en `feat/evaluate-gpt-6-1-sol`.

El identificador objetivo es exactamente `gpt-6.1-sol`. La documentación oficial confirma Responses API y Structured Outputs. No es necesario modificar la petición productiva actual: basta con cambiar posteriormente `OPENAI_MODEL` y reiniciar la API, sujeto a acceso real en el proyecto y a comprobar el modelo previo como se indica abajo. No sustituir por Astra, otro Sol ni un fallback silencioso.

Fuentes oficiales consultadas:

- [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol).
- [Guía actual y migration quickstart](https://developers.openai.com/api/docs/guides/latest-model).
- [GPT-5.6 Luna: referencia previa reportada](https://developers.openai.com/api/docs/models/gpt-5.6-luna).

Se contrastaron con `apps/api/src/ai-analysis-service.ts`, `config.ts`, `app.ts` y `analysis-fingerprint.ts`. La compatibilidad documental y los mocks no prueban acceso, calidad, latencia ni facturación reales.

## Parámetros conservados

| Campo | Petición actual / evaluación preparada |
| --- | --- |
| Endpoint | Responses API, `responses.create` |
| `model` | Valor normalizado de `OPENAI_MODEL`; objetivo futuro `gpt-6.1-sol` |
| `reasoning.effort` | Omitido; para el objetivo, default documentado `medium` |
| `reasoning.mode` | Omitido; no se solicita Pro |
| `temperature`, `top_p`, `top_logprobs`, `include` | Omitidos |
| `max_output_tokens` | Omitido; no se introduce un límite nuevo |
| `text.format` | `json_schema`, `strict: true`, esquema actual sin cambios |
| `store` | `false` |
| `tools`, `tool_choice` | Omitidos; sin herramientas habilitadas |
| `service_tier` | Omitido; no se solicita Fast, Ultrafast ni otro modo con recargo |
| Prompt e inputs | Prompt base intacto; reporte, observaciones y evidencia RAG conservan su separación |
| Timeouts y reintentos | Sin cambios: jerarquía predeterminada 60/80/90 s y política vigente |

No enviar `reasoning.effort` no equivale a enviar `none`. Tanto GPT-6.1 Sol como GPT-5.6 Luna documentan `medium` como default, por lo que se conserva ese esfuerzo si el valor local previo sigue siendo GPT-5.6 Luna. El valor real de los entornos no se leyó: comprobarlo personalmente antes de activar. Para un modelo previo diferente, verificar su default efectivo; no dar por demostrada la equivalencia.

GPT-6.1 Sol no admite `none` ni `minimal`. Si una configuración distinta a la inspeccionada realmente usa esos esfuerzos, no ejecutar la evaluación con esa petición: preparar primero `low`, documentar el cambio, versionar la política de generación y probarla. Esta fase no fuerza `low`, `high` ni `max`, porque la petición inspeccionada no usa `none` o `minimal`. La guía oficial también exige omitir parámetros de muestreo incompatibles con razonamiento activo; ya se omiten.

Solo se consume texto con estado `completed`. `incomplete`, `refusal`, salida vacía, JSON inválido, fallos Zod o referencias DTC incoherentes siguen rechazándose. Las respuestas inválidas no se reintentan ni persisten. No se relajan comprobaciones para acomodar al modelo.

## Deduplicación y reversibilidad

El modelo efectivo normalizado participa en `analysis_fingerprint` como `analysisModel`. Con el mismo usuario, PDF, extracción, observaciones y configuración:

- Cambiar de modelo produce otra huella y no recupera el diagnóstico anterior.
- Repetir el mismo modelo converge en su propia operación o diagnóstico persistido.
- Reiniciar vacía la coordinación local, pero no elimina la deduplicación persistente.
- Volver al modelo previo permite recuperar su propio diagnóstico, sin borrar los del nuevo modelo.

Se comprobó sin red el handler real de `/api/reports/analyze`, con autenticación sintética, SDK/fetch simulado y repositorio en memoria: primera generación con `gpt-5.6-luna`, generación distinta con `gpt-6.1-sol`, recuperación del objetivo tras recrear la aplicación y recuperación del modelo previo. Cuatro invocaciones produjeron solo dos generaciones simuladas y dos filas sintéticas; ambos cuerpos Responses fueron iguales salvo `model`. No se abrieron puertos ni se usó un reporte real.

En esta fase no cambia ningún parámetro de generación adicional, por lo que no corresponde invalidar las huellas estables. Si en otra fase se cambia esfuerzo, límite de salida u otra política que afecte el resultado, incorporarlo a la huella o actualizar explícitamente `ANALYSIS_PIPELINE_VERSION`, con pruebas. La versión de pipeline ya participa en la huella; se verificó que alterarla la cambia. No reutilizar resultados de políticas diferentes bajo una huella idéntica.

## Activación manual futura — no ejecutada

Requiere autorización para llamadas pagadas y comprobar acceso al identificador exacto en el proyecto OpenAI correspondiente. La existencia de una ficha pública no demuestra que la cuenta lo tenga habilitado. Revisar permisos, presupuesto y límites; no probar otros modelos automáticamente ante un error.

1. En el editor local, consultar personalmente el valor previo de `OPENAI_MODEL` y conservar únicamente ese identificador en una nota privada. No copiar el archivo de entorno ni claves al repositorio, capturas o conversaciones.
2. Confirmar el esfuerzo efectivo previo según su ficha oficial. Si no coincide con el caso compatible descrito arriba, resolver esa diferencia antes de una llamada real.
3. Detener la API. Editar manualmente solo la línea existente del `.env` raíz, sin duplicarla:

   ```dotenv
   OPENAI_MODEL=gpt-6.1-sol
   ```

4. No modificar `apps/web/.env.local`, claves, embeddings, corpus, RAG, migraciones, autenticación, timeouts o reintentos.
5. Si la terminal tiene un override de `OPENAI_MODEL`, puede prevalecer sobre el archivo. Para usar la línea editada, quitar únicamente ese override del proceso antes del arranque futuro:

   ```powershell
   Remove-Item Env:OPENAI_MODEL -ErrorAction SilentlyContinue
   npm run dev --workspace @autodiag/api
   ```

   Son instrucciones para una sesión futura; no se ejecutaron durante esta preparación. No imprimir variables. El script API existente carga el `.env` raíz. El frontend puede iniciarse por separado mediante `npm run dev --workspace @autodiag/web`.
6. Reiniciar la API explícitamente; no asumir que editar el archivo provoca recarga del modelo. Comprobar el modelo del diagnóstico guardado mediante el detalle de historial, cuando esté disponible, y la atribución por modelo del uso del proyecto. Una respuesta reutilizada no prueba acceso actual al proveedor.
7. Solo con autorización, realizar una generación nueva controlada. Si hay acceso denegado, modelo no disponible, saldo/límite, incompatibilidad, timeout o respuesta inválida, registrar el código público y detenerse. No cambiar modelo, límites ni validaciones para conseguir un resultado.

## Protocolo manual breve de comparación

Preparar tres casos autorizados: BMW, Mazda y un reporte más complejo con varios módulos/DTC. Mantener PDF y resultados con datos privados únicamente en el ámbito local autorizado; no incorporarlos al repositorio ni enviar datos sensibles como observaciones. No se leyeron esos reportes en esta fase.

1. Congelar por caso los mismos bytes del PDF, extracción, DTO, texto exacto de observaciones normalizadas, usuario y configuración RAG. Mantener también prompt, esquema y versiones. No variar observaciones para cada modelo. Si se requieren casos nuevos para medir generación, definir previamente nuevas parejas de inputs equivalentes para ambos modelos.
2. Obtener una referencia con el identificador local previo, sin asumir cuál es. Registrar si fue generación o recuperación y conservar la referencia local del diagnóstico, no tokens/fingerprints privados.
3. Aplicar el cambio manual futuro y repetir con `gpt-6.1-sol`. Mantener las mismas condiciones. Si las fuentes RAG recuperadas difieren, anotarlo: esa pareja no permite atribuir toda la diferencia al modelo.
4. Clasificar el resultado con `reused` y el estado del historial. `reused: true` identifica recuperación persistente. La caché en memoria puede devolver el payload original con `reused: false`, por lo que este valor, por sí solo, no prueba una generación nueva. Reiniciar la API entre mediciones, comprobar la existencia previa del resultado y contrastar el uso/los eventos de intentos sin registrar contenidos. Una nueva referencia de upload no evita la deduplicación.
5. Registrar la siguiente ficha, sin cuerpos de petición, cabeceras Authorization, prompts, VIN ni nombres privados:

   | Medida | Registro por caso y modelo |
   | --- | --- |
   | Origen | Generación nueva verificada / reutilizado / no verificable |
   | Tiempo | Tiempo total y número de intentos; no comparar recuperación contra generación |
   | Errores | HTTP y código público; incluir fallos, no solo éxitos |
   | Validez | Esquema, estado `completed`, confirmación técnica obligatoria y coherencia semántica |
   | Cobertura DTC | Referencias módulo+código presentes, faltantes, duplicadas o ajenas; distinguir históricos |
   | Utilidad | Claridad, priorización, causas plausibles, comprobaciones realizables y advertencias |
   | Consumo | Tokens de entrada/salida/razonamiento disponibles y coste atribuible, incluyendo todos los intentos |

6. El DTO público actual no expone `usage`. Consultar manualmente las métricas agregadas del proyecto en una ventana aislada por modelo; si no se puede atribuir el consumo a una ejecución, marcarlo como no medido. No estimar tokens por longitud ni afirmar consumo cero porque no aparezca en la interfaz. No añadir logging sensible ni instrumentación en esta fase.
7. Comparar calidad con una persona competente en diagnóstico automotriz, idealmente sin identificar el modelo al puntuar. Una respuesta más larga no demuestra mayor calidad; las causas siguen siendo hipótesis. Aceptar solo si no se deterioran seguridad, validez o cobertura y si utilidad, tiempo y consumo justifican el cambio. No descartar silenciosamente casos fallidos.

No borrar historial, cambiar UUID de usuario, rotar secretos ni alterar índices para forzar llamadas. Si un caso ya está deduplicado, registrar recuperación y dejar su latencia/coste de generación como no medidos salvo que exista una medición previa verificable. Una sola ejecución por caso no demuestra fiabilidad estadística.

## Reversión manual

Detener la API y restaurar únicamente `OPENAI_MODEL` con el identificador exacto conservado en la nota privada; no adivinarlo ni reemplazarlo por un ejemplo. Quitar un override de proceso si corresponde y reiniciar mediante el mismo comando API. No es necesario cambiar rama, revertir código, borrar historial, aplicar migraciones ni eliminar diagnósticos. La huella vuelve a separar/recuperar los resultados del modelo previo. Su acceso actual también debe comprobarse antes de una generación real.

## Verificación desconectada

```powershell
npm exec --workspace @autodiag/api -- vitest run src/ai-analysis-service.test.ts src/analysis-response-resilience.test.ts src/analysis-fingerprint.test.ts src/analysis-idempotency-integration.test.ts src/diagnostic-history-integration.test.ts
git diff --check
```

Estas pruebas utilizan configuración sintética, mocks y repositorios en memoria; no cargan los entornos reales ni llaman a proveedores. No se modificaron fuentes productivas, pruebas, dependencias o lockfile. La disponibilidad del modelo en la cuenta y la comparación real quedan pendientes.

## FASE 3.5B — Preparación opcional de low

Esta sección amplía la preparación 3.5A descrita arriba. Ahora existe una opción de backend, sin activación automática, que permite comparar el default con `low`. No se cambió el modelo predeterminado ni se leyeron/modificaron entornos reales. La disponibilidad en la cuenta y el efecto real sobre calidad, tiempo y consumo siguen pendientes. La [documentación de razonamiento](https://developers.openai.com/api/docs/guides/reasoning) y las fichas oficiales de ambos modelos confirman soporte de `low`.

### Alcance de configuración

- `OPENAI_REASONING_EFFORT` ausente, vacío o solo espacios: se omite por completo `reasoning` en Responses, igual que antes. Para los dos modelos documentados aquí, eso conserva el default `medium`.
- `OPENAI_REASONING_EFFORT=low`: envía exclusivamente `reasoning: { effort: "low" }` en cada intento de la generación final.
- La opción explícita se habilita únicamente para los IDs exactos `gpt-6.1-sol` y `gpt-5.6-luna`, con espacios exteriores normalizados. Un modelo distinto o ausente se rechaza si se solicita `low`. Con esfuerzo omitido sigue admitiéndose cualquier modelo aceptado previamente.
- Se rechazan valores distintos a `low`, incluidos `none`, `minimal`, `medium`, `high`, `max` y variantes de capitalización. Es una restricción deliberada de esta evaluación mínima, no una afirmación de que todos esos valores sean incompatibles con los proveedores. Para restaurar el default, omitir o dejar vacía la variable.
- No se envían `reasoning.mode: pro`, `service_tier`, herramientas ni parámetros de muestreo. Prompt, esquema estricto, `store: false`, RAG, timeouts, política de reintentos y validación semántica permanecen iguales.

### Timeout reportado e intento 1

El usuario reportó `OPENAI_TIMEOUT`, `attempt: 1`, `maxAttempts: 2`, `durationMs: 60015`, `remainingMs: 17706` y health posterior correcto. No se reprodujo una llamada real ni se conoce la causa concreta de la demora.

`maxAttempts: 2` es un máximo, no una obligación de ejecutar dos llamadas. Antes de reintentar, el servicio exige que la llamada física anterior haya terminado, además de comprobar categoría reintentable, cancelación, Retry-After y presupuesto. Si el timeout lógico vence mientras el SDK/transporte continúa pendiente, se solicita abort, pero no se considera confirmación física de cierre: `isSettled()` sigue falso y se devuelve el error sin solapar otra llamada. El coordinador conserva la operación activa hasta que drene. Health correcto solo confirma que la API responde; no demuestra que el proveedor haya completado esa operación.

Se añadió una prueba con reloj/scheduler controlados que reproduce exactamente duración y presupuesto reportados, manteniendo una promesa física pendiente: devuelve timeout en intento 1, no espera ni inicia un segundo intento y observa el rechazo tardío. Demuestra una explicación compatible con esos datos, no la causa histórica ni el estado interno del SDK en aquella ejecución. Los tests con HTTP transitorio y finalización física confirmada siguen comprobando dos intentos, sin cambiar la política.

### Identidad y recuperación

El esfuerzo explícito normalizado `low` participa en `analysis_fingerprint` junto al modelo y el resto de entradas. Así no recupera un resultado default de ese mismo modelo. Repetir `low` recupera su propia variante persistida, también tras reiniciar la API.

Al omitir esfuerzo, el campo tampoco se añade a la serialización canónica: se preservan las huellas anteriores de la política default. Omitido representa esa política de default del proveedor; en los modelos documentados aquí su esfuerzo efectivo es `medium`. No se fuerza `medium` en la petición ni se invalida todo el historial. Volver de `low` a blanco vuelve a identificar la variante default. No se cambian secretos, índices ni registros anteriores.

No se añade un campo público de esfuerzo al historial ni una migración. Registrar manualmente en la ficha de evaluación la configuración solicitada (`default/medium` o `low`), sin copiar huellas privadas. No confundir dos resultados del mismo modelo pero políticas distintas. El protocolo previo sigue aplicando para distinguir generación de recuperación y contabilizar todos los intentos; `reused: false` por sí solo sigue sin probar una nueva llamada física.

### Activación y reversión futuras — no ejecutadas

Solo tras autorización de la prueba pagada y comprobar acceso al modelo, detener la API y editar manualmente únicamente estas líneas del `.env` raíz:

```dotenv
OPENAI_MODEL=gpt-6.1-sol
OPENAI_REASONING_EFFORT=low
```

Conservar privadamente tanto el identificador anterior como el estado previo (ausente/vacío/valor) de esfuerzo. No modificar `OPENAI_TIMEOUT_MS`, el presupuesto integral ni otras variables. Si hay overrides de estas dos variables en la terminal, retirarlos antes del arranque futuro para que se usen las líneas del archivo:

```powershell
Remove-Item Env:OPENAI_MODEL -ErrorAction SilentlyContinue
Remove-Item Env:OPENAI_REASONING_EFFORT -ErrorAction SilentlyContinue
npm run dev --workspace @autodiag/api
```

No se ejecutaron estos comandos durante la preparación. Reiniciar explícitamente; no asumir recarga del `.env`. Mantener BMW, Mazda y el caso complejo con los mismos inputs/observaciones del protocolo, y anotar esfuerzo, resultados, tiempos, errores y consumo atribuible. `low` puede cambiar el equilibrio de calidad/consumo, pero no garantiza que desaparezca el timeout ni permite relajar los criterios técnicos.

Para comparar contra el comportamiento anterior del mismo modelo, detener la API, retirar la línea de esfuerzo o dejar `OPENAI_REASONING_EFFORT=` y reiniciar, eliminando cualquier override de proceso. Para reversión completa, restaurar además el `OPENAI_MODEL` previo exacto. No borrar historial: cada variante conserva su identidad. Si el modelo previo no está entre los dos IDs habilitados para `low`, restaurar también esfuerzo omitido antes de arrancar.

Pruebas desconectadas relevantes de esta ampliación:

```powershell
npm exec --workspace @autodiag/api -- vitest run src/config.test.ts src/analysis-fingerprint.test.ts src/analysis-response-resilience.test.ts src/diagnostic-history-integration.test.ts src/ai-analysis-service.test.ts src/analysis-coordinator.test.ts src/analysis-idempotency-integration.test.ts
```

Se comprueban normalización y rechazos, ambos intentos serializados por el SDK real con fetch simulado, rechazo de respuestas incompletas, separación/recuperación default-low, timeout, exclusión física e historial. Todas las configuraciones son sintéticas: no usan los entornos reales ni proveedores.
