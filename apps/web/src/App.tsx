import { type ChangeEvent, type DragEvent, type FormEvent, useRef, useState } from "react";

const PDF_MIME_TYPE = "application/pdf";

type UploadStatus = "idle" | "uploading" | "success" | "error";

interface UploadResponse {
  id: string;
  originalName: string;
  size: number;
  hash: string;
  type: string;
  status: "received";
}

interface ErrorResponse {
  error?: {
    code?: string;
    message?: string;
  };
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function validateFile(file: File) {
  const hasInvalidMimeType = file.type !== "" && file.type !== PDF_MIME_TYPE;

  if (!file.name.toLowerCase().endsWith(".pdf") || hasInvalidMimeType) {
    return "Selecciona un archivo PDF válido (.pdf).";
  }

  return null;
}

export function App() {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [status, setStatus] = useState<UploadStatus>("idle");
  const [message, setMessage] = useState("");
  const [uploadResult, setUploadResult] = useState<UploadResponse | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const uploadInProgressRef = useRef(false);
  const uploadSequenceRef = useRef(0);
  const activeUploadRef = useRef<{ id: number; file: File } | null>(null);

  function selectFile(file: File | undefined) {
    if (!file || uploadInProgressRef.current) return false;

    const validationError = validateFile(file);
    setUploadResult(null);

    if (validationError) {
      setSelectedFile(null);
      setStatus("error");
      setMessage(validationError);
      if (inputRef.current) inputRef.current.value = "";
      return false;
    }

    setSelectedFile(file);
    setStatus("idle");
    setMessage("");
    return true;
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";

    if (uploadInProgressRef.current) return;
    selectFile(file);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);

    if (uploadInProgressRef.current) return;

    if (event.dataTransfer.files.length > 1) {
      setSelectedFile(null);
      setStatus("error");
      setMessage("Selecciona solamente un archivo PDF.");
      if (inputRef.current) inputRef.current.value = "";
      return;
    }

    if (selectFile(event.dataTransfer.files[0]) && inputRef.current) {
      inputRef.current.value = "";
    }
  }

  function removeFile() {
    if (uploadInProgressRef.current) return;

    setSelectedFile(null);
    setStatus("idle");
    setMessage("");
    setUploadResult(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedFile || uploadInProgressRef.current) return;

    uploadInProgressRef.current = true;
    const uploadId = ++uploadSequenceRef.current;
    const fileBeingUploaded = selectedFile;
    activeUploadRef.current = { id: uploadId, file: fileBeingUploaded };

    const isActiveUpload = () => {
      const activeUpload = activeUploadRef.current;
      return activeUpload?.id === uploadId && activeUpload.file === fileBeingUploaded;
    };

    setStatus("uploading");
    setMessage("Enviando reporte de forma segura…");
    setUploadResult(null);

    const formData = new FormData();
    formData.append("report", fileBeingUploaded);

    try {
      const response = await fetch("/api/reports/upload", {
        method: "POST",
        body: formData,
      });
      let body: UploadResponse | ErrorResponse;

      try {
        body = (await response.json()) as UploadResponse | ErrorResponse;
      } catch {
        throw new Error("El servidor devolvió una respuesta inválida.");
      }

      if (!isActiveUpload()) return;

      if (!response.ok) {
        const errorBody = body as ErrorResponse;
        throw new Error(errorBody.error?.message ?? "No fue posible enviar el reporte.");
      }

      const result = body as UploadResponse;
      setUploadResult(result);
      setStatus("success");
      setMessage("Reporte recibido correctamente.");
    } catch (error) {
      if (!isActiveUpload()) return;

      setStatus("error");
      setMessage(
        error instanceof TypeError
          ? "No fue posible conectar con el servidor. Inténtalo de nuevo."
          : error instanceof Error
            ? error.message
            : "No fue posible enviar el reporte.",
      );
    } finally {
      if (isActiveUpload()) {
        activeUploadRef.current = null;
        uploadInProgressRef.current = false;
      }
    }
  }

  return (
    <main className="app-shell">
      <header className="brand" aria-label="AutoDiag IA">
        <span className="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 32 32" role="img">
            <path d="M7 19h18l-2.1-7.2A4 4 0 0 0 19 9h-6a4 4 0 0 0-3.9 2.8L7 19Z" />
            <path d="M5 19h22v5a2 2 0 0 1-2 2h-2v-2H9v2H7a2 2 0 0 1-2-2v-5Z" />
            <circle cx="10" cy="20.5" r="1.5" />
            <circle cx="22" cy="20.5" r="1.5" />
            <path className="brand-pulse" d="m12 15 2-2 2.1 4 2-3H21" />
          </svg>
        </span>
        <span>AutoDiag <strong>IA</strong></span>
      </header>

      <section className="upload-card" aria-labelledby="upload-title">
        <div className="intro">
          <span className="eyebrow">ANÁLISIS AUTOMOTRIZ</span>
          <h1 id="upload-title">Carga tu reporte Autel</h1>
          <p>Sube el reporte PDF generado por tu escáner. En esta etapa verificaremos que el archivo se reciba correctamente.</p>
        </div>

        <form onSubmit={handleSubmit}>
          <div
            className={`drop-zone${isDragging ? " is-dragging" : ""}${selectedFile ? " has-file" : ""}${status === "uploading" ? " is-disabled" : ""}`}
            aria-disabled={status === "uploading"}
            onDragEnter={(event) => {
              event.preventDefault();
              if (!uploadInProgressRef.current) setIsDragging(true);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setIsDragging(false);
            }}
            onDrop={handleDrop}
          >
            <input
              ref={inputRef}
              id="report-file"
              className="file-input"
              type="file"
              name="report"
              accept="application/pdf,.pdf"
              onChange={handleFileChange}
              disabled={status === "uploading"}
            />

            {selectedFile ? (
              <div className="selected-file">
                <span className="file-icon" aria-hidden="true">
                  <svg viewBox="0 0 40 48">
                    <path d="M7 1h17l9 9v37H7z" />
                    <path d="M24 1v10h9" />
                    <path d="M12 32h16M12 38h12M12 26h8" />
                  </svg>
                </span>
                <div className="file-details">
                  <strong>{selectedFile.name}</strong>
                  <span>{formatFileSize(selectedFile.size)} · PDF</span>
                </div>
                <div className="file-actions">
                  <label className={`text-button${status === "uploading" ? " is-disabled" : ""}`} htmlFor="report-file" aria-disabled={status === "uploading"}>Cambiar</label>
                  <button className="icon-button" type="button" onClick={removeFile} disabled={status === "uploading"} aria-label="Eliminar archivo seleccionado">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17" /></svg>
                  </button>
                </div>
              </div>
            ) : (
              <label className="drop-label" htmlFor="report-file">
                <span className="upload-icon" aria-hidden="true">
                  <svg viewBox="0 0 48 48">
                    <path d="M15 37h-3a8 8 0 0 1-.6-16A13 13 0 0 1 37 18a9.5 9.5 0 0 1-1 19h-4" />
                    <path d="m17 26 7-7 7 7M24 20v21" />
                  </svg>
                </span>
                <strong>{isDragging ? "Suelta el archivo aquí" : "Arrastra tu PDF aquí"}</strong>
                <span>o <u>selecciona un archivo</u> desde tu equipo</span>
              </label>
            )}
          </div>

          <div className="file-guidance" aria-label="Requisitos del archivo">
            <span><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z" /><path d="M10 9v5M10 6.5v.2" /></svg> Solo archivos PDF</span>
            <span>El servidor validará el tamaño permitido</span>
          </div>

          <div className="status-region" aria-live="polite" aria-atomic="true">
            {message && (
              <div className={`status-message ${status}`} role={status === "error" ? "alert" : "status"}>
                <span aria-hidden="true">{status === "success" ? "✓" : status === "error" ? "!" : "↥"}</span>
                <div>
                  <strong>{message}</strong>
                  {uploadResult && <small>Referencia: {uploadResult.id}</small>}
                </div>
              </div>
            )}
          </div>

          <button className="submit-button" type="submit" disabled={!selectedFile || status === "uploading"}>
            {status === "uploading" ? <span className="spinner" aria-hidden="true" /> : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4m0 0L7 9m5-5 5 5M5 15v4h14v-4" /></svg>}
            {status === "uploading" ? "Enviando…" : "Enviar reporte"}
          </button>
        </form>

        <div className="privacy-note">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 10V7a6 6 0 0 1 12 0v3M5 10h14v11H5z" /><path d="M12 14v3" /></svg>
          <p><strong>Tu archivo se procesa de forma temporal</strong><span>No lo almacenamos ni compartimos con servicios externos.</span></p>
        </div>
      </section>

      <footer>AutoDiag IA · Recepción segura de reportes</footer>
    </main>
  );
}
