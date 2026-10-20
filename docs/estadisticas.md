# Estadísticas del historial

En el workspace autenticado, abre **Estadísticas** y pulsa **Consultar estadísticas**.
La consulta es explícita, sin polling. Los filtros son fechas inclusivas en
`America/Guatemala`, marca exacta y modelo exacto (respetan mayúsculas). Cambiar
un filtro retira el resultado anterior hasta consultar nuevamente.

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
No hay truncamiento top-N: las listas gráficas completas tienen desplazamiento.
El corte no equivale a una transacción entre páginas; evitar modificaciones
administrativas concurrentes. No se modifica ningún registro.

Consultar estadísticas o abrir historial no invoca análisis, embeddings ni RAG.
Los fixtures prueban cálculos y aislamiento, no calidad diagnóstica real.

## Comprobación manual pendiente

1. Entrar con una cuenta con historial; abrir Estadísticas y consultar.
2. Contrastar conteos y fechas con la tabla; aplicar fecha, marca y modelo.
3. Abrir un diagnóstico y comprobar el detalle habitual y su exportación PDF.
4. Revisar móvil, selección vacía y reintento después de un error de API.
5. Cerrar sesión durante una consulta y entrar con otra cuenta: no deben
   aparecer estadísticas anteriores. Usar cuentas y datos autorizados.

No se ha validado todavía el tablero contra datos reales ni desplegado esta fase.
