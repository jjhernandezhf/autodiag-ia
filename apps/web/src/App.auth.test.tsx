// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import type { BrowserApiClient } from "./api-client";
import {
  BrowserAuthenticationError,
  type AuthIdentity,
  type BrowserAuthenticationService,
  type SupportedAuthEvent,
} from "./auth-service";

const FIRST_USER: AuthIdentity = {
  id: "6a103df0-8e4d-4c51-89f5-7030c5443d89",
  username: "usuario.primero",
};
const SECOND_USER: AuthIdentity = {
  id: "c5fc96fa-6795-4e24-a76b-43d05cc81384",
  username: "usuario.segundo",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function createService(initialIdentity: AuthIdentity | null = FIRST_USER) {
  let listener: ((event: SupportedAuthEvent, userId?: string | null) => void) | undefined;
  const unsubscribe = vi.fn();
  const service = {
    initialize: vi.fn(async () => initialIdentity),
    login: vi.fn(async () => FIRST_USER),
    validateCurrentSession: vi.fn(async () => initialIdentity),
    authenticatedFetch: vi.fn(async () => { throw new Error("Solicitud protegida inesperada"); }),
    subscribe: vi.fn((nextListener: (event: SupportedAuthEvent, userId?: string | null) => void) => {
      listener = nextListener;
      return unsubscribe;
    }),
    signOutLocal: vi.fn(async () => undefined),
  } as BrowserAuthenticationService;
  return {
    service,
    unsubscribe,
    emit(event: SupportedAuthEvent, userId: string | null = event === "SIGNED_OUT" ? null : initialIdentity?.id ?? null) {
      listener?.(event, userId);
    },
  };
}

function createPdf(name = "reporte-sintetico.pdf") {
  return new File(["%PDF-1.7\n%%EOF"], name, { type: "application/pdf" });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("sesión de la aplicación", () => {
  it("no muestra AutoDiag antes de validar y sin sesión presenta el login", async () => {
    const initialization = deferred<AuthIdentity | null>();
    const auth = createService();
    vi.mocked(auth.service.initialize).mockReturnValue(initialization.promise);

    render(<App authService={auth.service} />);

    expect(screen.getByText("Verificando sesión segura…")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Carga tu reporte Autel" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Iniciar sesión" })).toBeNull();

    await act(async () => initialization.resolve(null));
    expect(await screen.findByRole("button", { name: "Iniciar sesión" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Carga tu reporte Autel" })).toBeNull();
  });

  it("restaura una sesión válida y muestra exclusivamente la identidad mínima", async () => {
    const auth = createService(FIRST_USER);
    render(<App authService={auth.service} />);

    expect(await screen.findByRole("heading", { name: "Carga tu reporte Autel" })).toBeTruthy();
    expect(screen.getByText(FIRST_USER.username)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cerrar sesión" })).toBeTruthy();
    expect(auth.service.initialize).toHaveBeenCalledOnce();
  });

  it("una sesión inicial inválida se limpia y vuelve al login", async () => {
    const auth = createService();
    vi.mocked(auth.service.initialize).mockRejectedValue(new BrowserAuthenticationError(
      "AUTH_SESSION_INVALID",
      "Tu sesión ya no es válida. Inicia sesión nuevamente.",
    ));

    render(<App authService={auth.service} />);

    expect(await screen.findByText("Tu sesión ya no es válida. Inicia sesión nuevamente.")).toBeTruthy();
    expect(auth.service.signOutLocal).toHaveBeenCalledOnce();
    expect(screen.queryByRole("heading", { name: "Carga tu reporte Autel" })).toBeNull();
  });

  it("se suscribe una vez y libera la suscripción al desmontar", async () => {
    const auth = createService();
    const { unmount } = render(<App authService={auth.service} />);
    await screen.findByRole("heading", { name: "Carga tu reporte Autel" });

    expect(auth.service.subscribe).toHaveBeenCalledOnce();
    unmount();
    expect(auth.unsubscribe).toHaveBeenCalledOnce();
  });

  it("TOKEN_REFRESHED del mismo UUID conserva el reporte seleccionado", async () => {
    const auth = createService();
    const user = userEvent.setup();
    const { container } = render(<App authService={auth.service} />);
    await screen.findByRole("heading", { name: "Carga tu reporte Autel" });
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    await user.upload(input, createPdf());
    expect(screen.getByText("reporte-sintetico.pdf")).toBeTruthy();

    await act(async () => auth.emit("TOKEN_REFRESHED"));
    await waitFor(() => expect(auth.service.validateCurrentSession).toHaveBeenCalledOnce());

    expect(screen.getByText("reporte-sintetico.pdf")).toBeTruthy();
  });

  it("una validación que resuelve después de logout no restaura la sesión", async () => {
    const auth = createService();
    const staleValidation = deferred<AuthIdentity | null>();
    vi.mocked(auth.service.validateCurrentSession).mockReturnValueOnce(staleValidation.promise);
    const user = userEvent.setup();
    render(<App authService={auth.service} />);
    await screen.findByRole("heading", { name: "Carga tu reporte Autel" });

    act(() => auth.emit("TOKEN_REFRESHED"));
    await waitFor(() => expect(auth.service.validateCurrentSession).toHaveBeenCalledOnce());
    await user.click(screen.getByRole("button", { name: "Cerrar sesión" }));
    await screen.findByRole("button", { name: "Iniciar sesión" });
    await act(async () => staleValidation.resolve(FIRST_USER));

    expect(screen.getByRole("button", { name: "Iniciar sesión" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Carga tu reporte Autel" })).toBeNull();
  });

  it("un error de validación posterior a logout no modifica el estado actual", async () => {
    const auth = createService();
    const staleValidation = deferred<AuthIdentity | null>();
    vi.mocked(auth.service.validateCurrentSession).mockReturnValueOnce(staleValidation.promise);
    const user = userEvent.setup();
    render(<App authService={auth.service} />);
    await screen.findByRole("heading", { name: "Carga tu reporte Autel" });

    act(() => auth.emit("TOKEN_REFRESHED"));
    await waitFor(() => expect(auth.service.validateCurrentSession).toHaveBeenCalledOnce());
    await user.click(screen.getByRole("button", { name: "Cerrar sesión" }));
    await screen.findByRole("button", { name: "Iniciar sesión" });
    await act(async () => staleValidation.reject(new BrowserAuthenticationError(
      "AUTH_SESSION_INVALID",
      "Tu sesión ya no es válida. Inicia sesión nuevamente.",
    )));

    expect(screen.getByRole("button", { name: "Iniciar sesión" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(auth.service.signOutLocal).toHaveBeenCalledOnce();
  });

  it("una validación antigua no reemplaza un UUID autenticado posteriormente", async () => {
    const auth = createService();
    const staleValidation = deferred<AuthIdentity | null>();
    vi.mocked(auth.service.validateCurrentSession)
      .mockReturnValueOnce(staleValidation.promise)
      .mockResolvedValueOnce(SECOND_USER);
    render(<App authService={auth.service} />);
    await screen.findByText(FIRST_USER.username);

    act(() => auth.emit("TOKEN_REFRESHED"));
    await waitFor(() => expect(auth.service.validateCurrentSession).toHaveBeenCalledTimes(1));
    act(() => auth.emit("SIGNED_IN", SECOND_USER.id));
    await screen.findByText(SECOND_USER.username);
    await act(async () => staleValidation.resolve(FIRST_USER));

    expect(screen.getByText(SECOND_USER.username)).toBeTruthy();
    expect(screen.queryByText(FIRST_USER.username)).toBeNull();
  });

  it("el error de una validación antigua no cierra la sesión nueva", async () => {
    const auth = createService();
    const staleValidation = deferred<AuthIdentity | null>();
    vi.mocked(auth.service.validateCurrentSession)
      .mockReturnValueOnce(staleValidation.promise)
      .mockResolvedValueOnce(SECOND_USER);
    render(<App authService={auth.service} />);
    await screen.findByText(FIRST_USER.username);

    act(() => auth.emit("TOKEN_REFRESHED"));
    await waitFor(() => expect(auth.service.validateCurrentSession).toHaveBeenCalledTimes(1));
    act(() => auth.emit("SIGNED_IN", SECOND_USER.id));
    await screen.findByText(SECOND_USER.username);
    await act(async () => staleValidation.reject(new BrowserAuthenticationError(
      "AUTH_SESSION_INVALID",
      "Tu sesión ya no es válida. Inicia sesión nuevamente.",
    )));

    expect(screen.getByText(SECOND_USER.username)).toBeTruthy();
    expect(auth.service.signOutLocal).not.toHaveBeenCalled();
  });

  it("un cambio de UUID desmonta y limpia toda la información del usuario anterior", async () => {
    const auth = createService();
    const user = userEvent.setup();
    const { container } = render(<App authService={auth.service} />);
    await screen.findByRole("heading", { name: "Carga tu reporte Autel" });
    await user.upload(container.querySelector<HTMLInputElement>('input[type="file"]')!, createPdf());
    vi.mocked(auth.service.validateCurrentSession).mockResolvedValueOnce(SECOND_USER);

    await act(async () => auth.emit("SIGNED_IN", SECOND_USER.id));
    await screen.findByText(SECOND_USER.username);

    expect(screen.queryByText("reporte-sintetico.pdf")).toBeNull();
    expect((container.querySelector('input[type="file"]') as HTMLInputElement).files).toHaveLength(0);
  });

  it("SIGNED_OUT cancela una carga pendiente y elimina el reporte de memoria", async () => {
    const auth = createService();
    const pending = deferred<Response>();
    vi.mocked(auth.service.authenticatedFetch).mockReturnValue(pending.promise);
    const user = userEvent.setup();
    const { container } = render(<App authService={auth.service} />);
    await screen.findByRole("heading", { name: "Carga tu reporte Autel" });
    await user.upload(container.querySelector<HTMLInputElement>('input[type="file"]')!, createPdf());
    fireEvent.submit(container.querySelector("form")!);
    await waitFor(() => expect(auth.service.authenticatedFetch).toHaveBeenCalledOnce());
    const signal = vi.mocked(auth.service.authenticatedFetch).mock.calls[0]?.[1]?.signal as AbortSignal;

    act(() => auth.emit("SIGNED_OUT"));
    await screen.findByRole("button", { name: "Iniciar sesión" });

    expect(signal.aborted).toBe(true);
    expect(screen.queryByText("reporte-sintetico.pdf")).toBeNull();
  });

  it("oculta inmediatamente el workspace anterior mientras valida un SIGNED_IN de otro UUID", async () => {
    const auth = createService();
    const apiClient = {
      requestJson: vi.fn(),
      checkHealth: vi.fn(async () => undefined),
    } as unknown as BrowserApiClient;
    const user = userEvent.setup();
    const { container } = render(<App authService={auth.service} apiClient={apiClient} />);
    await screen.findByText(FIRST_USER.username);
    await user.upload(container.querySelector<HTMLInputElement>('input[type="file"]')!, createPdf("usuario-a.pdf"));
    vi.mocked(auth.service.validateCurrentSession).mockRejectedValueOnce(new BrowserAuthenticationError(
      "AUTH_PROVIDER_UNAVAILABLE",
      "No fue posible iniciar sesión. Intenta nuevamente.",
    ));

    act(() => auth.emit("SIGNED_IN", SECOND_USER.id));

    expect(await screen.findByRole("heading", { name: "Servidor temporalmente no disponible" })).toBeTruthy();
    expect(screen.queryByText(FIRST_USER.username)).toBeNull();
    expect(screen.queryByText("usuario-a.pdf")).toBeNull();
    expect(screen.queryByRole("button", { name: "Iniciar sesión" })).toBeNull();

    vi.mocked(auth.service.initialize).mockResolvedValueOnce(SECOND_USER);
    await user.click(screen.getByRole("button", { name: "Comprobar conexión" }));
    expect(await screen.findByText(SECOND_USER.username)).toBeTruthy();
    expect(screen.queryByText("usuario-a.pdf")).toBeNull();
  });

  it("un timeout de validación mantiene una pantalla neutral recuperable sin cerrar sesión", async () => {
    const auth = createService();
    vi.mocked(auth.service.validateCurrentSession).mockRejectedValueOnce(new BrowserAuthenticationError(
      "AUTH_PROVIDER_UNAVAILABLE",
      "El servicio de autenticación no respondió a tiempo. Tu sesión no fue cerrada. Intenta nuevamente.",
    ));
    render(<App authService={auth.service} />);
    await screen.findByText(FIRST_USER.username);

    act(() => auth.emit("SIGNED_IN", SECOND_USER.id));

    expect(await screen.findByRole("heading", { name: "Servidor temporalmente no disponible" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Comprobar conexión" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(FIRST_USER.username)).toBeNull();
    expect(screen.queryByRole("button", { name: "Iniciar sesión" })).toBeNull();
    expect(auth.service.signOutLocal).not.toHaveBeenCalled();
  });

  it("bloquea el doble clic de health neutral y valida una sola vez al recuperar conexión", async () => {
    const auth = createService();
    const health = deferred<void>();
    const apiClient = {
      requestJson: vi.fn(),
      checkHealth: vi.fn(() => health.promise),
    } as unknown as BrowserApiClient;
    render(<App authService={auth.service} apiClient={apiClient} />);
    await screen.findByText(FIRST_USER.username);
    vi.mocked(auth.service.validateCurrentSession).mockRejectedValueOnce(new BrowserAuthenticationError(
      "AUTH_PROVIDER_UNAVAILABLE",
      "No fue posible iniciar sesión. Intenta nuevamente.",
    ));
    vi.mocked(auth.service.initialize).mockResolvedValueOnce(SECOND_USER);
    act(() => auth.emit("SIGNED_IN", SECOND_USER.id));

    const check = await screen.findByRole("button", { name: "Comprobar conexión" });
    fireEvent.click(check);
    fireEvent.click(check);

    expect(apiClient.checkHealth).toHaveBeenCalledOnce();
    expect((screen.getByRole("button", { name: "Comprobando conexión…" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => health.resolve());

    expect(await screen.findByText(SECOND_USER.username)).toBeTruthy();
    expect(auth.service.initialize).toHaveBeenCalledTimes(2);
  });

  it("una comprobación neutral nueva conserva su error e ignora el éxito tardío anterior", async () => {
    const auth = createService();
    const staleHealth = deferred<void>();
    const apiClient = {
      requestJson: vi.fn(),
      checkHealth: vi.fn()
        .mockReturnValueOnce(staleHealth.promise)
        .mockRejectedValueOnce(new TypeError("synthetic current health failure")),
    } as unknown as BrowserApiClient;
    render(<App authService={auth.service} apiClient={apiClient} />);
    await screen.findByText(FIRST_USER.username);
    vi.mocked(auth.service.validateCurrentSession).mockRejectedValue(new BrowserAuthenticationError(
      "AUTH_PROVIDER_UNAVAILABLE",
      "No fue posible iniciar sesión. Intenta nuevamente.",
    ));
    act(() => auth.emit("SIGNED_IN", SECOND_USER.id));
    fireEvent.click(await screen.findByRole("button", { name: "Comprobar conexión" }));
    await waitFor(() => expect(apiClient.checkHealth).toHaveBeenCalledOnce());

    act(() => auth.emit("SIGNED_IN", SECOND_USER.id));
    const currentCheck = await screen.findByRole("button", { name: "Comprobar conexión" });
    fireEvent.click(currentCheck);
    await waitFor(() => expect(apiClient.checkHealth).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("button", { name: "Comprobar conexión" })).toBeTruthy();

    await act(async () => staleHealth.resolve());

    expect(screen.getByRole("heading", { name: "Servidor temporalmente no disponible" })).toBeTruthy();
    expect(auth.service.initialize).toHaveBeenCalledOnce();
  });

  it("health neutral pendiente se invalida al validar otra identidad y al cerrar sesión", async () => {
    const auth = createService();
    const staleHealth = deferred<void>();
    const apiClient = {
      requestJson: vi.fn(),
      checkHealth: vi.fn(() => staleHealth.promise),
    } as unknown as BrowserApiClient;
    render(<App authService={auth.service} apiClient={apiClient} />);
    await screen.findByText(FIRST_USER.username);
    vi.mocked(auth.service.validateCurrentSession)
      .mockRejectedValueOnce(new BrowserAuthenticationError(
        "AUTH_PROVIDER_UNAVAILABLE",
        "No fue posible iniciar sesión. Intenta nuevamente.",
      ))
      .mockResolvedValueOnce(SECOND_USER);
    act(() => auth.emit("SIGNED_IN", SECOND_USER.id));
    fireEvent.click(await screen.findByRole("button", { name: "Comprobar conexión" }));
    const signal = vi.mocked(apiClient.checkHealth).mock.calls[0]?.[0] as AbortSignal;

    act(() => auth.emit("SIGNED_IN", SECOND_USER.id));
    expect(await screen.findByText(SECOND_USER.username)).toBeTruthy();
    expect(signal.aborted).toBe(true);
    await act(async () => staleHealth.resolve());
    expect(screen.getByText(SECOND_USER.username)).toBeTruthy();

    act(() => auth.emit("SIGNED_OUT"));
    expect(await screen.findByRole("button", { name: "Iniciar sesión" })).toBeTruthy();
    expect(auth.service.initialize).toHaveBeenCalledOnce();
  });

  it("aborta el health neutral pendiente al cerrar sesión e ignora su respuesta tardía", async () => {
    const auth = createService();
    const health = deferred<void>();
    const apiClient = {
      requestJson: vi.fn(),
      checkHealth: vi.fn(() => health.promise),
    } as unknown as BrowserApiClient;
    render(<App authService={auth.service} apiClient={apiClient} />);
    await screen.findByText(FIRST_USER.username);
    vi.mocked(auth.service.validateCurrentSession).mockRejectedValueOnce(new BrowserAuthenticationError(
      "AUTH_PROVIDER_UNAVAILABLE",
      "No fue posible iniciar sesión. Intenta nuevamente.",
    ));
    act(() => auth.emit("SIGNED_IN", SECOND_USER.id));
    fireEvent.click(await screen.findByRole("button", { name: "Comprobar conexión" }));
    const signal = vi.mocked(apiClient.checkHealth).mock.calls[0]?.[0] as AbortSignal;

    act(() => auth.emit("SIGNED_OUT"));
    expect(await screen.findByRole("button", { name: "Iniciar sesión" })).toBeTruthy();
    expect(signal.aborted).toBe(true);
    await act(async () => health.resolve());

    expect(screen.getByRole("button", { name: "Iniciar sesión" })).toBeTruthy();
    expect(auth.service.initialize).toHaveBeenCalledOnce();
  });

  it("desmontar App aborta health neutral e ignora su respuesta tardía", async () => {
    const auth = createService();
    const health = deferred<void>();
    const apiClient = {
      requestJson: vi.fn(),
      checkHealth: vi.fn(() => health.promise),
    } as unknown as BrowserApiClient;
    const { unmount } = render(<App authService={auth.service} apiClient={apiClient} />);
    await screen.findByText(FIRST_USER.username);
    vi.mocked(auth.service.validateCurrentSession).mockRejectedValueOnce(new BrowserAuthenticationError(
      "AUTH_PROVIDER_UNAVAILABLE",
      "No fue posible iniciar sesión. Intenta nuevamente.",
    ));
    act(() => auth.emit("SIGNED_IN", SECOND_USER.id));
    fireEvent.click(await screen.findByRole("button", { name: "Comprobar conexión" }));
    const signal = vi.mocked(apiClient.checkHealth).mock.calls[0]?.[0] as AbortSignal;

    unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => health.resolve());
    expect(auth.service.initialize).toHaveBeenCalledOnce();
  });
});

describe("login y logout", () => {
  it("envía username y password una sola vez, muestra progreso y permite Enter", async () => {
    const auth = createService(null);
    const login = deferred<AuthIdentity>();
    vi.mocked(auth.service.login).mockReturnValue(login.promise);
    const user = userEvent.setup();
    render(<App authService={auth.service} />);
    const username = await screen.findByRole("textbox", { name: "Usuario" });
    const password = screen.getByLabelText("Contraseña");
    await user.type(username, "Usuario.Apellido");
    await user.type(password, "private-password{Enter}");

    expect((screen.getByRole("button", { name: "Iniciando sesión..." }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Iniciando sesión..." }));
    expect(auth.service.login).toHaveBeenCalledOnce();
    expect(auth.service.login).toHaveBeenCalledWith("Usuario.Apellido", "private-password", expect.any(AbortSignal));

    await act(async () => login.resolve(FIRST_USER));
    expect(await screen.findByRole("heading", { name: "Carga tu reporte Autel" })).toBeTruthy();
  });

  it("bloquea un doble clic y crea una sola solicitud de inicio de sesión", async () => {
    const auth = createService(null);
    const login = deferred<AuthIdentity>();
    vi.mocked(auth.service.login).mockReturnValue(login.promise);
    const user = userEvent.setup();
    render(<App authService={auth.service} />);
    await user.type(await screen.findByRole("textbox", { name: "Usuario" }), "usuario.apellido");
    await user.type(screen.getByLabelText("Contraseña"), "private-password");

    await user.dblClick(screen.getByRole("button", { name: "Iniciar sesión" }));

    expect(auth.service.login).toHaveBeenCalledOnce();
    await act(async () => login.resolve(FIRST_USER));
    expect(await screen.findByRole("heading", { name: "Carga tu reporte Autel" })).toBeTruthy();
  });

  it("conserva username, limpia password y muestra el error genérico", async () => {
    const auth = createService(null);
    vi.mocked(auth.service.login).mockRejectedValue(new BrowserAuthenticationError(
      "AUTH_CREDENTIALS_INVALID",
      "Usuario o contraseña incorrectos.",
    ));
    const user = userEvent.setup();
    render(<App authService={auth.service} />);
    const username = await screen.findByRole("textbox", { name: "Usuario" }) as HTMLInputElement;
    const password = screen.getByLabelText("Contraseña") as HTMLInputElement;
    await user.type(username, "usuario.apellido");
    await user.type(password, "incorrecta");
    await user.click(screen.getByRole("button", { name: "Iniciar sesión" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Usuario o contraseña incorrectos.");
    expect(username.value).toBe("usuario.apellido");
    expect(password.value).toBe("");
  });

  it("un timeout lógico de login rehabilita el botón y muestra solamente el mensaje local", async () => {
    const auth = createService(null);
    const login = deferred<AuthIdentity>();
    vi.mocked(auth.service.login).mockReturnValue(login.promise);
    const user = userEvent.setup();
    render(<App authService={auth.service} />);
    await user.type(await screen.findByRole("textbox", { name: "Usuario" }), "usuario.apellido");
    await user.type(screen.getByLabelText("Contraseña"), "private-password");
    await user.click(screen.getByRole("button", { name: "Iniciar sesión" }));
    expect((screen.getByRole("button", { name: "Iniciando sesión..." }) as HTMLButtonElement).disabled).toBe(true);

    await act(async () => login.reject(new BrowserAuthenticationError(
      "AUTH_PROVIDER_UNAVAILABLE",
      "El servicio de autenticación no respondió a tiempo. Tu sesión no fue cerrada. Intenta nuevamente.",
    )));

    expect((await screen.findByRole("alert")).textContent)
      .toBe("El servicio de autenticación no respondió a tiempo. Tu sesión no fue cerrada. Intenta nuevamente.");
    expect((screen.getByRole("button", { name: "Iniciar sesión" }) as HTMLButtonElement).disabled).toBe(false);
    expect(auth.service.signOutLocal).not.toHaveBeenCalled();
  });

  it("un fallo temporal de /me después de establecer sesión muestra estado neutro sin cerrar sesión", async () => {
    const auth = createService(null);
    vi.mocked(auth.service.login).mockRejectedValue(new BrowserAuthenticationError(
      "AUTH_PROVIDER_UNAVAILABLE",
      "No fue posible iniciar sesión. Intenta nuevamente.",
      true,
    ));
    const user = userEvent.setup();
    render(<App authService={auth.service} />);
    await user.type(await screen.findByRole("textbox", { name: "Usuario" }), "usuario.apellido");
    await user.type(screen.getByLabelText("Contraseña"), "private-password");
    await user.click(screen.getByRole("button", { name: "Iniciar sesión" }));

    expect(await screen.findByRole("heading", { name: "Servidor temporalmente no disponible" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Iniciar sesión" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Carga tu reporte Autel" })).toBeNull();
    expect(auth.service.signOutLocal).not.toHaveBeenCalled();
  });

  it("muestra y oculta la contraseña con estado accesible", async () => {
    const auth = createService(null);
    const user = userEvent.setup();
    render(<App authService={auth.service} />);
    const password = await screen.findByLabelText("Contraseña") as HTMLInputElement;
    const toggle = screen.getByRole("button", { name: "Mostrar contraseña" });
    expect(password.type).toBe("password");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");

    await user.click(toggle);
    expect(password.type).toBe("text");
    expect(screen.getByRole("button", { name: "Ocultar contraseña" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("logout usa scope local mediante el servicio y vuelve al login", async () => {
    const auth = createService();
    const user = userEvent.setup();
    render(<App authService={auth.service} />);
    await user.click(await screen.findByRole("button", { name: "Cerrar sesión" }));

    expect(auth.service.signOutLocal).toHaveBeenCalledOnce();
    expect(await screen.findByRole("button", { name: "Iniciar sesión" })).toBeTruthy();
  });

  it("logout pendiente oculta inmediatamente el workspace y no conserva datos privados", async () => {
    const auth = createService();
    const logout = deferred<void>();
    vi.mocked(auth.service.signOutLocal).mockReturnValue(logout.promise);
    const user = userEvent.setup();
    const { container } = render(<App authService={auth.service} />);
    await screen.findByRole("heading", { name: "Carga tu reporte Autel" });
    await user.upload(container.querySelector<HTMLInputElement>('input[type="file"]')!, createPdf("privado.pdf"));

    await user.click(screen.getByRole("button", { name: "Cerrar sesión" }));

    expect(await screen.findByText("Verificando sesión segura…")).toBeTruthy();
    expect(screen.queryByText("privado.pdf")).toBeNull();
    expect(screen.queryByText(FIRST_USER.username)).toBeNull();
    await act(async () => logout.resolve());
    expect(await screen.findByRole("button", { name: "Iniciar sesión" })).toBeTruthy();
  });

  it("si logout falla conserva la sesión y permite reintentar", async () => {
    const auth = createService();
    vi.mocked(auth.service.signOutLocal)
      .mockRejectedValueOnce(new Error("detalle privado"))
      .mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    render(<App authService={auth.service} />);
    const logout = await screen.findByRole("button", { name: "Cerrar sesión" });
    await user.click(logout);

    expect((await screen.findByRole("alert")).textContent).toContain("No fue posible cerrar la sesión. Intenta nuevamente.");
    expect(screen.getByRole("heading", { name: "Carga tu reporte Autel" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Cerrar sesión" }));
    expect(auth.service.signOutLocal).toHaveBeenCalledTimes(2);
    expect(await screen.findByRole("button", { name: "Iniciar sesión" })).toBeTruthy();
  });

  it("configuración ausente no permite bypass ni intentos repetidos", async () => {
    const auth = createService(null);
    vi.mocked(auth.service.subscribe).mockImplementation(() => {
      throw new BrowserAuthenticationError(
        "AUTH_CONFIGURATION_UNAVAILABLE",
        "El acceso seguro no está configurado en este entorno.",
      );
    });
    render(<App authService={auth.service} />);

    expect(await screen.findByText("El acceso seguro no está configurado en este entorno.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Iniciar sesión" }) as HTMLButtonElement).disabled).toBe(true);
    expect(auth.service.initialize).not.toHaveBeenCalled();
    expect(auth.service.login).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "Carga tu reporte Autel" })).toBeNull();
  });
});

describe("solicitudes protegidas", () => {
  it("una respuesta 401 confirmada limpia el reporte y vuelve al login", async () => {
    const auth = createService();
    vi.mocked(auth.service.authenticatedFetch).mockResolvedValue({
      status: 401,
      ok: false,
      json: vi.fn(async () => ({ error: { code: "AUTH_SESSION_INVALID" } })),
    } as unknown as Response);
    const user = userEvent.setup();
    const { container } = render(<App authService={auth.service} />);
    await screen.findByRole("heading", { name: "Carga tu reporte Autel" });
    await user.upload(container.querySelector<HTMLInputElement>('input[type="file"]')!, createPdf());
    fireEvent.submit(container.querySelector("form")!);

    expect(await screen.findByText("Tu sesión ya no es válida. Inicia sesión nuevamente.")).toBeTruthy();
    expect(auth.service.signOutLocal).toHaveBeenCalledOnce();
    expect(screen.queryByText("reporte-sintetico.pdf")).toBeNull();
  });

  it("la carga utiliza el canal autenticado y no realiza análisis automático", async () => {
    const auth = createService();
    vi.mocked(auth.service.authenticatedFetch).mockResolvedValue({
      status: 400,
      ok: false,
      json: vi.fn(async () => ({ error: { code: "INVALID_FILE_FORMAT", message: "Archivo sintético rechazado." } })),
    } as unknown as Response);
    const user = userEvent.setup();
    const { container } = render(<App authService={auth.service} />);
    await screen.findByRole("heading", { name: "Carga tu reporte Autel" });
    await user.upload(container.querySelector<HTMLInputElement>('input[type="file"]')!, createPdf());
    fireEvent.submit(container.querySelector("form")!);
    await screen.findByText("El contenido del archivo no corresponde a un PDF válido.");

    expect(auth.service.authenticatedFetch).toHaveBeenCalledOnce();
    expect(auth.service.authenticatedFetch).toHaveBeenCalledWith("/api/reports/upload", expect.objectContaining({ method: "POST" }));
    expect(vi.mocked(auth.service.authenticatedFetch).mock.calls.some(([url]) => url === "/api/reports/analyze")).toBe(false);
  });

  it("un fallo de red en upload conserva la sesión y el archivo seleccionado", async () => {
    const auth = createService();
    vi.mocked(auth.service.authenticatedFetch).mockRejectedValue(new BrowserAuthenticationError(
      "AUTH_PROVIDER_UNAVAILABLE",
      "No fue posible validar la sesión con el proveedor.",
    ));
    const user = userEvent.setup();
    const { container } = render(<App authService={auth.service} />);
    await screen.findByRole("heading", { name: "Carga tu reporte Autel" });
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = createPdf("red-temporal.pdf");

    await user.upload(input, file);
    fireEvent.submit(container.querySelector("form")!);

    expect(await screen.findByText("Servidor temporalmente no disponible")).toBeTruthy();
    expect(screen.getByText(file.name)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Carga tu reporte Autel" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Iniciar sesión" })).toBeNull();
    expect(auth.service.signOutLocal).not.toHaveBeenCalled();
    expect(auth.service.authenticatedFetch).toHaveBeenCalledOnce();
  });

  it("una respuesta 403 no cierra la sesión", async () => {
    const auth = createService();
    vi.mocked(auth.service.authenticatedFetch).mockResolvedValue({
      status: 403,
      ok: false,
      json: vi.fn(async () => ({ error: { code: "FORBIDDEN", message: "detalle interno" } })),
    } as unknown as Response);
    const user = userEvent.setup();
    const { container } = render(<App authService={auth.service} />);
    await screen.findByRole("heading", { name: "Carga tu reporte Autel" });

    await user.upload(container.querySelector<HTMLInputElement>('input[type="file"]')!, createPdf());
    fireEvent.submit(container.querySelector("form")!);

    expect(await screen.findByText("No tienes permiso para realizar esta acción.")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Carga tu reporte Autel" })).toBeTruthy();
    expect(auth.service.signOutLocal).not.toHaveBeenCalled();
  });
});
