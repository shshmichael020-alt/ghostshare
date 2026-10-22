"use client";

import { useEffect, useRef, useState } from "react";
import { EXPIRY_OPTIONS, DEFAULT_TTL_SECONDS, MAX_TRANSFER_BYTES } from "@/lib/constants";
import { formatSize } from "@/lib/format";
import { FileTypeIcon } from "./FileTypeIcon";
import ToastStack from "./ToastStack";
import { useToasts } from "@/lib/useToasts";
import { QrCode, X, Loader2, Check, AlertCircle, ArrowLeft, Plus } from "lucide-react";

type UploadItem = {
  id: string;
  name: string;
  size: number;
  progress: number;
  status: "uploading" | "done" | "error";
  error?: string;
  xhr?: XMLHttpRequest;
};

function extractCodeFromScan(text: string): string | null {
  const digitsOnly = text.match(/^\d{8}$/);
  if (digitsOnly) return digitsOnly[0];
  try {
    const u = new URL(text);
    const c = u.searchParams.get("code");
    if (c && /^\d{8}$/.test(c)) return c;
  } catch {
    // not a URL, ignore
  }
  return null;
}

// PUT the file straight to R2's presigned URL, with real upload progress
// (fetch doesn't reliably report upload progress across browsers - XHR does).
function putWithProgress(url: string, file: File, onProgress: (pct: number) => void, xhrRef: (x: XMLHttpRequest) => void) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhrRef(xhr);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress((e.loaded / e.total) * 100);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.onabort = () => {
      const err = new Error("Canceled");
      err.name = "AbortError";
      reject(err);
    };
    xhr.open("PUT", url);
    xhr.send(file);
  });
}

export default function SendPanel({ initialCode }: { initialCode?: string }) {
  const [codeInput, setCodeInput] = useState(initialCode ?? "");
  const [linkedCode, setLinkedCode] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [expirySeconds, setExpirySeconds] = useState<number>(DEFAULT_TTL_SECONDS);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scannerRef = useRef<HTMLDivElement>(null);
  const html5QrRef = useRef<import("html5-qrcode").Html5Qrcode | null>(null);
  const { toasts, push } = useToasts();

  async function verifyCode(code: string) {
    setChecking(true);
    setCodeError(null);
    try {
      const res = await fetch(`/api/session/${code}`, { cache: "no-store" });
      if (!res.ok) {
        setCodeError("That code isn't valid or has expired.");
        setChecking(false);
        return false;
      }
      setLinkedCode(code);
      setChecking(false);
      return true;
    } catch {
      setCodeError("Network error, try again.");
      setChecking(false);
      return false;
    }
  }

  useEffect(() => {
    if (initialCode && /^\d{8}$/.test(initialCode)) {
      verifyCode(initialCode);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCode]);

  // Paste-to-upload: Ctrl/Cmd+V a file (or a screenshot) directly onto the page.
  useEffect(() => {
    if (!linkedCode) return;
    function onPaste(e: ClipboardEvent) {
      const items = e.clipboardData?.files;
      if (items && items.length > 0) {
        handleFiles(items);
        push(`Pasted ${items.length} file${items.length > 1 ? "s" : ""}`, "default");
      }
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkedCode]);

  async function startScan() {
    setScanning(true);
    setCodeError(null);
    const { Html5Qrcode } = await import("html5-qrcode");
    setTimeout(async () => {
      if (!scannerRef.current) return;
      const qr = new Html5Qrcode(scannerRef.current.id);
      html5QrRef.current = qr;
      try {
        await qr.start(
          { facingMode: "environment" },
          { fps: 10, qrbox: 220 },
          async (decodedText) => {
            const code = extractCodeFromScan(decodedText);
            if (code) {
              await qr.stop();
              qr.clear();
              setScanning(false);
              setCodeInput(code);
              verifyCode(code);
            }
          },
          undefined,
        );
      } catch {
        setCodeError("Couldn't access the camera. Enter the 8-digit code instead.");
        setScanning(false);
      }
    }, 50);
  }

  async function stopScan() {
    try {
      await html5QrRef.current?.stop();
      html5QrRef.current?.clear();
    } catch {
      // ignore
    }
    setScanning(false);
  }

  const usedBytes = uploads.filter((u) => u.status !== "error").reduce((sum, u) => sum + u.size, 0);
  const remainingBytes = Math.max(0, MAX_TRANSFER_BYTES - usedBytes);

  function handleFiles(fileList: FileList | File[]) {
    const files = Array.from(fileList);
    let budget = remainingBytes;
    for (const file of files) {
      if (file.size > budget) {
        push(`${file.name} skipped — would exceed the 250 MB transfer limit`, "error");
        continue;
      }
      budget -= file.size;
      uploadFile(file);
    }
  }

  async function uploadFile(file: File) {
    if (!linkedCode) return;
    const id = `${file.name}-${file.size}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    setUploads((prev) => [...prev, { id, name: file.name, size: file.size, progress: 0, status: "uploading" }]);

    try {
      const presignRes = await fetch("/api/upload-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: linkedCode, name: file.name, size: file.size, expirySeconds }),
      });
      if (!presignRes.ok) {
        const data = (await presignRes.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || "Could not start upload");
      }
      const { uploadUrl, downloadUrl, objectKey } = (await presignRes.json()) as {
        uploadUrl: string;
        downloadUrl: string;
        objectKey: string;
      };

      await putWithProgress(
        uploadUrl,
        file,
        (pct) => setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, progress: pct } : u))),
        (xhr) => setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, xhr } : u))),
      );

      const regRes = await fetch("/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: linkedCode,
          objectKey,
          downloadUrl,
          name: file.name,
          size: file.size,
          expirySeconds,
        }),
      });
      if (!regRes.ok) {
        const data = (await regRes.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || "Could not register the upload");
      }

      setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, status: "done", progress: 100 } : u)));
      push(`${file.name} sent`, "success");
    } catch (e) {
      const message = (e as Error).name === "AbortError" ? "Canceled" : (e as Error).message;
      setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, status: "error", error: message } : u)));
      if ((e as Error).name !== "AbortError") push(`${file.name} failed: ${message}`, "error");
    }
  }

  function cancelUpload(id: string) {
    setUploads((prev) => {
      const item = prev.find((u) => u.id === id);
      item?.xhr?.abort();
      return prev.filter((u) => u.id !== id);
    });
  }

  function dismissUpload(id: string) {
    setUploads((prev) => prev.filter((u) => u.id !== id));
  }

  if (!linkedCode) {
    return (
      <div className="flex flex-col items-center gap-5 text-center">
        <ToastStack toasts={toasts} />
        <p style={{ color: "var(--relay-text-dim)" }} className="text-sm">
          Enter the code shown on the receiving device
        </p>

        {scanning ? (
          <div className="w-full flex flex-col items-center gap-3">
            <div
              id="qr-scanner-region"
              ref={scannerRef}
              className="w-full max-w-[280px] aspect-square rounded-lg overflow-hidden border"
              style={{ borderColor: "var(--relay-line)" }}
            />
            <button
              onClick={stopScan}
              className="text-sm px-3 py-1.5 rounded-md border"
              style={{ borderColor: "var(--relay-line)", color: "var(--relay-text-dim)" }}
            >
              Cancel scan
            </button>
          </div>
        ) : (
          <>
            <input
              value={codeInput}
              onChange={(e) => setCodeInput(e.target.value.replace(/\D/g, "").slice(0, 8))}
              onKeyDown={(e) => {
                if (e.key === "Enter" && codeInput.length === 8) verifyCode(codeInput);
              }}
              placeholder="········"
              inputMode="numeric"
              maxLength={8}
              className="font-mono-relay text-2xl tracking-[0.3em] text-center w-56 py-3 rounded-lg border bg-transparent outline-none"
              style={{ borderColor: "var(--relay-line)", color: "var(--relay-amber)" }}
            />

            {codeError && (
              <p className="text-sm flex items-center gap-1.5" style={{ color: "var(--relay-red)" }}>
                <AlertCircle size={14} /> {codeError}
              </p>
            )}

            <div className="flex gap-3">
              <button
                onClick={() => verifyCode(codeInput)}
                disabled={codeInput.length !== 8 || checking}
                className="px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-40 transition-opacity flex items-center gap-1.5"
                style={{ background: "var(--relay-amber)", color: "#161311" }}
              >
                {checking ? <Loader2 size={15} className="animate-spin" /> : null}
                {checking ? "Checking…" : "Continue"}
              </button>
              <button
                onClick={startScan}
                className="px-4 py-2 rounded-lg text-sm font-medium border flex items-center gap-1.5"
                style={{ borderColor: "var(--relay-line)" }}
              >
                <QrCode size={15} /> Scan QR
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  const uploadingStarted = uploads.length > 0;
  const usagePct = Math.min(100, (usedBytes / MAX_TRANSFER_BYTES) * 100);

  return (
    <div className="flex flex-col gap-4">
      <ToastStack toasts={toasts} />

      <button
        onClick={() => {
          setLinkedCode(null);
          setUploads([]);
          setCodeInput("");
        }}
        className="self-start text-xs flex items-center gap-1 transition-colors hover:text-[var(--relay-text)]"
        style={{ color: "var(--relay-text-dim)" }}
      >
        <ArrowLeft size={12} /> Change code
      </button>

      <div>
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs uppercase tracking-[0.15em]" style={{ color: "var(--relay-text-dim)" }}>
            Available for
          </p>
          {uploadingStarted && (
            <p className="text-xs" style={{ color: "var(--relay-text-dim)" }}>
              locked after first upload
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {EXPIRY_OPTIONS.map((opt) => {
            const active = expirySeconds === opt.seconds;
            return (
              <button
                key={opt.seconds}
                type="button"
                disabled={uploadingStarted}
                onClick={() => setExpirySeconds(opt.seconds)}
                className="px-3 py-1.5 rounded-full text-xs font-medium border transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                style={
                  active
                    ? { background: "var(--relay-amber)", borderColor: "var(--relay-amber)", color: "#161311" }
                    : { borderColor: "var(--relay-line)", color: "var(--relay-text-dim)" }
                }
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer.files?.length) handleFiles(e.dataTransfer.files);
        }}
        onClick={() => fileInputRef.current?.click()}
        className="rounded-xl border-2 border-dashed flex flex-col items-center justify-center gap-2 py-10 cursor-pointer transition-colors"
        style={{
          borderColor: dragOver ? "var(--relay-amber)" : "var(--relay-line)",
          background: dragOver ? "rgba(255,171,63,0.05)" : "var(--relay-panel-raised)",
        }}
      >
        <div
          className="w-10 h-10 rounded-full flex items-center justify-center"
          style={{ background: "var(--relay-panel)", color: "var(--relay-amber)" }}
        >
          <Plus size={18} strokeWidth={2.25} />
        </div>
        <p className="text-sm">Drag files here, click to choose, or paste</p>
        <p className="text-xs" style={{ color: "var(--relay-text-dim)" }}>
          expires in {EXPIRY_OPTIONS.find((o) => o.seconds === expirySeconds)?.label} · paired with {linkedCode}
        </p>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => e.target.files && handleFiles(e.target.files)}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex justify-between text-xs" style={{ color: "var(--relay-text-dim)" }}>
          <span>
            {formatSize(usedBytes)} of {formatSize(MAX_TRANSFER_BYTES)} used
          </span>
          <span>{formatSize(remainingBytes)} left</span>
        </div>
        <div className="w-full h-1.5 rounded-full overflow-hidden" style={{ background: "var(--relay-line)" }}>
          <div
            className="h-full transition-all"
            style={{
              width: `${usagePct}%`,
              background: usagePct > 90 ? "var(--relay-red)" : "var(--relay-amber)",
            }}
          />
        </div>
      </div>

      {uploads.length > 0 && (
        <div className="flex flex-col gap-2">
          {uploads.map((u) => (
            <div
              key={u.id}
              className="px-3.5 py-3 rounded-lg border flex items-center gap-3"
              style={{ borderColor: "var(--relay-line)", background: "var(--relay-panel-raised)" }}
            >
              <FileTypeIcon name={u.name} className="shrink-0" size={18} />
              <div className="flex-1 min-w-0 flex flex-col gap-1.5">
                <div className="flex justify-between text-sm gap-3">
                  <span className="truncate">{u.name}</span>
                  <span
                    className="whitespace-nowrap font-mono-relay text-xs flex items-center gap-1"
                    style={{
                      color:
                        u.status === "error"
                          ? "var(--relay-red)"
                          : u.status === "done"
                          ? "var(--relay-teal)"
                          : "var(--relay-text-dim)",
                    }}
                  >
                    {u.status === "done" && <Check size={13} />}
                    {u.status === "error" ? u.error : u.status === "done" ? "Sent" : `${Math.round(u.progress)}%`}
                  </span>
                </div>
                {u.status === "uploading" && (
                  <div className="w-full h-1 rounded-full overflow-hidden" style={{ background: "var(--relay-line)" }}>
                    <div
                      className="h-full transition-all"
                      style={{ width: `${u.progress}%`, background: "var(--relay-amber)" }}
                    />
                  </div>
                )}
              </div>
              <button
                onClick={() => (u.status === "uploading" ? cancelUpload(u.id) : dismissUpload(u.id))}
                className="shrink-0 p-1 rounded-md transition-colors hover:bg-white/5"
                style={{ color: "var(--relay-text-dim)" }}
                aria-label={u.status === "uploading" ? "Cancel upload" : "Dismiss"}
              >
                <X size={15} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
