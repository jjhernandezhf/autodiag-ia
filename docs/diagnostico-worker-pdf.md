# Diagnóstico acotado del worker PDF — 2026-10-17

Base: `2c4ed9c4bfe933574afbd5182edee6f8baee9b4e`. Rama: `fix/pdf-test-worker-stability`.
Se reprodujo la caída, pero no se identificó el componente causante. No se cambió código productivo, configuración del runner, límites ni dependencias.

## Entorno observado

- Node 24.16.0, npm 11.13.0; win32 x64.
- V8 13.6.233.17-node.49; libuv 1.52.1.
- Vitest 4.1.11; pool observado: forks; sin configuración API específica.
- pdfjs-dist 5.4.624; tsx 4.23.11.
- Dependencia nativa transitiva: @napi-rs/canvas y canvas-win32-x64-msvc 0.1.100.

## Tres ejecuciones, sin buscar repetidamente una suite verde

1. Desde la raíz: `npm test --workspace @autodiag/api -- pdf-integration.test.ts --reporter=verbose`.
   Error de alcance del comando diagnóstico: el script añade `src`, y los filtros incluyen toda la API. Ejecutó 36 archivos; 35 aprobaron, 669/678 pruebas aprobaron y hubo un error del pool. No hubo aserciones fallidas. Salida 1, `Worker forks emitted error`, causado por `Worker exited unexpectedly`. No se capturó el exit nativo de este primer proceso.
2. Desde apps/api, CLI directo con argumentos `run src/pdf-integration.test.ts --reporter=verbose`, mediante el observador en memoria de abajo: 8/9 pruebas aprobadas; el fork terminó con **3221225477 (0xC0000005)** y señal null. El runner terminó con código 1. La última prueba de privacidad no informó resultado. Esto localiza el intervalo, no demuestra que su spy de consola sea la causa.
3. Mismo comando y observador: 9/9 aprobadas, runner código 0. Después de completar las pruebas se observó cierre del fork con código null y señal SIGTERM. Ese cierre posterior no fue informado como error por Vitest.

El segundo intento acredita caída del proceso nativo (código de excepción de acceso inválido en Windows), no una aserción ni un timeout reportado. No acredita por sí solo un defecto de Windows, Node, canvas, PDF.js o tsx. Una ejecución verde no demuestra estabilidad.

Observador usado por stdin, sin archivos auxiliares ni cambios de instalación, desde apps/api:

```powershell
@'
const cp=require('node:child_process');
const {syncBuiltinESMExports}=require('node:module');
const orig=cp.fork;
cp.fork=function(...args){
  const child=orig.apply(this,args);
  console.error('DIAGNOSTIC fork pid='+child.pid);
  child.on('exit',(code,signal)=>console.error('DIAGNOSTIC exit '+JSON.stringify({pid:child.pid,code,signal})));
  return child;
};
syncBuiltinESMExports();
process.argv=[process.execPath,require('node:path').resolve('../../node_modules/vitest/vitest.mjs'),'run','src/pdf-integration.test.ts','--reporter=verbose'];
import(require('node:url').pathToFileURL(process.argv[1]).href);
'@ | node
```

Solo registra PID, exit y señal; no imprime argumentos de fork ni variables de entorno. El reporter imprime nombres de pruebas sintéticas. El mensaje genérico de Vitest omite exit/señal: `emitUnexpectedExit` crea un error sin esos datos, por eso se observó el evento del proceso directamente.

## Ciclo de vida inspeccionado y límites de evidencia

- El extractor crea un Worker por extracción, transfiere los bytes, usa 192 MiB de old generation y 4 MiB de stack por defecto, con timeout de 15000 ms. Estos límites no representan un límite total de memoria nativa del proceso.
- Ante mensaje/error/exit/timeout, el controlador limpia su temporizador y listeners y espera `terminate()` antes de resolver/rechazar. stdout/stderr del Worker se consumen y descartan por privacidad. No se desactivó esa protección para obtener logs.
- El núcleo libera reader, página, documento y loading task antes de enviar respuesta; luego cierra parentPort. Sigue existiendo una terminación explícita del padre. No se ha demostrado que esa secuencia cause la caída.
- PDF.js carga @napi-rs/canvas en su módulo legacy de Node, incluso para esta ruta de texto. Es un candidato de investigación nativa, no una causa probada.
- Después de las ejecuciones fallidas y exitosa, el inventario de procesos Node volvió al mismo proceso preexistente; no quedaron procesos Node nuevos visibles. Esto no mide fugas de handles ni demuestra ausencia de retenciones dentro de un proceso.
- No se observó `ERR_WORKER_OUT_OF_MEMORY`, timeout ni error estructurado PDF que explique la terminación. No hay medición de pico de memoria ni traza de la instrucción nativa fallida.
- La consulta del registro Application para eventos 1000 recientes de node.exe no devolvió registros utilizables. No hay módulo/offset atribuido por ese registro.

## Pendiente para atribuir y corregir

### P2 de supervisión cerrado — preparación de entrega del 21 de octubre

Se añadió un canal IPC explícito (spawn sin shell, cuarto descriptor ipc) cuya vida no termina con el EOF del PDF. El hijo rechaza arrancar sin supervisión, termina al desconectarse y usa un watchdog propio: toma el deadline absoluto de la cabecera, sin extender el límite original. La entrada incompleta también queda sujeta a ese plazo. El exit reservado 124 conserva PDF_EXTRACTION_TIMEOUT en el padre. Mensajes de control estrictos: hijo processing y padre start, una sola vez; nunca PDF, secretos o mensajes arbitrarios. El padre mata los hijos registrados al salir normalmente; una desaparición abrupta desconecta el canal. No se cambiaron límites de memoria, modelos o timeouts de pruebas.

Incidente durante la corrección: la primera regresión real de desconexión venció los 5000 ms. Un diagnóstico sintético mostró el proceso físicamente terminado, pipes cerrados e IPC desconectado, pero Node no emitía ChildProcess.close (contadores internos observados 3/4) al desconectar desde el callback de un mensaje. Se añadió finalización idempotente también por exit confirmado + ambos pipes de salida cerrados + IPC desconectado. No se libera por una mera petición de kill ni por desconexión sola. Se retiran todos los observadores en ambas rutas. Un ajuste inicial del cierre natural no resolvió esa carrera y se conservó el fallo como evidencia; no se atribuyó al ambiente ni se aumentó el timeout.

Otro fallo intermedio fue de expectativa: el controlador puede terminar el hijo con SIGKILL al fallar el acuse por canal ya cerrado, antes de su exit 1 propio. La regresión verifica ambos resultados físicos de cancelación explícitos, y siempre error público PDF_EXTRACTION_ERROR; no acepta un resultado exitoso. El build también detectó que process.disconnect es opcional en los tipos Node; se corrigió la llamada sin cambiar su semántica.

Verificación del P2: 43/43 focalizadas (controlador, núcleo y HTTP), build API y lint API aprobados. Se corrigió además el control positivo de la prueba de cabecera para que el nuevo deadline obligatorio no hiciera aprobar por error los rechazos de campos desconocidos. La comprobación compilada directa aprobó PDF sin texto y muerte abrupta de un padre Node sintético: el hijo observado ya no existía después; no se impuso su terminación por el observador. No se reprodujo ni investigó nuevamente la AV. El watchdog propio se prueba con stdin deliberadamente pendiente, sin timer de extracción en el padre: exit 124. Se mantienen las regresiones de capacidad, cancelación y respuesta tardía.

La evidencia global previa 902/902 y compilado 3/3 pertenece al aislamiento anterior al cierre de este P2; se reutiliza para partes no cambiadas, no se presenta como una suite completa repetida sobre este estado. No se repitieron frontend, auditorías o suite completa por rutina. El watchdog/IPC requieren un event loop operativo; no constituyen un supervisor externo capaz de interrumpir un bloqueo nativo absoluto cuando el padre también murió. Esa limitación queda explícita, sin atribuir la instrucción nativa responsable.

### Mitigación implementada: proceso hijo independiente

Tras autorización se sustituyó el aislamiento worker_threads del controlador por child_process.spawn asíncrono, sin shell. PDF.js se importa y ejecuta en el hilo principal del hijo. El módulo histórico pdf-extractor-worker.mts conserva el núcleo y sus pruebas; ya no tiene lógica de arranque como Worker. La entrada nueva pdf-extractor-child.mts recibe datos por stdin y devuelve una respuesta JSON por stdout. Esta mitigación contiene una caída nativa en otro espacio de direcciones; no identifica la instrucción ni atribuye la causa a Skia.

Se conserva la firma pública extractPdfPages(buffer, limits, runtime opcional) y los DTO/códigos HTTP. Los hooks internos Worker del runtime se sustituyen por processFactory/processUrl para pruebas; runtime.signal permite cancelación. La carga HTTP enlaza aborto/cierre del cliente con ese signal y retira listeners al acabar. No hay reintentos. La extracción sigue limitada por archivo, páginas, elementos, caracteres y plazo. Los clientes autenticados y el análisis/RAG no cambian.

El controlador anterior no tenía un límite global de concurrencia. Ahora se admiten **dos hijos físicos por proceso API**, sin cola; saturación devuelve el código existente PDF_EXTRACTION_LIMIT_EXCEEDED (422). La capacidad se libera solo en close del hijo, después de exit/cierre de streams, incluso ante timeout, cancelación, error o desconexión. No se inicia reemplazo mientras siga ocupado. Si el sistema no permite terminar un hijo, su capacidad permanece ocupada hasta observar el cierre; no se informa terminación ficticia ni se reutiliza el hueco. No hay límite global entre múltiples réplicas API.

Memoria: workerMemoryMb conserva el nombre/configuración externa y se aplica a --max-old-space-size (192 MiB por defecto); --stack-size=4096 conserva el presupuesto de stack de 4 MiB. Estas opciones acotan V8/stack, no RSS ni asignaciones nativas; el límite anterior de Worker tampoco cubría toda memoria nativa. No se presenta como equivalencia exacta del RSS o sandbox. El hijo añade overhead propio de Node y copia de IPC; dos procesos pueden consumir más memoria total que dos Workers. Un límite estricto de memoria nativa requeriría controles del sistema operativo, fuera de esta corrección. Una salida fatal/OOM sin respuesta estructurada se trata conservadoramente como PDF_EXTRACTION_ERROR, sin inferir causa por su código de salida o texto de stderr.

Entorno del hijo: lista permitida SystemRoot/WINDIR/TEMP/TMP para el runtime; no hereda OPENAI/Supabase, VIN_HMAC_SECRET, NODE_OPTIONS ni execArgv de la API. Node se inicia por process.execPath absoluto. Desarrollo añade únicamente el loader tsx resuelto explícitamente; compilación ejecuta .mjs sin tsx. No se emplean flags env-file, variables de proveedor, shell o canales IPC Node heredados.

Canales privados: cabecera JSON estricta de hasta 1024 bytes, límites validados y longitud PDF declarada (máximo absoluto 100 MiB, el mismo techo configurable de la carga); el padre aplica además el límite de archivo de esa API. Entrada binaria sin persistencia. Salida limitada en bytes antes de acumular/parsear, presupuesto derivado de caracteres/elementos/páginas que incluye duplicación y escapes. Esquema estricto de páginas/líneas/fragmentos, coordenadas finitas, orden y contadores comprobados de nuevo por el padre. Mensajes malformados, duplicados, código desconocido, EOF incompleto o exit no cero dan error seguro. No se publica un resultado hasta cerrar físicamente el hijo. Stderr se drena sin reenviar ni registrar diagnósticos internos. Un cierre de canal sin cierre del proceso no libera capacidad y queda sometido al plazo.

Verificación e incidentes de implementación:

- Primeras focalizadas: 31 aprobadas/3 fallidas. PDFs válidos daban 500 porque reconstructLines conserva y en fragmentos, mientras su interfaz previa solo declaraba text/x/width. Se reprodujo inspeccionando únicamente nombres de campos sintéticos. La frontera nueva admite y finita opcional explícitamente; se agregó regresión sin debilitar rechazo de propiedades desconocidas. No fue una caída del pool ni se atribuyó al ambiente.
- Focalizadas finales: **39/39**, tres archivos, sin cambiar timeouts, pool ni concurrencia Vitest.
- Suite global normal ejecutada una vez tras la corrección: **API 697/697, 36 archivos; frontend 205/205, 7 archivos; total 902/902**, sin pérdidas de worker ni rechazos no manejados reportados.
- Lint y build globales aprobados. Advertencia conocida frontend: bundle >500 kB; no se cambió su umbral.
- Comprobación directa compilada: tres casos reales (texto sintético, sin texto y dañado), 3/3; hijo .mjs sin loader tsx; los tres PID ya no existían al retornar.
- La regresión HTTP termina sintéticamente un hijo con exit 23, verifica error 500 controlado, health y siguiente carga real 201 en la misma app. **Prueba contención, no reproducción de una AV real en el nuevo aislamiento.**
- Otras regresiones cubren timeout/cancelación reales, lanzamiento fallido, desconexión, salida excedida, IPC inválido/duplicado, resultado seguido de exit erróneo, capacidad retenida hasta close, eliminación de timers/listeners y credenciales sintéticas no heredadas.
- Diff-check inicial encontró una línea vacía al final al retirar el arranque Worker; se eliminó solo ese whitespace. Manifiestos, lockfile, Vitest, modelos y migraciones intactos.

Reproducción original y mitigación quedan separadas: el A/B demostró crash durante el contexto Worker con importación PDF.js; el proceso hijo elimina ese contexto y contiene una terminación externa. No existe traza que identifique instrucción nativa, ni una serie suficiente para afirmar ausencia de fallos o estabilidad absoluta. No se ejecutaron llamadas a proveedores, ni se leyeron entornos reales, ni se hicieron commits/publicación. Capturas temporales previas conservadas.

### Comparación mínima A/B de importación — caída espontánea reproducida

Experimento local autorizado, fuera de Vitest y sin depurador. Evidencia anterior conservada. Nuevo directorio temporal `autodiag-pdf-import-ab-a8489b693a54485f8fb4313a03412247`, con worker.mjs, target.mjs y supervisor.cjs. Se ejecutó una sola vez `node <directorio>/supervisor.cjs`, que alternó exactamente A1/B1/A2/B2/A3/B3, sin ampliar repeticiones.

Cada proceso objetivo intenta diez Workers secuenciales y espera el exit de uno antes de crear el siguiente. Mismo archivo Worker, execArgv vacío, límites JS 192 MiB/stack 4 MiB, stdout/stderr drenados sin publicar contenido, mensajes y cierre natural mediante parentPort.close en ambas condiciones. No hay terminate explícito ni documentos abiertos. A no importa PDF.js; B importa la URL file de **node_modules/pdfjs-dist/legacy/build/pdf.mjs**, la misma entrada resuelta por el import productivo. Solo B añade mensajes import-start/import-end alrededor de esa importación; ambas envían worker-started/ready. No se usa loader tsx, HTTP, parser Autel, mocks ni archivos de entorno.

Límite externo de 60000 ms por proceso, ejecutado por el supervisor y registrado mediante imposed/killAccepted. Ninguna ejecución alcanzó ese límite; todas tienen imposed=false, señal null y spawnError null.

| Pareja | Condición | PID | Workers completados / previstos | Duración ms | Exit del proceso |
| --- | --- | --- | --- | --- | --- |
| 1 | A | 1944 | 10/10 | 376 | 0 |
| 1 | B | 4072 | 3/10; cuarto alcanza ready | 1662 | **3221225477 / 0xC0000005** |
| 2 | A | 7500 | 10/10 | 268 | 0 |
| 2 | B | 17296 | 10/10 | 2651 | 0 |
| 3 | A | 10680 | 10/10 | 271 | 0 |
| 3 | B | 19372 | 10/10 | 2640 | 0 |

B1: cuarto Worker creado a 2026-10-19T18:14:12.559Z; worker-started/import-start a 18:14:12.581Z; import-end y ready a 18:14:12.819Z. Después el anfitrión terminó con el código nativo, sin worker-exit del cuarto Worker. No se capturó una excepción JavaScript ni stderr; stderr de los seis procesos quedó vacío. Las cinco ejecuciones completas terminaron con resources vacío. Los seis PID ya no existían al comprobarlos; no se impusieron cierres.

**Evidencia nueva:** el mismo exit nativo observado anteriormente es reproducible sin Vitest, sin PDF, sin parsing, sin tsx y sin terminate explícito. En esta muestra A completó 30 Workers y B cayó en un proceso de tres. Esto no es una estimación de probabilidad ni una garantía de inocuidad del control. El fallo ocurre después de la notificación de importación completada/ready y antes de observar la salida del cuarto Worker, compatible con la fase de cierre pero sin pila que permita atribuir la instrucción, el módulo o la corrupción. La instrumentación registra mensajes recibidos por el padre, no un trazado de cada instrucción del hijo. La carga de Skia por sí sola no demuestra causalidad.

**Contraste de soporte, sin nuevas conexiones externas:** se reutiliza la lectura ya realizada de https://github.com/mozilla/pdf.js/issues/21934 . El autor reporta crashes de importación en worker_threads con 5.4.624 y ausencia en las versiones 6.x que probó: son resultados de ese autor en su entorno. El mantenedor afirma que worker_threads no es un contexto soportado por PDF.js, que soportan Web Workers estándar y solo la última versión; no confirma una causa Skia ni garantiza que actualizar elimine nuestro fallo. El producto actualmente importa PDF.js dentro de un Worker de node:worker_threads: comparte ese contexto señalado, aunque PDF.js gestione además su propia infraestructura interna. Esta limitación no la introduce Vitest.

Conclusión actualizada: queda demostrada la reproducción local del mismo tipo de caída nativa en el experimento de importación B. La causa interna y la equivalencia exacta de stack con el crash histórico permanecen desconocidas. No se cambió producto, dependencias, runner o timeouts ni se ejecutaron suites. No se implementó una corrección.

Opciones para una siguiente fase autorizada: evaluar PDF.js actualizado requeriría revisar el salto mayor, Node, contratos de extracción, carga nativa y regresiones; una ejecución verde no garantizaría soporte de worker_threads. Aislar la extracción en un proceso hijo evitaría compartir el espacio de direcciones con la API y permitiría tratar un crash como error del documento, pero exige adaptar IPC, límites de memoria/tiempo, cancelación y limpieza de procesos, con coste de arranque. Ninguna alternativa se valida o implementa con estos seis procesos; la elección debe considerar contención del fallo además de su frecuencia.

### Reproductor sin Vitest ni depurador — tres procesos acotados

Se conservó toda la evidencia anterior. Reproductor y supervisor temporales en `autodiag-pdf-native-2e560bdb20e543b3a55ba3865a8c8a5d`, fuera del repositorio. Comando por intento: `node <directorio-temporal>/runner.cjs N`, N=1,2,3. Cada supervisor inicia un proceso Node independiente, con cwd raíz del proyecto y tsx instalado para importar el extractor TypeScript real; no importa index.ts, no carga archivos de entorno ni inicia HTTP/proveedores. Captura started.json, stdout JSONL, stderr y exit.json por intento, mediante creación exclusiva.

Límite externo explícito: **60000 ms por proceso objetivo**, medido por un supervisor externo. Si vence, registra imposed=true y solicita SIGKILL únicamente para ese PID. Los límites productivos del extractor permanecen intactos (incluido su timeout de 15000 ms). En estos intentos no se impuso ninguna terminación.

El reproductor genera PDFs en memoria con pdf-lib: texto sintético, página sin texto, bytes dañados y documento de dos páginas con maxPages=1. Repite tres veces esos cuatro casos (12 extracciones secuenciales por proceso), verificando éxito o el código seguro esperado. Nunca imprime texto extraído ni persiste PDFs. Mediante workerFactory crea Worker real con las mismas opciones y observa online, mensaje (solo ok/código), error (solo código), llamada a terminate y exit. Esta observación síncrona añade coste y puede cambiar el timing; no es una réplica exacta de producción. No observa directamente el momento de cada operación interna de PDF.js.

| Proceso | PID | Duración total | Exit / señal | Terminación externa | Resultado |
| --- | --- | --- | --- | --- | --- |
| 1 | 17592 | 78 ms | 1 / null | No | Error del arnés antes de extraer: ERR_UNSUPPORTED_ESM_URL_SCHEME |
| 2 | 18576 | 40214 ms | 0 / null | No | 12/12 resultados esperados, sin errores Worker |
| 3 | 6644 | 19443 ms | 0 / null | No | 12/12 resultados esperados, sin errores Worker |

El primer lanzador pasó una ruta Windows absoluta a --import; Node la interpretó como protocolo c:. Se corrigió exclusivamente el supervisor temporal con pathToFileURL. Este fallo se conserva y cuenta como uno de los tres procesos permitidos; no se reemplazó con un cuarto. Los siguientes 24 casos efectivos no tuvieron discrepancias. Duraciones individuales: proceso 2, 1601–4895 ms; proceso 3, 844–1384 ms. stderr vacío en ambos. Al terminar: active=0 y getActiveResourcesInfo() vacío en el proceso objetivo; ninguno de los tres PID seguía presente al comprobarlos. Los Workers emitieron exit 0 o 1: el 1 posterior a terminate no equivale al exit nativo 0xC0000005 del proceso anfitrión.

**Inspección del recorrido:** el endpoint productivo y las pruebas HTTP reales llaman al mismo extractPdfPages. La integración añade Express/multipart, parsing Autel y spies; Vitest transforma/importa el módulo, mientras este ensayo importa TypeScript mediante tsx directamente. Producción compilada usa worker .mjs sin el --import tsx que sí emplea el recorrido fuente .ts/.mts. No se probó aquí el recorrido compilado ni un control de importación sin parseo.

El controlador cancela físicamente mediante terminate ante timeout, error o mensaje, limpia timer/listeners y espera la promesa de terminación. El núcleo cancela el lector si no acabó, libera lock/página, destruye documento/loading task y solo después comunica resultado. Tras el mensaje puede haber terminación explícita mientras el Worker sale naturalmente. Es una zona a contrastar, pero estos resultados no prueban un defecto de esa secuencia. PDF.js legacy importa @napi-rs/canvas para sus polyfills Node; que se cargue el módulo nativo no demuestra que cause el crash. Los resourceLimits limitan el motor JS, no toda memoria nativa.

Versiones locales confirmadas: Node 24.16.0; Vitest 4.1.11; tsx 4.23.11; pdfjs-dist 5.4.624; @napi-rs/canvas 0.1.100. El manifiesto instalado de PDF.js permite Node >=20.16.0 o >=22.3.0 y canvas ^0.1.88: no hay incompatibilidad de rango demostrada con las versiones observadas.

**Contraste con fuentes oficiales:** https://github.com/mozilla/pdf.js/issues/21934 reporta por un tercero el mismo código nativo al importar PDF.js 5.4.624 en worker_threads, incluso sin parsear o terminar explícitamente. El mantenedor señala que ese uso de worker_threads no está soportado y cierra la incidencia. Sus resultados de otras versiones/equipos no prueban la causa local ni justifican actualizar dependencias automáticamente. Es una hipótesis pertinente que ya no depende solo de observar Skia cargado. La documentación Node sobre Worker/terminate confirma la terminación asíncrona y condiciones especiales para addons nativos: https://nodejs.org/docs/latest-v24.x/api/worker_threads.html . Consultadas el 2026-10-19.

Conclusión: no se reprodujo 0xC0000005 fuera de Vitest en este ensayo pequeño. No se demostró un defecto corregible del código local, por lo que no se modificó producto ni se añadió una regresión artificial. Siguen abiertas importación nativa en worker_threads, cierre/terminación, diferencias del loader y recursos/timing del runner. El ensayo no separa esas variables ni demuestra estabilidad. Próximo experimento propuesto: comparación acotada de importación sola de PDF.js frente a un Worker sin esa importación, con mismo supervisor y sin terminación explícita, seguida de contraste con fuente vs compilado si la evidencia lo requiere; no se ejecutó aquí. Sin suites completas, dependencias actualizadas o cambios de timeout.

### Cierre de los tres intentos manuales bajo WinDbg — inconcluso

Se revisaron results.json, stdout.log, stderr.log, exit.json y windbg.log del intento 3, sin iniciar más pruebas ni modificar scripts/configuración.

| Intento bajo WinDbg | Pruebas | Salida del runner | Evidencia de la AV original |
| --- | --- | --- | --- |
| 1 | Sin resumen verificable; indeterminado | No capturada | Usuario no observó AV; sin traza concluyente |
| 2 | 3 aprobadas, 6 timeouts de 5000 ms | 1, señal null | Sin captura nativa |
| 3 | 3 aprobadas, 6 timeouts de 5000 ms | 1, señal null | Ninguna AV de segunda oportunidad registrada; preparación de hijos defectuosa |

**Intento 3:** results.json indica success false, nueve pruebas, cero pendientes, únicamente pdf-integration.test.ts. Los seis fallos corresponden a extracción real (reporte válido, sin texto, dañado, formato no reconocido, exceso de páginas y privacidad); stdout/stderr dicen `Test timed out in 5000ms`. Las tres pruebas con extractor simulado aprobaron. El JSON muestra STACK_TRACE_ERROR en las pilas serializadas; los logs identifican el motivo concreto como timeout, no acceso inválido. El reporter informa duración 36.31 s; no es una medición de rendimiento normal bajo estas condiciones.

exit.json: launcher PID 22804, runner PID 24224, inicio 2026-10-19T07:09:48.170Z y fin 07:10:27.584Z (01:09:48.170 a 01:10:27.584 Guatemala); código 1, señal null, spawnErrorCode null. El launcher y runner ya no existen. Tampoco existe PID 14924 (0x3A4C), identificado en la única línea de excepción de la traza. La consulta de procesos con padre 22804/24224 no devolvió procesos. Esto confirma limpieza de los PID comprobados, no un inventario histórico completo de todos los descendientes: la traza no permite reconstruir todos sus PID. No se terminó ningún proceso desde esta revisión.

**Limitación adicional de instrumentación, responsabilidad de la preparación:** windbg.log conserva seis errores `Command file execution failed, Win32 error 0n2`: el inicial y cinco durante creación de hijos. La salida de `sx` muestra el comando cpr con la ruta a child.txt sin sus separadores de directorio, consumidos en la cadena entre comillas. Cambiar la llamada anidada de `$><` a `$$><` resolvía la concatenación, pero no este segundo problema de escapado. Por ello no se acredita la aplicación del filtro/acción AV a cada hijo. La salida sí muestra el filtro AV de segunda oportunidad en el proceso donde se cargó resume.txt. No se corrigió ni reejecutó ahora; los tres intentos autorizados se agotaron.

No aparece 0xC0000005, un evento de segunda oportunidad ni una ejecución real del marcador AUTODIAG_SECOND_CHANCE_AV (su aparición dentro de la definición del comando no cuenta como ejecución). Hay un evento `000006ba (first chance)` en PID 0x3A4C; no es la AV original ni demuestra una excepción fatal. No existe pila/instrucción de la caída original. Cinco cargas y cuatro descargas del módulo Skia son eventos de ciclo de vida, **no prueba de causalidad**. Los logs de Vitest tampoco contienen Worker exited unexpectedly.

Conclusión: serie de depuración **inconclusa**; dos ejecuciones fallidas por timeout y una indeterminada. El exit nativo 0xC0000005 reproducido antes de estas sesiones sigue sin explicación. No se declara estabilidad, ni causa Windows/canvas/Skia, ni se aumenta el timeout. Antes de cualquier futuro experimento autorizado debe validarse la instrumentación y el escapado de rutas de comandos de hijos en una prueba independiente trivial; después considerar el arnés mínimo de carga/cierre ya propuesto. Ninguno se implementó o ejecutó aquí.

### Intento 3 de 3 preparado — no ejecutado

WinDbg verificado: 1.2610.1001.0. Se contrastaron `sxd` (segunda oportunidad), `sxn` (notificación sin parada), `sxi` (sin parada/notificación), comandos `-c`/`-c2` y eventos ibp/cpr/epr/ct/et/ld/ud en documentación oficial:

- https://learn.microsoft.com/en-us/windows-hardware/drivers/debuggercmds/sx--sxd--sxe--sxi--sxn--sxr--sx---set-exceptions-
- https://learn.microsoft.com/en-us/windows-hardware/drivers/debugger/controlling-exceptions-and-events
- https://learn.microsoft.com/en-us/windows-hardware/drivers/debuggercmds/windbg-command-line-preview

Nuevo directorio temporal separado: `autodiag-pdf-debug-attempt3-c82abab9a5114babb362e5167959e2cb`. Contiene capture.cjs (mismo mecanismo del intento 2, identificador attempt 3), prepare.txt y child.txt. No se sobrescribieron capturas anteriores. `node --check` del lanzador aprobó y el listado de Vitest seleccionó únicamente pdf-integration.test.ts. No se inició el lanzador.

En Launch executable (advanced), usar node.exe y capture.cjs del directorio nuevo; directorio apps/api; seguimiento de hijos activado, TTD desactivado. En la única parada inicial, antes de ejecutar JavaScript del launcher, ejecutar `$><` seguido de la ruta de prepare.txt. El script abre windbg.log en el directorio nuevo, activa `.childdbg 1`, configura `sxi ibp`, notificaciones cpr/epr/ld/ud sin parada y omite paradas ct/et. No ignora genéricamente todas las excepciones ni altera timeouts.

El evento de creación de cada hijo ejecuta child.txt mediante `sxn -c`, sin pedir intervención manual. Como los filtros de excepción pertenecen al proceso, child.txt configura explícitamente en cada hijo:

```text
sxd -c "" -c2 ".echo AUTODIAG_SECOND_CHANCE_AV; .lastevent; |; .time; .exr -1; .ecxr; k; u @rip L1; lm" av
```

No se usa `-h`: no se convierte una AV en manejada. La segunda oportunidad recoge automáticamente PID/evento, hora, excepción/parámetros, contexto, pila, instrucción y módulos, y **no contiene g/gn**, por lo que mantiene la parada para inspección. `lmvm <modulo>` puede completarse entonces para las versiones específicas. Los breakpoints explícitos ajenos al inicial siguen conservando su tratamiento; no confundirlos con ibp. El script imprime `sx` antes del primer `g`: si aparece un error de sintaxis/configuración o una parada rutinaria inesperada, conservar la salida y revisar; no compensar aumentando timeouts. La preparación está verificada estáticamente contra documentación, no ejecutada todavía bajo WinDbg.

Mantiene stdout.log, stderr.log, results.json y exit.json del runner, más started.json/runner.json. windbg.log permite correlacionar los hijos y la excepción; exit.json sigue describiendo al runner, no sustituye el código del fork. En una AV, no continuar hasta revisar la evidencia; luego `gn` permite observar la terminación sin marcarla manejada. Al finalizar, `.logclose` cierra la traza. No usar Restart ni volver a cargar prepare.txt para repetir el experimento.

Si este último intento no captura la caída original, cerrar esta serie como **inconclusa**, incluso si aprueban 9/9. No ejecutar un cuarto intento sin otro plan autorizado. Próximo experimento propuesto según evidencia: separar en un arnés sintético mínimo la carga/cierre repetido del Worker y la importación PDF.js, conservando versiones y límites y observando códigos nativos, primero sin depurador; comparar con un Worker de control sin PDF.js. Esto permitiría localizar una etapa antes de probar cambios, pero no está implementado ni ejecutado aquí y no atribuye el problema a canvas o Windows.

### Resultado consolidado del intento manual 2 — 2026-10-19

Se inspeccionaron los archivos temporales después de que el usuario continuara con `g` la misma sesión. Según el usuario, WinDbg estaba detenido en la salida del hijo PID 9972 con código 1; esta observación de WinDbg fue comunicada, no capturada directamente por el asistente.

- `results.json`: únicamente pdf-integration.test.ts; nueve resultados, **3 aprobados, 6 fallidos, 0 pendientes**, `success: false`.
- stdout/stderr identifican los seis fallos como `Test timed out in 5000ms`. Son las pruebas con extracción PDF real; las tres con extractor simulado aprobaron. Las doce apariciones del mensaje entre ambos logs corresponden a esos seis fallos duplicados en los reportes, no a doce pruebas.
- `exit.json` ya existe: runner PID **16288**, código **1**, señal **null**, `spawnErrorCode: null`. Inicio `2026-10-19T06:55:11.691Z`; cierre `2026-10-19T07:00:08.206Z` (00:55:11.691 a 01:00:08.206, Guatemala). El intervalo incluye interacción y pausas de depuración; no es latencia de extracción.
- Launcher PID **3700**, runner PID **16288** y el hijo **9972** comunicado por el usuario ya no aparecen en el inventario de procesos. No se terminaron procesos desde esta revisión.
- No aparecen marcadores `0xC0000005`, `3221225477`, `Worker exited unexpectedly` ni `Worker forks emitted error` en stdout/stderr. No se obtuvo una traza nativa en este intento.

Conclusión: ejecución terminada y verificablemente fallida por seis timeouts del runner de pruebas; **no es reproducción acreditada de la caída nativa original**. Las pausas o sobrecarga de depuración podrían influir, pero no se ha demostrado la causa concreta de estos timeouts. El código 1 del runner no equivale al código nativo 0xC0000005 observado previamente. No se infiere estabilidad ni se atribuye el fallo a un módulo. No se inició el intento 3, no se cambiaron límites/configuración y la caída nativa original sigue sin explicación.

### Segundo intento bajo WinDbg preparado, no iniciado

El usuario informó que la primera ejecución manual no capturó 0xC0000005, pero el panel tampoco contenía resumen de Vitest ni códigos de salida. Se registra como **indeterminada**, no como aprobada, ni como evidencia de estabilidad. No existe traza para atribuirla a un módulo. Cuenta como la primera de las tres ejecuciones autorizadas bajo depurador.

Se consultó únicamente la ayuda local de Vitest 4.1.11 (`run --help`): admite reporteros verbose/json y `--outputFile.json` para dirigir el JSON. Se verificó con `list src/pdf-integration.test.ts --filesOnly` que se selecciona exactamente ese archivo. No se ejecutaron pruebas al preparar esta captura.

Se creó fuera del repositorio el directorio temporal `autodiag-pdf-debug-8af929de69f744e88a150a2067c1f8ed`, con un lanzador `capture.cjs`. La comprobación `node --check` aprobó; comprueba sintaxis, no ejecuta el lanzador. Este inicia directamente Node/Vitest (sin npm, shell ni carga explícita de archivos de entorno), con directorio de trabajo apps/api y argumentos:

```text
run src/pdf-integration.test.ts --reporter=verbose --reporter=json --outputFile.json=<directorio-temporal>/results.json --no-color
```

El lanzador crea `started.json` con hora/PID propio, `runner.json` con PID del runner, `stdout.log`, `stderr.log`, y al cerrar el runner `exit.json` con código, señal y horas. stdout/stderr se redirigen a descriptores de archivo, sin depender del panel WinDbg ni de un consumidor de pipes. `results.json` depende de que el reporter alcance su finalización; si falta, no se infiere aprobación. `exit.json` corresponde al runner, no necesariamente al fork que haya caído: el PID y excepción del fork se obtienen con WinDbg.

Los archivos del lanzador usan creación exclusiva; reiniciar el mismo lanzador no vuelve a ejecutar la prueba ni sobrescribe la captura. No borrar esa protección para repetir: una tercera ejecución necesitaría otro directorio. Una captura incompleta (sin exit o resumen) sigue siendo indeterminada. Si el propio lanzador fuese terminado por el depurador, podría no producir exit.json.

Configuración manual para este segundo intento: Launch executable (advanced), ejecutable node.exe, argumento la ruta entre comillas al capture.cjs temporal, Start directory apps/api, Debug child processes activado, TTD desactivado. Así WinDbg sigue launcher → runner Vitest → fork de prueba. En la parada inicial `sxd av`, luego `g`; continuar con `g` solamente los breakpoints iniciales de hijos. Ante AV de segunda oportunidad, capturar `.lastevent`, `|`, `.time`, `.exr -1`, `.ecxr`, `k`, `u @rip L1` y módulos/versiones antes de continuar. No cambiar timeouts: las pausas pueden provocar fallos temporales que deberán distinguirse del crash nativo.

No iniciado: esperar la ejecución manual. No se crearon procesos de prueba. La captura usa únicamente PDFs sintéticos de esta prueba; los logs pueden contener rutas locales y se conservarán fuera del repositorio. No publicar contenido crudo: documentar solo resultados y evidencia técnica saneada. No se realizaron llamadas externas, instalaciones ni cambios al runner o al producto.

### Instalación verificada e interacción manual pendiente — 2026-10-19

La ruta exacta aportada por el usuario existe; DbgX.Shell.exe informa versión **1.2610.1001.0**, paquete Microsoft.WinDbg x64. No se infirió la presencia de CDB. La rama y HEAD permanecen sin cambios.

Se consultaron las páginas oficiales de WinDbg moderno enlazadas abajo. El formulario correcto para especificar argumentos, directorio y seguimiento de hijos es **File → Start debugging → Launch executable (advanced)**. No se lanzó DbgX.Shell.exe con una línea de CDB sin verificar.

La automatización de la ventana mediante la habilidad Computer Use falló al conectar con su canal nativo: `Computer Use native pipe is unavailable`, os error 2. Esto impide controlar la ventana desde esta sesión, aunque el ejecutable esté instalado. No es un error del extractor ni una prueba fallida. Se requiere interacción manual en WinDbg; no se intentó sustituirla por automatización de interfaz no soportada.

El comando `node ../../node_modules/vitest/vitest.mjs list src/pdf-integration.test.ts --filesOnly`, desde apps/api, devolvió únicamente `src/pdf-integration.test.ts`. **Ejecuciones bajo depurador iniciadas: 0 de 3**. No se crearon trazas, dumps ni procesos objetivo que limpiar.

Campos del formulario avanzado:

- Executable: node.exe de la instalación existente de Node (Program Files/nodejs).
- Arguments: `../../node_modules/vitest/vitest.mjs run src/pdf-integration.test.ts --reporter=verbose`.
- Start directory: apps/api dentro del repositorio.
- Target bitness: 64 bit o Autodetect.
- Debug child processes: activado.
- Record with Time Travel Debugging: desactivado.

Tras Launch, en la parada inicial, escribir `sxd av` y después `g`. Se detendrá en segunda oportunidad ante una AV no manejada; no se suprime la excepción ni se marca como manejada. Los avisos de primera oportunidad por sí solos no se contarán como crash. Ante una parada inicial de un hijo por breakpoint de inicio (no AV), continuar con `g`.

Cuando se detenga por AV de segunda oportunidad, no continuar todavía: `.lastevent`, `|`, `.time`, `.exr -1`, `.ecxr`, `k`, `u @rip L1`, `lm`. Después `lmvm <nombre-del-modulo-del-fallo>`. Conservar los resultados localmente para sanear código/parámetros, PID, pila, instrucción y versiones, eliminando rutas personales. No ejecutar comandos de entorno, lectura del PDF, dump o TTD. Si hacen falta símbolos, usar la caché temporal y el servidor oficial descritos más abajo; no configurar rutas globales.

La segunda oportunidad indica que el programa no manejó la excepción; la confirmación del exit se hará después de capturar la evidencia mediante `gn`, observando el PID y resultado final. No confundir el breakpoint inicial con una excepción fatal. Si las nueve pruebas terminan sin AV, registrar ese único intento y no afirmar estabilidad. No iniciar automáticamente un cuarto intento.

Fuentes oficiales consultadas el 2026-10-19:

- https://learn.microsoft.com/en-us/windows-hardware/drivers/debuggercmds/windbg-user-mode-preview
- https://learn.microsoft.com/en-us/windows-hardware/drivers/debuggercmds/windbg-command-line-preview

### WinDbg instalado según el usuario, pero no localizable en esta sesión

El usuario confirmó la instalación y autorizó hasta tres ejecuciones aisladas bajo WinDbg y descarga de símbolos oficiales. La comprobación posterior no encontró WinDbg/WinDbgX en PATH, paquetes WinDbg del usuario actual, procesos WinDbg activos, accesos directos en los menús Inicio habituales ni entradas WinDbg en las claves de desinstalación consultadas. Tampoco apareció en las ubicaciones habituales comprobadas. Esto **no demuestra ausencia de instalación**: puede no estar visible para esta sesión o estar en otra ubicación. La consulta `Get-AppxPackage -AllUsers` devolvió **Acceso denegado**; no se intentó elevar privilegios ni sortear esa restricción.

Se realizaron cero ejecuciones de prueba en este seguimiento; no se creó ningún proceso objetivo, dump o traza. No hay captura nueva de excepción, pila, instrucción o módulos. No se supuso que WinDbg instalara CDB.

Paso manual requerido para localizarlo: abrir WinDbg desde Inicio y facilitar la ruta de su ejecutable (Administrador de tareas → Detalles → proceso WinDbg → Abrir ubicación del archivo). No ejecutar todavía la prueba ni enviar variables de entorno. Una ruta explícita permitirá verificar su versión y reanudar la sesión autorizada sin búsquedas amplias o privilegios adicionales.

Procedimiento adaptado a la interfaz de WinDbg moderno, contrastado con Microsoft:

- https://learn.microsoft.com/en-us/windows-hardware/drivers/debuggercmds/windbg-user-mode-preview
- https://learn.microsoft.com/en-us/windows-hardware/drivers/debuggercmds/windbg-command-line-preview

Seleccionar **File → Start debugging → Launch executable**. Executable: la ruta de node.exe obtenida con `Get-Command node.exe`. Arguments: `../../node_modules/vitest/vitest.mjs run src/pdf-integration.test.ts --reporter=verbose`. Start directory: el directorio apps/api del repositorio. Activar **Debug child processes** y mantener **Record with Time Travel Debugging** desactivado. Antes de Launch, verificar el filtro mediante el comando list ya documentado. No utilizar npm test, que añade el filtro src.

En la parada inicial, ejecutar `sxe av` y después `g`; ante AV, usar los comandos de inspección y distinción primera/segunda oportunidad ya documentados. Para símbolos, usar una caché temporal privada fuera del repositorio con ruta explícita en `.sympath srv*<cache-temporal>*https://msdl.microsoft.com/download/symbols`, sin cambiar variables ni configuración global. Descargar únicamente símbolos oficiales necesarios; la ausencia de símbolos de un módulo se debe registrar, no sustituir por atribuciones inventadas. No generar dumps o grabaciones TTD. El límite de tres ejecuciones bajo depurador aún no se consumió.

### Disponibilidad de depurador — 2026-10-17

La sesión de depuración aislada fue autorizada, con máximo tres ejecuciones. Se revisó PATH mediante `Get-Command` para cdb, windbg, windbgx y ntsd; las ubicaciones x64 habituales de Windows Kits 10 y 8.1 y Debugging Tools for Windows; y los paquetes WinDbg del usuario actual mediante `Get-AppxPackage`. No se encontró un depurador utilizable. No se recorrió el disco completo ni se puede descartar una instalación personalizada fuera de esas ubicaciones.

**Cero ejecuciones nuevas** en esta fase: sin depurador no se obtendría la traza solicitada. No se instalaron herramientas, solicitaron privilegios, cambiaron ajustes del sistema ni crearon procesos de prueba, trazas o dumps que requirieran limpieza. La excepción, pila, instrucción y fase exacta del crash siguen pendientes.

Herramienta requerida: Microsoft WinDbg, o CDB x64 de Debugging Tools for Windows. Fuente oficial de instalación (solo referencia, no ejecutada): https://learn.microsoft.com/en-us/windows-hardware/drivers/debugger/ . Microsoft publica WinDbg mediante instalador, Store o `winget install Microsoft.WinDbg`; la instalación no está autorizada en este experimento y no se realizó.

Se contrastaron las opciones con documentación oficial:

- CDB y seguimiento de hijos `-o`: https://learn.microsoft.com/en-us/windows-hardware/drivers/debugger/cdb-command-line-options
- Primera/segunda oportunidad y filtros de excepción: https://learn.microsoft.com/en-us/windows-hardware/drivers/debugger/controlling-exceptions-and-events

Procedimiento concreto cuando CDB x64 esté disponible, desde apps/api, con ruta de herramienta resuelta previamente:

```powershell
node ../../node_modules/vitest/vitest.mjs list src/pdf-integration.test.ts --filesOnly
# Continuar solo si devuelve exclusivamente src/pdf-integration.test.ts.
cdb.exe -o -c "sxe av; g" node.exe ../../node_modules/vitest/vitest.mjs run src/pdf-integration.test.ts --reporter=verbose
```

En la parada por acceso inválido: `.lastevent` y `|` para identificar evento/proceso, `.exr -1` para código y parámetros, `.ecxr`, `k`, `u @rip L1` para la instrucción x64 y `lmvm <modulo>` para módulo/versión. Mantener salida cruda únicamente en ubicación temporal privada fuera del repositorio; publicar solo evidencia saneada. No inspeccionar entorno ni memoria de reportes. Continuar una excepción de primera oportunidad con `gn` para permitir su tratamiento por el programa, sin marcarla artificialmente como manejada; registrar si llega a segunda oportunidad o si el proceso continúa. No atribuir cierre/cancelación únicamente por la última prueba impresa.

Máximo tres ejecuciones aisladas bajo depurador. Registrar PID/hora de los procesos creados; al terminar, verificar esos PID y sus hijos contra el inventario inicial. Si hay que interrumpir, finalizar únicamente los procesos de esta sesión, nunca todos los node.exe por nombre. No usar comandos de dump ni activar registro de volcados. Si la herramienta requiere elevación, detenerse y reportarla. Las pausas pueden alterar tiempos y una ejecución sin crash no acredita estabilidad.

### Correlación Windows posterior — 2026-10-17

El documento inicial omitió horas y PID. Se recuperaron de la salida conservada de la sesión, sin reconstruirlos a partir de eventos:

| Intento | Inicio local (UTC−06:00) | PID del fork observado | Resultado |
| --- | --- | --- | --- |
| 1, filtro ampliado | 23:19:33 | No capturado por observador | Runner 1; caída de fork |
| 2, PDF aislado | 23:19:59 | 11136 (0x2B80) | 3221225477 / 0xC0000005, señal null |
| 3, PDF aislado | 23:20:24 | 12628 | 9/9; runner 0; cierre SIGTERM |

Consulta limitada a Application, IDs 1000 y 1001, entre 2026-10-17 23:18:30 y 23:22:00, mediante `Get-WinEvent -FilterHashtable`: **ningún evento**, `NoMatchingEventsFound`. No se leyó ni publicó el mensaje completo de eventos ajenos. Por tanto, los registros no aportan ejecutable/versiones, módulo/versiones, excepción ni offset correlacionables. La versión Node indicada arriba procede del CLI, no de un evento de fallo. No se demuestra por qué Windows no registró un evento en esa ventana.

Se autorizó y realizó exactamente un intento adicional. Antes, desde apps/api:

```powershell
node ../../node_modules/vitest/vitest.mjs list src/pdf-integration.test.ts --filesOnly
```

La salida fue exclusivamente `src/pdf-integration.test.ts`. Se ejecutó el mismo observador en memoria, agregando `at: new Date().toISOString()` a los eventos fork y exit:

- PID 19564; creación `2026-10-18T05:25:01.277Z` = 2026-10-17 23:25:01.277 UTC−06:00.
- Exit `2026-10-18T05:25:07.628Z` = 23:25:07.628 local, código null y señal SIGTERM tras completar las pruebas.
- 9/9 aprobadas; runner salida 0; duración 6.33 s. No reprodujo la caída y no acredita su resolución.
- Consulta Application IDs 1000/1001 entre 23:24:30 y 23:25:15.556 local: cero eventos, `NoMatchingEventsFound`.
- Tras terminar permaneció solo el proceso Node preexistente; ningún nuevo Node visible.

Para una correlación futura, usar el PID del proceso afectado en **EventData** (según la versión del evento, `ProcessId` o `AppProcessId`, normalizando hexadecimal). **No** usar `System/Execution/ProcessID`: pertenece al proceso que emite el evento y puede ser WER. Evento 1001 puede carecer del PID afectado; sus campos P1/P4 no deben interpretarse sin comprobar el tipo de informe. Si no hay PID, solo se podrá indicar correspondencia temporal/de firma, no identidad de proceso demostrada. En estas consultas no hubo evento alguno que permitiera esa comparación.

### Siguiente experimento mínimo propuesto, todavía no ejecutado

Capturar una traza bajo un depurador nativo ya disponible, o preparar su instalación únicamente con autorización posterior. No habilitar LocalDumps ni modificar el registro como primer paso. No se instaló ni ejecutó un depurador, ni se produjo un dump en esta fase.

1. Con Windows Debugger disponible y autorización para una nueva ejecución sintética, lanzar bajo el depurador el ejecutable Node con `../../node_modules/vitest/vitest.mjs run src/pdf-integration.test.ts --reporter=verbose`, directorio de trabajo apps/api. Usar depuración de procesos hijos (opción `-o` del debugger clásico, o `.childdbg 1` antes de continuar) para observar también el fork, no solamente el coordinador Vitest. No cargar entornos ni usar el script dev.
2. Configurar ruptura ante acceso inválido con `sxe av` y continuar con `g`. Capturar PID y hora al detenerse. Verificar que el proceso sea el fork de la prueba. Una pausa de depurador puede alterar tiempos: no presentar esta ejecución como prueba de rendimiento o aprobación de la suite.
3. Ante la excepción, inspeccionar `.exr -1`, `.ecxr`, `k` y `lmvm <modulo>`; registrar únicamente código, offset relativo, versión del módulo y nombres de funciones de la pila. No publicar registros con punteros, memoria, argumentos, rutas personales o salida completa. No confundir una excepción manejada de primera oportunidad con el crash final: documentar si llega a segunda oportunidad.
4. No generar dump por defecto. Si la pila no basta, proponer por separado captura privada fuera del repositorio, con alcance y revisión de privacidad explícitos antes de habilitarla. Evitar carga automática de símbolos externos sin autorización.
5. Solo tras identificar una pila reproducible, diseñar una comparación acotada de carga/cierre del componente señalado. Que un módulo figure en la excepción no demuestra que originara la corrupción; no actualizar dependencias ni cambiar terminación/concurrencia basándose únicamente en su nombre.

Obtener una traza nativa o dump controlado del proceso de pruebas exclusivamente sintéticas, fuera del repositorio y con revisión de privacidad; identificar módulo y stack antes de proponer cambios. Contrastar después una reproducción mínima de carga/cierre del Worker con el componente señalado. No atribuirlo a concurrencia: el archivo aislado también cayó.

No se aplica serialización global, aumento de timeout, cambio de pool, supresión de errores o actualización especulativa. Tampoco se repiten frontend/build: solo se agregó este diagnóstico. El fallo de la suite normal permanece abierto.
