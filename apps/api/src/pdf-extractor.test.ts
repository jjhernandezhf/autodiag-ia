import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PDFDocument } from "pdf-lib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PDF_EXTRACTION_LIMITS } from "./config.js";
import { extractPdfPages, type PdfProcessFactory } from "./pdf-extractor.js";
import { parsePdfProcessResponse, requestHeaderSchema } from "./pdf-process-protocol.js";

const input = Buffer.from("%PDF-synthetic");
const pages = [{ pageNumber: 1, lines: [{ text: "Fixture", y: 1, fragments: [{ text: "Fixture", x: 1, width: 1 }] }] }];
class ControlledProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => true);
  close(code = 0, signal: NodeJS.Signals | null = null) { this.emit("close", code, signal); }
  asChild() { return this as unknown as ChildProcessWithoutNullStreams; }
}
function controlled(child: ControlledProcess, signal?: AbortSignal) {
  return { processFactory: () => child.asChild(), signal };
}
function syntheticFactory(source: string, observe: (child: ChildProcessWithoutNullStreams) => void = () => undefined): PdfProcessFactory {
  return (exe, args, options) => {
    const child = spawn(exe, [...args.slice(0, 2), "--input-type=module", "-e", source], options);
    observe(child);
    return child;
  };
}
describe("aislamiento PDF por proceso hijo", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("conserva capacidad y espera cierre físico tras timeout; descarta respuesta tardía", async () => {
    vi.useFakeTimers();
    const first = new ControlledProcess(), second = new ControlledProcess();
    const a = extractPdfPages(input, { timeoutMs: 100 }, controlled(first));
    const b = extractPdfPages(input, { timeoutMs: 100 }, controlled(second));
    let settled = false;
    const checks = Promise.all([
      expect(a).rejects.toMatchObject({ code: "PDF_EXTRACTION_TIMEOUT" }),
      expect(b).rejects.toMatchObject({ code: "PDF_EXTRACTION_TIMEOUT" }),
    ]).then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(100);
    expect(first.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    expect(settled).toBe(false);
    const spawnThird = vi.fn();
    await expect(extractPdfPages(input, {}, { processFactory: spawnThird })).rejects.toMatchObject({ code: "PDF_EXTRACTION_LIMIT_EXCEEDED" });
    expect(spawnThird).not.toHaveBeenCalled();
    first.stdout.write(JSON.stringify({ ok: true, pages }));
    first.close(1); second.close(1);
    await checks;
    expect(vi.getTimerCount()).toBe(0);
    expect(first.listenerCount("message")).toBe(0);
    expect(first.listenerCount("error")).toBe(0);
    expect(first.stdin.destroyed && first.stdout.destroyed && first.stderr.destroyed).toBe(true);
    const next = new ControlledProcess();
    const extraction = extractPdfPages(input, {}, controlled(next));
    next.stdout.end(JSON.stringify({ ok: true, pages })); next.close();
    await expect(extraction).resolves.toEqual(pages);
  });

  it("cancela una extracción sin liberar antes del cierre y quita el listener", async () => {
    const child = new ControlledProcess(), abort = new AbortController();
    const remove = vi.spyOn(abort.signal, "removeEventListener");
    const extraction = extractPdfPages(input, {}, controlled(child, abort.signal));
    const rejection = expect(extraction).rejects.toMatchObject({ code: "PDF_EXTRACTION_ERROR" });
    abort.abort();
    expect(child.kill).toHaveBeenCalledOnce();
    child.close(1); await rejection;
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    const factory = vi.fn();
    await expect(extractPdfPages(input, {}, { signal: abort.signal, processFactory: factory })).rejects.toMatchObject({ code: "PDF_EXTRACTION_ERROR" });
    expect(factory).not.toHaveBeenCalled();
  });

  it.each(["error", "input-error"])("sanea %s y espera close", async (event) => {
    const child = new ControlledProcess();
    const extraction = extractPdfPages(input, {}, controlled(child));
    const rejection = expect(extraction).rejects.toMatchObject({ code: "PDF_EXTRACTION_ERROR" });
    if (event === "input-error") child.stdin.emit("error", Error("SYNTHETIC_PRIVATE"));
    else child.emit(event, Error("SYNTHETIC_PRIVATE"));
    expect(child.kill).toHaveBeenCalledOnce();
    child.close(1); await rejection;
  });

  it("sanea lanzamiento síncrono fallido y permite otra extracción", async () => {
    await expect(extractPdfPages(input, {}, { processFactory: () => { throw Error("SYNTHETIC_PRIVATE"); } })).rejects.toMatchObject({ code: "PDF_EXTRACTION_ERROR" });
    const child = new ControlledProcess();
    const next = extractPdfPages(input, {}, controlled(child));
    child.stdout.end(JSON.stringify({ ok: true, pages })); child.close();
    await expect(next).resolves.toEqual(pages);
  });

  it("maneja fallo real de lanzamiento sin rechazo no observado", async () => {
    await expect(extractPdfPages(input, {}, { processFactory: (_exe, args, options) => spawn("nonexistent-synthetic-autodiag-executable", args, options) }))
      .rejects.toMatchObject({ code: "PDF_EXTRACTION_ERROR" });
  });

  it.each([
    "not-json", JSON.stringify({ ok: false, code: "INTERNAL_PRIVATE" }),
    JSON.stringify({ ok: true, pages, extra: true }), JSON.stringify({ ok: true, pages: [] }),
    JSON.stringify({ ok: true, pages: [{ ...pages[0], pageNumber: 99 }] }),
    JSON.stringify({ ok: true, pages }) + JSON.stringify({ ok: true, pages }),
  ])("rechaza IPC inválido o duplicado: %s", async (message) => {
    const child = new ControlledProcess();
    const extraction = extractPdfPages(input, {}, controlled(child));
    const rejection = expect(extraction).rejects.toMatchObject({ code: "PDF_EXTRACTION_ERROR" });
    child.stdout.end(message); child.close(); await rejection;
  });

  it("limita bytes de salida antes de acumular o parsear", async () => {
    const child = new ControlledProcess();
    const extraction = extractPdfPages(input, { maxTextItems: 1, maxCharacters: 1, maxPages: 1 }, controlled(child));
    const rejection = expect(extraction).rejects.toMatchObject({ code: "PDF_EXTRACTION_LIMIT_EXCEEDED" });
    child.stdout.write(Buffer.alloc(2048)); expect(child.kill).toHaveBeenCalledOnce();
    child.close(1); await rejection;
  });

  it("rechaza archivo excedido antes de crear un proceso", async () => {
    const factory = vi.fn();
    await expect(extractPdfPages(input, {}, { maxFileSizeBytes: 1, processFactory: factory }))
      .rejects.toMatchObject({ code: "PDF_EXTRACTION_LIMIT_EXCEEDED" });
    expect(factory).not.toHaveBeenCalled();
  });

  it("no publica un resultado si el hijo sale con error después de escribirlo", async () => {
    const child = new ControlledProcess();
    const extraction = extractPdfPages(input, {}, controlled(child));
    const rejection = expect(extraction).rejects.toMatchObject({ code: "PDF_EXTRACTION_ERROR" });
    child.stdout.end(JSON.stringify({ ok: true, pages })); child.close(23);
    await rejection;
  });

  it.each(["unexpected", "duplicate"])("rechaza supervisión IPC %s sin liberar capacidad antes de close", async (kind) => {
    const child = new ControlledProcess();
    const extraction = extractPdfPages(input, {}, controlled(child));
    const rejection = expect(extraction).rejects.toMatchObject({ code: "PDF_EXTRACTION_ERROR" });
    if (kind === "duplicate") child.emit("message", "processing");
    child.emit("message", kind === "duplicate" ? "processing" : { secret: "synthetic" });
    expect(child.kill).toHaveBeenCalledOnce();
    child.close(1); await rejection;
    expect(child.listenerCount("message")).toBe(0);
  });

  it("conserva clasificación timeout cuando vence el watchdog propio del hijo", async () => {
    const child = new ControlledProcess();
    const extraction = extractPdfPages(input, {}, controlled(child));
    const rejection = expect(extraction).rejects.toMatchObject({ code: "PDF_EXTRACTION_TIMEOUT" });
    child.close(124); await rejection;
  });

  it("el hijo real termina al desconectar supervisión después de entregar el PDF", async () => {
    const doc = await PDFDocument.create(); doc.addPage();
    let child: ChildProcessWithoutNullStreams | undefined;
    let processing = false;
    await expect(extractPdfPages(Buffer.from(await doc.save()), {}, { processFactory: (exe, args, options) => {
      child = spawn(exe, args, { ...options, stdio: ["pipe", "pipe", "pipe", "ipc"] }) as ChildProcessWithoutNullStreams;
      child.once("message", (message) => { processing = message === "processing"; child!.disconnect(); });
      return child;
    } })).rejects.toMatchObject({ code: "PDF_EXTRACTION_ERROR" });
    expect(processing).toBe(true);
    // The controller can kill first when its start acknowledgement sees closed IPC.
    expect(child?.signalCode === "SIGKILL" || child?.exitCode === 1).toBe(true);
    expect(child?.stdout.destroyed && child?.stderr.destroyed).toBe(true);
  });

  it("el watchdog real termina con entrada pendiente aunque no haya temporizador en el padre", async () => {
    const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
    const child = spawn(process.execPath, ["--import", loader, fileURLToPath(new URL("./pdf-extractor-child.mts", import.meta.url))],
      { env: { SystemRoot: process.env.SystemRoot }, stdio: ["pipe", "pipe", "pipe", "ipc"] });
    child.stdout!.resume(); child.stderr!.resume();
    child.stdin!.on("error", () => undefined);
    const closed = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    const start = Date.now();
    child.stdin!.write(JSON.stringify({ size: 100, deadlineAtMs: start + 1500,
      limits: { ...DEFAULT_PDF_EXTRACTION_LIMITS, timeoutMs: 1500 } }) + "\n");
    // Keep stdin and IPC open deliberately. Only the child's own deadline applies.
    try { expect(await closed).toBe(124); expect(Date.now() - start).toBeLessThan(4000); }
    finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
  });

  it("no libera ni acepta éxito al cerrar un canal mientras el proceso continúa vivo", async () => {
    vi.useFakeTimers();
    const child = new ControlledProcess();
    const extraction = extractPdfPages(input, { timeoutMs: 100 }, controlled(child));
    let settled = false;
    const rejection = expect(extraction).rejects.toMatchObject({ code: "PDF_EXTRACTION_TIMEOUT" })
      .then(() => { settled = true; });
    child.stdout.end(JSON.stringify({ ok: true, pages }));
    await vi.advanceTimersByTimeAsync(100);
    expect(child.kill).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    child.close(1); await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("valida presupuestos semánticos y cabecera estricta", () => {
    const realShape = [{ ...pages[0]!, lines: [{ ...pages[0]!.lines[0]!, fragments: [{ text: "Fixture", x: 1, y: 2, width: 1 }] }] }];
    expect(parsePdfProcessResponse({ ok: true, pages: realShape }, DEFAULT_PDF_EXTRACTION_LIMITS)).toEqual({ ok: true, pages: realShape });
    expect(() => parsePdfProcessResponse({ ok: true, pages }, { ...DEFAULT_PDF_EXTRACTION_LIMITS, maxCharacters: 1 })).toThrow();
    const header = { size: 1, deadlineAtMs: Date.now() + 1000, limits: DEFAULT_PDF_EXTRACTION_LIMITS };
    expect(requestHeaderSchema.parse(header)).toEqual(header);
    expect(() => requestHeaderSchema.parse({ ...header, key: "synthetic" })).toThrow();
    expect(() => requestHeaderSchema.parse({ ...header, limits: { ...DEFAULT_PDF_EXTRACTION_LIMITS, key: "synthetic" } })).toThrow();
  });

  it("no hereda secretos ni flags de la API; conserva heap y stack explícitos", async () => {
    const child = new ControlledProcess();
    let captured: { args: string[]; options: SpawnOptionsWithoutStdio } | undefined;
    vi.stubEnv("OPENAI_API_KEY", "synthetic-never-inherited");
    vi.stubEnv("SUPABASE_SECRET_KEY", "synthetic-never-inherited");
    try {
      const extraction = extractPdfPages(input, {}, { processFactory: (_exe, args, options) => {
        captured = { args, options }; return child.asChild();
      } });
      child.stdout.end(JSON.stringify({ ok: true, pages })); child.close(); await extraction;
      expect(captured!.args.slice(0, 2)).toEqual(["--max-old-space-size=192", "--stack-size=4096"]);
      expect(captured!.args).not.toContain("--env-file");
      expect(captured!.options).toMatchObject({ shell: false, windowsHide: true });
      expect(Object.keys(captured!.options.env!).every(key => ["SystemRoot", "WINDIR", "TEMP", "TMP"].includes(key))).toBe(true);
      expect(captured!.options.env).not.toHaveProperty("OPENAI_API_KEY");
      expect(captured!.options.env).not.toHaveProperty("SUPABASE_SECRET_KEY");
    } finally { vi.unstubAllEnvs(); }
  });

  it("contiene salida abrupta real sin exponer stderr", async () => {
    let child: ChildProcessWithoutNullStreams | undefined;
    await expect(extractPdfPages(input, {}, { processFactory: syntheticFactory(
      'process.stdin.resume(); process.stderr.write("SYNTHETIC_PRIVATE"); process.exit(23);', value => { child = value; }),
    })).rejects.toMatchObject({ code: "PDF_EXTRACTION_ERROR" });
    expect(child?.exitCode).toBe(23);
    expect(child?.stdout.destroyed && child?.stderr.destroyed).toBe(true);
  });

  it("mata un hijo real bloqueado y cierra sus streams", async () => {
    let child: ChildProcessWithoutNullStreams | undefined;
    await expect(extractPdfPages(input, { timeoutMs: 100 }, { processFactory: syntheticFactory(
      "process.stdin.resume(); setInterval(() => {}, 1000);", value => { child = value; }),
    })).rejects.toMatchObject({ code: "PDF_EXTRACTION_TIMEOUT" });
    expect(child?.exitCode !== null || child?.signalCode !== null).toBe(true);
    expect(child?.stdin.destroyed && child?.stdout.destroyed && child?.stderr.destroyed).toBe(true);
  });

  it("cancela un hijo real y espera la terminación sin filtrar rechazos", async () => {
    const abort = new AbortController();
    let child: ChildProcessWithoutNullStreams | undefined;
    const extraction = extractPdfPages(input, {}, {
      signal: abort.signal,
      processFactory: syntheticFactory("process.stdin.resume(); setInterval(() => {}, 1000);", value => {
        child = value; value.once("spawn", () => abort.abort());
      }),
    });
    await expect(extraction).rejects.toMatchObject({ code: "PDF_EXTRACTION_ERROR" });
    expect(child?.exitCode !== null || child?.signalCode !== null).toBe(true);
    expect(child?.stdin.destroyed && child?.stdout.destroyed && child?.stderr.destroyed).toBe(true);
  });
});
