# AutoDiag IA

Monorepo base para AutoDiag IA.

## Aplicaciones

- `apps/web`: frontend con React, TypeScript y Vite.
- `apps/api`: API con Node.js, TypeScript, Express y Zod.

## Requisitos

- Node.js `^20.19.0 || >=22.12.0`.
- npm 10 o superior.

## Comandos

```bash
npm install
npm run dev
npm run build
npm test
npm run lint
```

Durante el desarrollo, la aplicación web se sirve en `http://localhost:5173` y la API en `http://localhost:3000`. La API expone `GET /health`.
