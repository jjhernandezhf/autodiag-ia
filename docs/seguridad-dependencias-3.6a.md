# FASE 3.6A — Correcciones de dependencias

Revisión del 16 de octubre de 2026 sobre la base `4496bd27d813d660ab5840de4a87d15524f15492`. Entorno de verificación: Node 24.16.0 y npm 11.13.0. No se utilizan entornos privados, reportes ni proveedores reales en las pruebas.

## Diagnóstico y cambios mínimos

Auditoría inicial de producción: 2 paquetes afectados (1 crítico y 1 bajo). Auditoría inicial completa: 6 paquetes afectados (3 críticos, 2 altos y 1 bajo). Son conteos de paquetes de npm audit, no de CVE: `concurrently` hereda el aviso de `shell-quote`.

| Paquete y cadena | Ámbito | Versión anterior → resuelta | Avisos y condición relevante |
| --- | --- | --- | --- |
| API → Express → proxy-addr | Producción | 2.0.7 → 2.0.8 | [GHSA-jqcg-44mw-7w3h](https://github.com/advisories/GHSA-jqcg-44mw-7w3h), crítico: una subred IPv6 de confianza mal interpretada permite suplantar IP mediante X-Forwarded-For. |
| Web → jsPDF → DOMPurify (opcional) | Producción | 3.4.15 → 3.4.17 | [GHSA-p98j-92pf-mc4p](https://github.com/advisories/GHSA-p98j-92pf-mc4p) y [GHSA-6688-9rhm-gjv2](https://github.com/advisories/GHSA-6688-9rhm-gjv2), bajos: XSS con IN_PLACE, eliminación por hooks o raíces rawtext y posterior reinterpretación HTML. Corregidos desde 3.4.16; 3.4.17 añade endurecimiento del mismo sanitizador. |
| ESLint / typescript-eslint → minimatch → brace-expansion | Desarrollo | 5.0.9 → 5.0.12 | [GHSA-q2hr-2g5m-vwhr](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr), moderado; [GHSA-qhr7-859c-m2p7](https://github.com/advisories/GHSA-qhr7-859c-m2p7) y [GHSA-6j4f-fj2g-mc7p](https://github.com/advisories/GHSA-6j4f-fj2g-mc7p), altos: patrones de llaves manipulados causan consumo cuadrático o agotamiento de pila. |
| Raíz → concurrently → shell-quote | Desarrollo | concurrently 10.0.4 → 10.0.6; shell-quote 1.9.0 → 1.12.0 | [GHSA-pqg4-j6r4-53mv](https://github.com/advisories/GHSA-pqg4-j6r4-53mv), crítico según npm: inyección al citar un token con salto de línea después de un token comentario y ejecutar el resultado en un shell. Corregido desde shell-quote 1.11.0. |
| Vite → PostCSS; jsdom → css-tree → source-map-js | Desarrollo | 1.2.1 → 1.2.2 | [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q), alto: offsets de secciones de mapas de fuentes manipulados bloquean el event loop. |

No se declara segura una dependencia por no identificar su ruta de explotación en la aplicación. Se actualizan todas las resoluciones afectadas identificadas por estas auditorías.

Se ejecutó `npm update proxy-addr dompurify brace-expansion source-map-js concurrently --package-lock-only --ignore-scripts --no-fund --no-audit`. npm actualizó solamente seis registros de paquetes y los metadatos asociados en el lockfile v3. Sin ediciones manuales del lockfile, cambios de manifiestos, overrides, nuevos paquetes ni actualizaciones generales.

## Compatibilidad

- Express admite proxy-addr `^2.0.7`; jsPDF admite DOMPurify `^3.3.1`; minimatch admite brace-expansion `^5.0.8`; PostCSS y css-tree admiten source-map-js `^1.2.1`. Las resoluciones nuevas satisfacen esos rangos.
- El manifiesto raíz ya admite concurrently `^10.0.4`. La [versión 10.0.6](https://github.com/open-cli-tools/concurrently/releases/tag/v10.0.6) actualiza su dependencia exacta a shell-quote 1.12.0 y corrige logging de terminación; no requiere imponer un override contra el contrato del consumidor.
- proxy-addr requiere Node ≥0.10, shell-quote ≥0.4, source-map-js ≥0.10 y brace-expansion `20 || >=22`. DOMPurify no declara engines.node en sus metadatos publicados. No cambian los requisitos de Node de los paquetes actualizados.
- Existe una discrepancia preexistente: concurrently 10.0.4 ya exigía Node ≥22, igual que 10.0.6, mientras el proyecto declara `^20.19.0 || >=22.12.0`. Esta fase no certifica el arranque conjunto en Node 20 ni modifica ese rango. Reconciliarlo requiere una decisión separada sobre soporte de Node o la línea mayor de concurrently; no se oculta mediante engine overrides. Las verificaciones de esta fase utilizan Node 24.16.0.
- Se consultaron advisories, metadatos de npm y notas del mantenedor: [proxy-addr 2.0.8](https://github.com/jshttp/proxy-addr/releases/tag/v2.0.8), [DOMPurify 3.4.16](https://github.com/cure53/DOMPurify/releases/tag/3.4.16), [3.4.17](https://github.com/cure53/DOMPurify/releases/tag/3.4.17), [brace-expansion 5.0.12](https://github.com/juliangruber/brace-expansion/releases/tag/v5.0.12), [shell-quote](https://github.com/ljharb/shell-quote/blob/v1.12.0/CHANGELOG.md) y [source-map-js 1.2.2](https://github.com/7rulnik/source-map-js/releases/tag/v1.2.2).

No se modifican modelo, prompt, fingerprints, presupuestos, reintentos, idempotencia, RAG, autenticación, contratos ni migraciones. Un audit sin avisos solo describe los advisories conocidos para este árbol en el momento de consulta, no demuestra ausencia de vulnerabilidades.

## Verificación realizada

- `npm ci --no-fund`: aprobado, 408 paquetes instalados y 411 auditados; sin modificación adicional del lockfile. Advertencia de deprecación de whatwg-encoding 3.1.1, sin aviso de vulnerabilidad en estas auditorías.
- Focalizadas API (`app`, `auth-integration`, `runtime-workflow`): 35/35, 3 archivos.
- Focalizadas frontend (`report-pdf`, `vite.config`): 36/36, 2 archivos.
- Comprobaciones sintéticas directas, ejecutadas en memoria: subred IPv6 de confianza no acepta IP ajena; subred IPv4 legítima sigue funcionando; shell-quote rechaza salto de línea después de comentario; expansión normal de llaves; sanitización de HTML hostil; round-trip de mapa de fuentes; dos procesos Node sintéticos terminan correctamente mediante concurrently. Sin ejecutar el texto malicioso en un shell, servidores ni acceso a proveedores.
- Suite API completa normal: 585/585, 33 archivos. Suite frontend completa normal: 197/197, 7 archivos. Total: 782/782. Sin aserciones fallidas ni caídas de workers en estas ejecuciones.
- `npm run lint` y `npm run build`: aprobados. Build conserva la advertencia del bundle mayor de 500 kB; no se ajustan límites para ocultarla.
- `npm audit --omit=dev` y `npm audit` finales: 0 vulnerabilidades, código 0 en ambos. Inicialmente ambos devolvieron código 1 por los avisos detallados arriba, no por un fallo de ejecución.
- Comparación estructural del lockfile: versión 3 y mismo conjunto de paquetes; exactamente seis registros actualizados, todos dentro del rango del consumidor y con engines sin cambios. Manifiestos intactos.
- `git diff --check` y comprobación de whitespace de este documento nuevo: aprobados. Entornos reales ignorados y no rastreados; sin lectura de sus contenidos. Sin staging ni publicación.

Las notas de versión locales no están incluidas en todos los tarballs: se contrastaron con las publicaciones oficiales enlazadas, no se asumió su contenido. No se aplicaron migraciones ni se iniciaron servicios reales.
