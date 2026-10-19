// Run after the API build. No dotenv, SDK credentials or external services.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import process from "node:process";
import { test } from "node:test";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath, URL } from "node:url";
import request from "supertest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { createApp } from "../dist/app.js";
import { AuthenticationError } from "../dist/auth-service.js";
import { extractPdfPages } from "../dist/pdf-extractor.js";

const secret = "compiled-check-synthetic-secret-at-least-32-bytes";
const identity = { id: "6a103df0-8e4d-4c51-89f5-7030c5443d89", username: "synthetic.user" };
const authenticationService = {
  login: async () => { throw new Error("Login provider must not be called"); },
  authenticate: async (token) => {
    if (token !== "synthetic-token") throw new AuthenticationError("AUTH_SESSION_INVALID", "Sesión no válida.", 401);
    return identity;
  },
};

async function pdf(lines = []) {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage([600, 800]);
  for (const [text, x, y] of lines) page.drawText(text, { font, size: 11, x, y });
  return Buffer.from(await document.save());
}

test("compiled child contains abrupt exit; next real Autel upload succeeds", { timeout: 20000 }, async () => {
  let calls = 0;
  const app = createApp({ vinHmacSecret: secret, authenticationService,
    extractPdfPages: (buffer) => extractPdfPages(buffer, {}, ++calls === 1 ? {
      processFactory: (exe, args, options) => spawn(exe,
        [...args.slice(0, 2), "--input-type=module", "-e", "process.stdin.resume(); process.exit(23);"], options),
    } : {}),
  });
  const bytes = await pdf([
    ["Informe de diagnostico de vehiculo", 30, 760],
    ["Informacion del vehiculo", 30, 735],
    ["2025 / Marca Sintetica / Modelo Sintetico", 30, 710],
    ["Sistema/s escaneado/s (1)", 30, 660],
    ["Sistema", 30, 635], ["Estado/DTC", 470, 635],
    ["PCM(Control Unit)", 30, 610], ["1", 500, 610],
    ["DTC (1)", 30, 570], ["PCM(Control Unit) (1 DTC)", 30, 545],
    ["DTC", 30, 520], ["Descripcion", 150, 520], ["Estado", 490, 520],
    ["P0300", 30, 495], ["Descripcion sintetica", 150, 495], ["Corriente", 490, 495],
  ]);
  const upload = () => request(app).post("/api/reports/upload")
    .set("Authorization", "Bearer synthetic-token")
    .attach("report", bytes, { filename: "synthetic.pdf", contentType: "application/pdf" });
  const failed = await upload();
  assert.equal(failed.status, 500);
  assert.equal(failed.body.error.code, "PDF_EXTRACTION_ERROR");
  assert.deepEqual((await request(app).get("/api/health")).body, { status: "ok" });
  const next = await upload();
  assert.equal(next.status, 201);
  assert.equal(next.body.extraction.status, "completed");
  assert.equal(next.body.extraction.dtcs[0].code, "P0300");
  assert.equal(calls, 2);
});

test("compiled child returns bounded public errors for blank and broken PDF", { timeout: 20000 }, async () => {
  await assert.rejects(extractPdfPages(await pdf()), { code: "PDF_NO_USABLE_TEXT" });
  await assert.rejects(extractPdfPages(Buffer.from("%PDF-1.7\nbroken")), { code: "PDF_UNREADABLE" });
});

test("compiled HTTP keeps authentication and fails closed without provider configuration", async () => {
  const app = createApp({ vinHmacSecret: secret, authenticationService });
  assert.equal((await request(app).post("/api/reports/upload")).status, 401);
  assert.equal((await request(app).get("/api/history")).status, 401);
  assert.equal((await request(app).get("/api/history").set("Authorization", "Bearer invalid")).status, 401);
  const missingHistory = await request(app).get("/api/history").set("Authorization", "Bearer synthetic-token");
  assert.equal(missingHistory.status, 503);
  assert.equal(missingHistory.body.error.code, "HISTORY_UNAVAILABLE");
});

test("actual compiled entry starts with synthetic environment and closes its owned process", { timeout: 20000 }, async () => {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
  const env = { VIN_HMAC_SECRET: secret, PORT: String(port), NODE_ENV: "production" };
  for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const child = spawn(process.execPath, [fileURLToPath(new URL("../dist/index.js", import.meta.url))],
    { env, cwd: tmpdir(), shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const closed = once(child, "close");
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 15000);
  child.stderr.resume();
  try {
    await Promise.race([
      new Promise((resolve) => child.stdout.on("data", (chunk) => {
        if (chunk.toString().includes("API disponible")) resolve();
      })),
      closed.then(() => { throw new Error("Compiled API exited before readiness"); }),
    ]);
    const response = await globalThis.fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
    assert.equal(response.headers.get("cache-control"), "no-store");
    const origin = `http://127.0.0.1:${port}`;
    const home = await globalThis.fetch(origin);
    assert.equal(home.status, 200);
    const html = await home.text();
    assert.match(html, /<html/u);
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)/gu)].map(match => match[1]);
    assert.ok(assets.length >= 2);
    for (const asset of assets) assert.equal((await globalThis.fetch(origin + asset)).status, 200);
    // Node fetch adds Sec-Fetch-Mode: cors; use an actual navigation-shaped request.
    assert.equal((await request(origin).get("/history").set("Accept", "text/html").set("Sec-Fetch-Mode", "navigate")).status, 200);
    for (const path of ["/api/missing", "/assets/missing.js", "/.env", "/apps/api/src/index.ts", "/node_modules"]) {
      const missing = await globalThis.fetch(origin + path, { headers: { Accept: "text/html" } });
      assert.equal(missing.status, 404);
      assert.match(missing.headers.get("content-type"), /application\/json/u);
    }
    assert.equal((await globalThis.fetch(origin + "/api/history")).status, 401);
    const login = await globalThis.fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nombre_usuario: "synthetic.user", password: "synthetic-password" }),
    });
    assert.equal(login.status, 503);
    assert.equal((await login.json()).error.code, "AUTH_CONFIGURATION_UNAVAILABLE");
  } finally {
    try {
      child.kill();
      await closed;
    } finally {
      clearTimeout(watchdog);
    }
  }
  assert.notEqual(child.pid, undefined);
  assert.notEqual(child.exitCode === null && child.signalCode === null, true);
});

test("compiled shutdown signal waits for a real extractor process before exiting", { timeout: 20000 }, async () => {
  // Emit SIGTERM inside the owned process: Windows kill() would bypass JS signal handlers.
  const source = `
    import { spawn } from 'node:child_process';
    import { extractPdfPages } from ${JSON.stringify(new URL("../dist/pdf-extractor.js", import.meta.url).href)};
    await import(${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)});
    const extraction = extractPdfPages(Buffer.from('%PDF-synthetic'), {}, { processFactory(exe, args, options) {
      const child = spawn(exe, [...args.slice(0, 2), '--input-type=module', '-e',
        "process.on('disconnect', () => process.exit(1)); process.stdin.resume(); setInterval(() => {}, 1000);"],
        { ...options, stdio: ['pipe','pipe','pipe','ipc'] });
      child.once('spawn', () => process.emit('SIGTERM'));
      return child;
    }});
    extraction.catch(error => { if (error.code === 'PDF_EXTRACTION_ERROR') console.log('extractor-closed'); });
  `;
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  const env = { VIN_HMAC_SECRET: secret, PORT: String(port), NODE_ENV: "production" };
  for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    env, cwd: tmpdir(), shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = once(child, "close");
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 15000);
  let output = "";
  child.stdout.on("data", chunk => { output += chunk.toString(); });
  child.stderr.resume();
  try {
    const [code, signal] = await closed;
    assert.equal(code, 0);
    assert.equal(signal, null);
    assert.match(output, /extractor-closed/u);
  } finally {
    try { child.kill(); await closed; } finally { clearTimeout(watchdog); }
  }
});
