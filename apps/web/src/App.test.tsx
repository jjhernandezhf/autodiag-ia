// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";

function createPdf(name: string) {
  return new File(["%PDF-1.7\n%%EOF"], name, { type: "application/pdf" });
}

function createJsonResponse(ok: boolean, body: unknown) {
  return {
    ok,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });

  return { promise, resolve };
}

function getUploadElements(container: HTMLElement) {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  const dropZone = container.querySelector<HTMLElement>(".drop-zone");
  const form = container.querySelector<HTMLFormElement>("form");

  if (!input || !dropZone || !form) throw new Error("No se encontraron los controles de carga.");
  return { input, dropZone, form };
}

function successfulUpload(file: File) {
  return createJsonResponse(true, {
    id: "4e1a912c-4018-47cb-a37a-3f7f6c3bf0ac",
    originalName: file.name,
    size: file.size,
    hash: "a".repeat(64),
    type: "application/pdf",
    status: "received",
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("carga de reportes", () => {
  it("ignora un drop durante una carga activa y realiza una sola solicitud", async () => {
    const firstFile = createPdf("reporte-a.pdf");
    const secondFile = createPdf("reporte-b.pdf");
    const pendingResponse = createDeferred<Response>();
    const fetchMock = vi.fn<typeof fetch>().mockReturnValue(pendingResponse.promise);
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const { container } = render(<App />);
    const { input, dropZone, form } = getUploadElements(container);

    await user.upload(input, firstFile);
    await user.click(screen.getByRole("button", { name: "Enviar reporte" }));
    fireEvent.drop(dropZone, { dataTransfer: { files: [secondFile] } });
    fireEvent.submit(form);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText(firstFile.name)).toBeTruthy();
    expect(screen.queryByText(secondFile.name)).toBeNull();

    await act(async () => {
      pendingResponse.resolve(successfulUpload(firstFile));
      await pendingResponse.promise;
    });
    expect(await screen.findByText("Reporte recibido correctamente.")).toBeTruthy();
  });

  it("mantiene el archivo seleccionado y deshabilita los controles durante el envío", async () => {
    const firstFile = createPdf("reporte-original.pdf");
    const replacementFile = createPdf("reporte-reemplazo.pdf");
    const pendingResponse = createDeferred<Response>();
    const fetchMock = vi.fn<typeof fetch>().mockReturnValue(pendingResponse.promise);
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const { container } = render(<App />);
    const { input } = getUploadElements(container);

    await user.upload(input, firstFile);
    await user.click(screen.getByRole("button", { name: "Enviar reporte" }));

    expect(input.disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Eliminar archivo seleccionado" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(input, { target: { files: [replacementFile] } });

    expect(screen.getByText(firstFile.name)).toBeTruthy();
    expect(screen.queryByText(replacementFile.name)).toBeNull();

    await act(async () => {
      pendingResponse.resolve(successfulUpload(firstFile));
      await pendingResponse.promise;
    });
  });

  it("limpia el selector después de un drop y permite volver al archivo anterior", async () => {
    const firstFile = createPdf("reporte-a.pdf");
    const secondFile = createPdf("reporte-b.pdf");
    const user = userEvent.setup();
    const { container } = render(<App />);
    const { input, dropZone } = getUploadElements(container);

    await user.upload(input, firstFile);
    Object.defineProperty(input, "value", {
      configurable: true,
      value: "C:\\fakepath\\reporte-a.pdf",
      writable: true,
    });
    expect(input.value).not.toBe("");

    fireEvent.drop(dropZone, { dataTransfer: { files: [secondFile] } });

    expect(input.value).toBe("");
    expect(screen.getByText(secondFile.name)).toBeTruthy();

    await user.upload(input, firstFile);

    expect(screen.getByText(firstFile.name)).toBeTruthy();
    expect(screen.queryByText(secondFile.name)).toBeNull();
  });

  it("no rechaza por tamaño y muestra el error devuelto por el backend", async () => {
    const largeFile = createPdf("reporte-grande.pdf");
    Object.defineProperty(largeFile, "size", { value: 25 * 1024 * 1024 });
    const backendMessage = "El archivo excede el límite permitido de 10485760 bytes.";
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      createJsonResponse(false, {
        error: { code: "FILE_TOO_LARGE", message: backendMessage },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const { container } = render(<App />);
    const { input } = getUploadElements(container);

    await user.upload(input, largeFile);

    expect(screen.getByText(largeFile.name)).toBeTruthy();
    expect(screen.queryByText(/supera el límite de 10 MiB/i)).toBeNull();

    await user.click(screen.getByRole("button", { name: "Enviar reporte" }));

    expect(await screen.findByText(backendMessage)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
