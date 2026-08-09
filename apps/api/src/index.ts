import { createApp } from "./app.js";
import { env } from "./config.js";

const app = createApp({ maxFileSizeBytes: env.REPORT_MAX_SIZE_BYTES });

app.listen(env.PORT, () => {
  console.log(`AutoDiag IA API disponible en http://localhost:${env.PORT}`);
});
