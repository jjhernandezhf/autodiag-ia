# Estadísticas del historial

En el workspace autenticado, abre **Estadísticas**. Se carga automáticamente el
resumen sin filtros: todas las fechas, marcas y modelos disponibles dentro de
los límites documentados. **Actualizar** repite la consulta, sin polling.
El panel secundario permite filtrar voluntariamente; **Restablecer filtros**
consulta automáticamente el resumen general. Los filtros son fechas inclusivas en
`America/Guatemala`, marca y modelo completos: comparación exacta en backend,
ignorando mayúsculas/minúsculas y espacios al inicio/final. Vacíos o solo espacios
significan todos. No hay búsqueda parcial, comodines ni expresiones regulares.
Se conservan los nombres originales en la presentación y las agrupaciones. Cambiar
un filtro retira el resultado anterior hasta consultar nuevamente.

El gráfico temporal coloca puntos según la fecha real, con eje de cantidades
y tabla accesible de todos los valores; no interpola días no observados.
Las barras muestran seis categorías principales y explicitan el total de
categorías; **Ver todos** permite expandirlas sin agrupaciones ficticias.
La última actualización se presenta en horario de Guatemala.

Las descripciones DTC provienen exclusivamente de `descriptionOriginal` del
snapshot persistido, con validación de longitud y contenido sensible. La
exportación CSV conserva sus campos anteriores. Se presentan variantes con
marca, modelo, año, módulo y enlaces a los análisis correspondientes. No se
elige arbitrariamente la primera descripción entre significados distintos.
Texto ausente: «Descripción no disponible». El recorte visual permite abrir el
texto completo, sin reescribirlo ni interpretar el código. Las variantes no
suman frecuencias: sigue contándose cada análisis una sola vez por código.

- **Análisis guardados:** filas históricas seleccionadas, no vehículos únicos.
- **Registros DTC:** todas las apariciones persistidas.
- **Códigos distintos:** valores exactos de código, incluidos sus sufijos.
- **Frecuencia DTC:** análisis distintos que contienen cada código. Repeticiones
  en varios módulos del mismo análisis cuentan una vez para ese código.
- **Módulos:** identidad completa `(moduleCode, moduleName)`, con frecuencia de
  análisis distintos. Un código ausente se muestra como «sin código» y no se
  inventa a partir del nombre.
- Evolución diaria y distribución por marca/modelo cuentan análisis. Gráficas y
  tabla usan la misma selección. **Abrir diagnóstico** usa el detalle histórico
  autenticado existente.

No se deducen averías confirmadas, gravedad, reparaciones, precisión ni latencias.
Los valores obligatorios ausentes o inválidos en registros antiguos causan un
error controlado de conjunto completo, nunca se rellenan con datos inventados.
Una selección vacía muestra explícitamente cero registros.

## Recursos y privacidad

`GET /api/history/statistics` admite únicamente `from`, `to`, `make`, `model`.
El usuario se obtiene de la autenticación; todas las consultas filtran por él.
No recibe identidad desde el navegador. Devuelve un DTO explícito de agregados
y filas mínimas con el identificador ya público del detalle histórico.
No devuelve VIN, observaciones, diagnóstico libre, hashes, credenciales o snapshots.
Las respuestas son `no-store`; no se persisten estadísticas en el navegador.
Logout/cambio de identidad desmonta el workspace y cancela/descarta respuestas.

La lectura reutiliza validación, paginación keyset, corte temporal, cancelación
y presupuesto del exportador CSV, sin descargar ni analizar CSV. Se conservan
ambos CSV. Los límites compartidos son 200 análisis del historial completo,
500 DTC por análisis, 10 000 DTC totales, 4 MiB de datos, 10 segundos y dos
operaciones físicas simultáneas por proceso. También se limita a 4 MiB el DTO.
Los filtros se aplican **después** de validar el conjunto completo: no permiten
eludir esos límites. Un historial que los excede no ofrece estadísticas parciales.
Los rankings iniciales son top-N explícitos, expandibles a todos los resultados.
El corte no equivale a una transacción entre páginas; evitar modificaciones
administrativas concurrentes. No se modifica ningún registro.

Consultar estadísticas o abrir historial no invoca análisis, embeddings ni RAG.
Los fixtures prueban cálculos y aislamiento, no calidad diagnóstica real.

## Comprobación manual y guion reutilizable

El usuario reportó satisfactorias las pruebas manuales de Estadísticas.
Esta evidencia es un reporte del usuario, no una comprobación realizada por
herramientas automatizadas ni una medición de calidad diagnóstica. No se dispone
de un registro individual de resultados para cada paso del siguiente guion.

1. Entrar con una cuenta con historial; abrir Estadísticas y comprobar carga automática.
2. Contrastar conteos y fechas con la tabla; aplicar fecha, marca y modelo.
3. Abrir un diagnóstico y comprobar el detalle habitual y su exportación PDF.
4. Revisar móvil, selección vacía y reintento después de un error de API.
5. Cerrar sesión durante una consulta y entrar con otra cuenta: no deben
   aparecer estadísticas anteriores. Usar cuentas y datos autorizados.

La confirmación manual no acredita un despliegue de estos cambios ni sustituye
la revisión específica de escenarios que no hayan quedado registrados.
