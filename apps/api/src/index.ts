import express from "express";
import { z } from "zod";

const portSchema = z.coerce.number().int().min(1).max(65_535).default(3_000);
const port = portSchema.parse(process.env.PORT);

const app = express();

app.use(express.json());

app.get("/health", (_request, response) => {
  response.json({ status: "ok", service: "AutoDiag IA" });
});

app.listen(port, () => {
  console.log(`AutoDiag IA API disponible en http://localhost:${port}`);
});

