# Registro exploratorio anonimizado — Mazda3 2019

## Procedencia y alcance

Resumen incorporado por autorización expresa del usuario. La evidencia fue comparada manualmente por el usuario y comunicada en esta solicitud; el asistente no reprodujo la ejecución, inspeccionó los originales ni obtuvo el input enviado. No se incluyen PDF, capturas, respuesta generada por IA, identidad del usuario/cliente, VIN, odómetro, referencias de historial ni otros identificadores privados.

Este caso ya fue inspeccionado: **exploratorio, no ciego**, clasificado `development`. Si se utiliza para ajustar el parser, el RAG o cualquier parte del sistema, seguirá siendo de desarrollo y no se reutilizará como reserva independiente.

## Evidencia documental reportada

Vehículo: Mazda3, año 2019. Observación utilizada, según el usuario: “luz de tpms encendido en el tablero.”

| Referencia Autel | Módulo reportado | Estado Autel | Hallazgos JSON reportados por referencia |
| --- | --- | --- | --- |
| C1A56:87-0B | BCM / Body Control Module | Corriente | 1 |
| C1A58:87-0B | BCM / Body Control Module | Corriente | 1 |
| C1A60:87-0B | BCM / Body Control Module | Corriente | 1 |
| C1A62:87-0B | BCM / Body Control Module | Corriente | 1 |

La comparación comunicada observa **cuatro referencias sobre cuatro**, cada una con un hallazgo correspondiente. Es una correspondencia documental reportada, no una puntuación calculada por el evaluador, una confirmación de causas ni una medida general de precisión. Los sufijos se conservan íntegramente; `Corriente` se normaliza a `current` solo en las etiquetas documentales del caso.

El usuario también reportó `status: completed`, `reused: false` y `history.status: saved`. No se capturaron aquí los objetos completos que permitirían validar independientemente esos campos o la respuesta entera. `completed` no se traslada a `extractionDisposition`: el estado del análisis no demuestra el estado del parser. Tampoco se infiere `analysisAvailable` a partir del éxito reportado.

## Fuentes recuperadas reportadas

- Módulos de carrocería y funciones compartidas.
- Efectos de voltaje bajo de batería.
- Diagnóstico inicial de comunicación CAN.

Se registra la **falta reportada de fuentes específicas de TPMS entre los fragmentos recuperados en esta ejecución**. No se afirma que no existan en otras fuentes o en todo el corpus, ni se toma el corpus como respuesta correcta. No se capturaron IDs, URLs, contenido completo, similitudes, versión del corpus ni confirmación independiente de inclusión en el contexto final. Por ello no se inventa un mapeo de chunks: `retrievedSources` y `ragStatus` permanecen desconocidos en el resultado estructurado.

Los títulos generales, por sí solos, no prueban relevancia ni irrelevancia técnica. La pertinencia para TPMS, el respaldo de las afirmaciones y la calidad diagnóstica quedan pendientes de un técnico competente y de fuentes autorizadas aplicables. No se asignan etiquetas de relevancia ni se registra una revisión técnica completada. Este resumen y la orientación generada no se incorporan al corpus.

## Tiempo y fiabilidad

La captura del usuario reportó **HTTP 200 y 16,57 segundos** en una sola ejecución. `durationMs: 16570` es la conversión de ese tiempo comunicado, no una medición repetida ni una captura del reloj del servidor realizada por el asistente. No se conoce el desglose de carga, recuperación, análisis, guardado o intentos físicos.

`reused: false` no prueba generación nueva: la caché en memoria puede conservar el payload original. Se utiliza `responseOrigin: unknown`, sin atribuir los 16,57 segundos a velocidad de generación. No se calculan percentiles, tasas de fiabilidad poblacionales ni conclusiones generales a partir de esta muestra. El estado `saved` tampoco demuestra por sí solo cuántas llamadas al proveedor ocurrieron.

## Representación conservadora en los formatos existentes

- [Caso v1](exploratorio-mazda3-2019.casos.json): expectativas documentales aportadas por el usuario, no reconstrucción del input real. Marca/modelo/año y las cuatro referencias se usan solo como etiquetas del caso. La revisión técnica y las versiones de referencia quedan pendientes/desconocidas.
- [Resultado v1](exploratorio-mazda3-2019.resultados.json): observación previamente reportada (`recorded`, no fixture), con HTTP y duración. Todos los metadatos no capturados quedan `null`, incluido modelo, versiones, esfuerzo, configuración RAG y timeouts. `errorCode: null` significa no capturado, no prueba ausencia de incidentes internos.
- No se añade `analysis`: faltan el JSON completo y los campos obligatorios del contrato de salida. Crear resúmenes, causas, comprobaciones o advertencias ficticias para completar ese objeto sería inventar evidencia. Tampoco se rellena `extraction` ni `analysisInputDtcs` mediante las etiquetas esperadas.
- La CLI solo puede informar el resultado HTTP observado y latencia total reportada. Cobertura DTC automática (`missing_sent_input`), validez de referencias, extracción, esquema de salida, relevancia RAG, latencia de generación, configuración y valoraciones técnicas deben permanecer **no evaluables**. Esto no contradice la correspondencia documental manual 4/4: son evidencias distintas con requisitos diferentes.

Comprobación local, sin servicios ni consumo:

```powershell
npm exec --workspace @autodiag/api -- tsx src/quality-evaluation-cli.ts ../../docs/evaluacion-calidad/exploratorio-mazda3-2019.casos.json ../../docs/evaluacion-calidad/exploratorio-mazda3-2019.resultados.json
```

## Pendiente antes de una evaluación técnica

Capturar de forma autorizada y saneada el input realmente enviado, proyecciones de extracción y salida completas, evidencia final de RAG con identificación verificable, configuración/versiones y procedencia generación/reutilización. Revisar técnicamente la relación entre observaciones, DTC y fuentes y acordar criterios de aceptación. No reconstruir retrospectivamente campos desconocidos ni realizar nuevas llamadas para completar este registro sin autorización adicional.
