import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { expect, it, vi } from "vitest";
import { extractPdfPages, stopPdfExtraction } from "./pdf-extractor.js";

it("shutdown mata ambos hijos, espera cierre físico y no admite otra extracción", async () => {
  vi.useFakeTimers();
  class Child extends EventEmitter {
    stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough();
    kill = vi.fn(() => true);
  }
  const first = new Child(), second = new Child();
  const extract = (child: Child) => extractPdfPages(Buffer.from("%PDF-synthetic"), {}, {
    processFactory: () => child as unknown as ChildProcessWithoutNullStreams,
  });
  const checks = [expect(extract(first)).rejects.toMatchObject({ code: "PDF_EXTRACTION_ERROR" }),
    expect(extract(second)).rejects.toMatchObject({ code: "PDF_EXTRACTION_ERROR" })];
  let stopped = false;
  first.kill.mockImplementationOnce(() => { throw new Error("synthetic launch race"); });
  const shutdown = stopPdfExtraction().then(() => { stopped = true; });
  expect(first.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
  expect(second.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
  const factory = vi.fn();
  await expect(extractPdfPages(Buffer.from("%PDF-synthetic"), {}, { processFactory: factory }))
    .rejects.toMatchObject({ code: "PDF_EXTRACTION_LIMIT_EXCEEDED" });
  expect(factory).not.toHaveBeenCalled();
  expect(stopped).toBe(false);
  first.emit("close", 1, null);
  await Promise.resolve();
  expect(stopped).toBe(false);
  second.emit("close", null, "SIGKILL");
  await Promise.all([...checks, shutdown]);
  expect(stopped).toBe(true);
  expect(first.stdout.destroyed && second.stdout.destroyed).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  await expect(stopPdfExtraction()).resolves.toBeUndefined();
  vi.useRealTimers();
});
