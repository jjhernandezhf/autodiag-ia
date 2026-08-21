import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { Worker, type WorkerOptions } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_PDF_EXTRACTION_LIMITS } from "./config.js";
import { extractPdfPages } from "./pdf-extractor.js";

class ControlledWorker extends EventEmitter {
  workCount = 0;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdoutResume = vi.spyOn(this.stdout, "resume");
  readonly stderrResume = vi.spyOn(this.stderr, "resume");
  private readonly workTimer = setInterval(() => {
    this.workCount += 1;
  }, 1);

  readonly terminate = vi.fn(async () => {
    clearInterval(this.workTimer);
    this.stdout.destroy();
    this.stderr.destroy();
    return 1;
  });
}

function syntheticWorkerUrl(source: string) {
  return new URL(`data:text/javascript,${encodeURIComponent(source)}`);
}

function streamsAreReleased(worker: Worker) {
  return Boolean(
    worker.stdout && worker.stderr &&
      (worker.stdout.destroyed || worker.stdout.closed) &&
      (worker.stderr.destroyed || worker.stderr.closed),
  );
}

describe("controlador del Worker PDF", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("termina realmente el Worker al vencer el plazo y no permite trabajo posterior", async () => {
    vi.useFakeTimers();
    const worker = new ControlledWorker();
    let workerOptions: WorkerOptions | undefined;
    const extraction = extractPdfPages(
      Buffer.from("%PDF-sintetico"),
      { ...DEFAULT_PDF_EXTRACTION_LIMITS, timeoutMs: 100 },
      {
        workerFactory: (_url, options) => {
          workerOptions = options;
          return worker as unknown as Worker;
        },
      },
    );
    const rejection = expect(extraction).rejects.toMatchObject({ code: "PDF_EXTRACTION_TIMEOUT" });

    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    expect(workerOptions).toMatchObject({ stdout: true, stderr: true });
    expect(worker.stdoutResume).toHaveBeenCalledOnce();
    expect(worker.stderrResume).toHaveBeenCalledOnce();
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(worker.stdout.destroyed).toBe(true);
    expect(worker.stderr.destroyed).toBe(true);
    const countAfterTermination = worker.workCount;

    await vi.advanceTimersByTimeAsync(100);
    expect(worker.workCount).toBe(countAfterTermination);
  });

  it("descarta stdout y stderr sensibles sin afectar el mensaje estructurado", async () => {
    const marker = "SYNTHETIC_PRIVATE_WORKER_OUTPUT";
    const source = `
      import { parentPort } from "node:worker_threads";
      console.warn(${JSON.stringify(marker)});
      process.stdout.write(${JSON.stringify(marker)});
      process.stderr.write(${JSON.stringify(marker)});
      parentPort.postMessage({ ok: true, pages: [] });
    `;
    let worker: Worker | undefined;
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const consoleSpies = ["log", "info", "warn", "error"].map((method) =>
      vi.spyOn(console, method as "log").mockImplementation(() => undefined),
    );

    try {
      const pages = await extractPdfPages(Buffer.from("%PDF-synthetic"), {}, {
        workerUrl: syntheticWorkerUrl(source),
        workerExecArgv: [],
        workerFactory: (url, options) => {
          worker = new Worker(url, options);
          return worker;
        },
      });

      expect(pages).toEqual([]);
      const observedOutput = JSON.stringify([
        stdoutSpy.mock.calls,
        stderrSpy.mock.calls,
        ...consoleSpies.map((spy) => spy.mock.calls),
      ]);
      expect(observedOutput).not.toContain(marker);
      expect(worker && streamsAreReleased(worker)).toBe(true);
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
      for (const spy of consoleSpies) spy.mockRestore();
    }
  });

  it("sanitiza un error real del Worker y libera sus streams", async () => {
    const marker = "SYNTHETIC_INTERNAL_WORKER_ERROR";
    const source = `
      process.stdout.write(${JSON.stringify(marker)});
      process.stderr.write(${JSON.stringify(marker)});
      throw new Error(${JSON.stringify(marker)});
    `;
    let worker: Worker | undefined;
    let caught: unknown;

    try {
      await extractPdfPages(Buffer.from("%PDF-synthetic"), {}, {
        workerUrl: syntheticWorkerUrl(source),
        workerExecArgv: [],
        workerFactory: (url, options) => {
          worker = new Worker(url, options);
          return worker;
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ code: "PDF_EXTRACTION_ERROR" });
    expect(JSON.stringify(caught)).not.toContain(marker);
    expect(worker && streamsAreReleased(worker)).toBe(true);
  });

  it("cierra los streams al terminar un Worker real por timeout", async () => {
    const source = "setInterval(() => undefined, 1);";
    let worker: Worker | undefined;

    await expect(
      extractPdfPages(Buffer.from("%PDF-synthetic"), { timeoutMs: 100 }, {
        workerUrl: syntheticWorkerUrl(source),
        workerExecArgv: [],
        workerFactory: (url, options) => {
          worker = new Worker(url, options);
          return worker;
        },
      }),
    ).rejects.toMatchObject({ code: "PDF_EXTRACTION_TIMEOUT" });

    expect(worker && streamsAreReleased(worker)).toBe(true);
  });
});
