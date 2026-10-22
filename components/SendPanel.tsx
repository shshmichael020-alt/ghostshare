"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { EXPIRY_OPTIONS, DEFAULT_TTL_SECONDS, MAX_TRANSFER_BYTES } from "@/lib/constants";
import { formatSize } from "@/lib/format";
import { FileTypeIcon } from "./FileTypeIcon";
import PinInput from "./PinInput";
import QrScannerModal from "./QrScannerModal";
import ToastStack from "./ToastStack";
import { useToasts } from "@/lib/useToasts";
import {
  QrCode,
  X,
  Loader2,
  Check,
  AlertCircle,
  ArrowLeft,
  FolderOpen,
  CloudUpload,
  Lock,
  Layers,
  MemoryStick,
  Sparkles,
  Shield,
  Trash2,
} from "lucide-react";

export type StagedItem = {
  id: string;
  file: File;
  name: string;
  size: number;
  progress: number;
  status: "idle" | "uploading" | "done" | "error";
  error?: string;
  xhr?: XMLHttpRequest;
};

// PUT file straight to R2's presigned URL with real upload progress tracking via XHR
function putWithProgress(
  url: string,
  file: File,
  onProgress: (pct: number) => void,
  xhrRef: (x: XMLHttpRequest) => void,
) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhrRef(xhr);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        onProgress((e.loaded / e.total) * 100);
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new Error(`Upload failed (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error("Network error during upload to R2"));
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
  const [isScannerOpen, setIsScannerOpen] = useState(false);

  const [stagedFiles, setStagedFiles] = useState<StagedItem[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [expirySeconds, setExpirySeconds] = useState<number>(DEFAULT_TTL_SECONDS);
  const [uploadStarted, setUploadStarted] = useState(false);
  const [isUploadingBatch, setIsUploadingBatch] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toasts, push, dismiss } = useToasts();

  const verifyCode = useCallback(async (codeToVerify: string) => {
    setChecking(true);
    setCodeError(null);
    try {
      const res = await fetch(`/api/session/${codeToVerify}`, { cache: "no-store" });
      if (!res.ok) {
        setCodeError("That 8-digit code is invalid, non-existent, or expired.");
        setChecking(false);
        return false;
      }
      setLinkedCode(codeToVerify);
      setChecking(false);
      return true;
    } catch {
      setCodeError("Network error. Please verify your connection.");
      setChecking(false);
      return false;
    }
  }, []);

  // Check initial code from URL if provided (deferred to avoid cascading sync render)
  useEffect(() => {
    if (initialCode && /^\d{8}$/.test(initialCode)) {
      const timer = setTimeout(() => {
        verifyCode(initialCode);
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [initialCode, verifyCode]);

  // Combined transfer size computations
  const totalStagedBytes = stagedFiles.reduce((sum, f) => sum + f.size, 0);
  const remainingBytes = Math.max(0, MAX_TRANSFER_BYTES - totalStagedBytes);
  const usagePct = Math.min(100, (totalStagedBytes / MAX_TRANSFER_BYTES) * 100);

  const handleFiles = useCallback(
    (fileList: FileList | File[]) => {
      const incoming = Array.from(fileList);
      let budget = remainingBytes;
      const newItems: StagedItem[] = [];

      for (const file of incoming) {
        if (file.size > budget) {
          push(`${file.name} skipped — would exceed the 250 MB transfer limit`, "error");
          continue;
        }
        budget -= file.size;

        const randomSlug = Math.random().toString(36).slice(2, 8);
        const id = `${Date.now()}-${randomSlug}-${file.name}`;
        newItems.push({
          id,
          file,
          name: file.name,
          size: file.size,
          progress: 0,
          status: "idle",
        });
      }

      if (newItems.length > 0) {
        setStagedFiles((prev) => [...prev, ...newItems]);
        push(`Staged ${newItems.length} file${newItems.length > 1 ? "s" : ""}`, "default");
      }
    },
    [remainingBytes, push],
  );

  // Support paste-to-upload: Ctrl/Cmd+V files or screenshots directly
  useEffect(() => {
    if (!linkedCode) return;

    function onPaste(e: ClipboardEvent) {
      const items = e.clipboardData?.files;
      if (items && items.length > 0) {
        handleFiles(items);
        push(`Pasted ${items.length} file${items.length > 1 ? "s" : ""} from clipboard`, "default");
      }
    }

    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [linkedCode, handleFiles, push]);

  function removeStagedItem(id: string) {
    setStagedFiles((prev) => {
      const target = prev.find((item) => item.id === id);
      target?.xhr?.abort();
      return prev.filter((item) => item.id !== id);
    });
  }

  function clearAllStaged() {
    stagedFiles.forEach((f) => f.xhr?.abort());
    setStagedFiles([]);
  }

  // Upload an individual file through the direct-to-R2 pipeline
  async function uploadSingleFile(item: StagedItem, code: string) {
    setStagedFiles((prev) =>
      prev.map((u) => (u.id === item.id ? { ...u, status: "uploading", progress: 0 } : u)),
    );

    try {
      // Step 1: Request presigned PUT URL and scoped download URL
      const presignRes = await fetch("/api/upload-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code,
          name: item.name,
          size: item.size,
          expirySeconds,
        }),
      });

      if (!presignRes.ok) {
        const data = (await presignRes.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || "Could not generate upload URL");
      }

      const { uploadUrl, downloadUrl, objectKey } = (await presignRes.json()) as {
        uploadUrl: string;
        downloadUrl: string;
        objectKey: string;
      };

      // Step 2: PUT file bytes directly to Cloudflare R2 bucket with live progress
      await putWithProgress(
        uploadUrl,
        item.file,
        (pct) => {
          setStagedFiles((prev) =>
            prev.map((u) => (u.id === item.id ? { ...u, progress: pct } : u)),
          );
        },
        (xhr) => {
          setStagedFiles((prev) =>
            prev.map((u) => (u.id === item.id ? { ...u, xhr } : u)),
          );
        },
      );

      // Step 3: Register verified upload in Workers KV session
      const regRes = await fetch("/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code,
          objectKey,
          downloadUrl,
          name: item.name,
          size: item.size,
          expirySeconds,
        }),
      });

      if (!regRes.ok) {
        const data = (await regRes.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || "Could not register file in session");
      }

      setStagedFiles((prev) =>
        prev.map((u) => (u.id === item.id ? { ...u, status: "done", progress: 100 } : u)),
      );
      push(`${item.name} uploaded successfully`, "success");
    } catch (e) {
      const isAbort = (e as Error).name === "AbortError";
      const message = isAbort ? "Canceled" : (e as Error).message;
      setStagedFiles((prev) =>
        prev.map((u) => (u.id === item.id ? { ...u, status: "error", error: message } : u)),
      );
      if (!isAbort) {
        push(`${item.name} failed: ${message}`, "error");
      }
    }
  }

  // Batch upload all idle/retry files
  async function triggerBatchUpload() {
    if (!linkedCode || stagedFiles.length === 0 || isUploadingBatch) return;

    setUploadStarted(true);
    setIsUploadingBatch(true);

    const pending = stagedFiles.filter((f) => f.status === "idle" || f.status === "error");
    for (const item of pending) {
      await uploadSingleFile(item, linkedCode);
    }

    setIsUploadingBatch(false);
  }

  /* ------------------------------------------------------------- */
  /* STEP 1: Connect / Verify PIN Screen                           */
  /* ------------------------------------------------------------- */
  if (!linkedCode) {
    return (
      <div className="w-full flex flex-col items-center">
        <ToastStack toasts={toasts} onDismiss={dismiss} />
        <QrScannerModal
          isOpen={isScannerOpen}
          onClose={() => setIsScannerOpen(false)}
          onScanSuccess={(scannedCode) => {
            setCodeInput(scannedCode);
            verifyCode(scannedCode);
          }}
        />

        {/* Ambient atmospheric glow */}
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[700px] h-[340px] bg-gradient-to-b from-primary/10 via-secondary/5 to-transparent blur-3xl pointer-events-none -z-10" />

        {/* Hero Context */}
        <div className="text-center max-w-lg mb-8">
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-surface-container-high text-primary font-label-caps tracking-widest uppercase mb-3 border border-white/[0.06]">
            <Sparkles size={14} />
            <span>Zero-Knowledge Peer Sync</span>
          </div>
          <h2 className="font-headline-lg text-on-surface tracking-tight font-medium mb-2">
            Establish Encrypted Bridge
          </h2>
          <p className="font-body-md text-on-surface-variant">
            Connect directly with your receiving device via ephemeral Workers KV handshake and signed Cloudflare R2
            pipeline.
          </p>
        </div>

        {/* Connection Card */}
        <div className="w-full max-w-xl bg-surface-container rounded-2xl border border-white/[0.08] shadow-2xl p-6 sm:p-8 relative overflow-hidden flex flex-col gap-6">
          <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-primary to-transparent opacity-60" />

          {/* Mode Switcher Tabs */}
          <div className="flex items-center justify-between gap-2 bg-surface-container-lowest p-1 rounded-xl border border-white/[0.06]">
            <button
              type="button"
              className="flex-1 py-2 px-3 rounded-lg font-body-sm font-medium transition-all flex items-center justify-center gap-2 bg-surface-container-high text-on-surface shadow-sm border border-white/[0.04]"
            >
              <span className="w-2 h-2 rounded-full bg-secondary" />
              <span>8-Digit Token</span>
            </button>
            <button
              type="button"
              onClick={() => setIsScannerOpen(true)}
              className="flex-1 py-2 px-3 rounded-lg font-body-sm font-medium transition-all flex items-center justify-center gap-2 text-on-surface-variant hover:text-on-surface hover:bg-surface-container-low cursor-pointer"
            >
              <QrCode size={16} />
              <span>Camera QR Lens</span>
            </button>
          </div>

          {/* Segmented Pin Input Component */}
          <PinInput
            value={codeInput}
            onChange={(val) => {
              setCodeInput(val);
              setCodeError(null);
            }}
            onComplete={(code) => verifyCode(code)}
            disabled={checking}
          />

          {codeError && (
            <div className="p-3.5 rounded-xl bg-error-container/20 border border-error/30 text-error flex items-start gap-2 text-xs font-body-sm">
              <AlertCircle size={16} className="shrink-0 mt-0.5" />
              <span>{codeError}</span>
            </div>
          )}

          {/* Action Row */}
          <div className="flex flex-col sm:flex-row gap-3 pt-2">
            <button
              onClick={() => verifyCode(codeInput)}
              disabled={codeInput.length !== 8 || checking}
              className="flex-1 py-3 px-4 rounded-xl bg-primary text-on-primary font-body-md font-semibold hover:bg-primary-container hover:text-on-primary-container transition-all flex items-center justify-center gap-2 shadow-md active:scale-[0.99] disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              {checking ? <Loader2 size={18} className="animate-spin" /> : null}
              <span>{checking ? "Verifying Session..." : "Connect Recipient"}</span>
            </button>

            <button
              type="button"
              onClick={() => setIsScannerOpen(true)}
              className="py-3 px-4 rounded-xl bg-surface-container-high hover:bg-surface-bright text-on-surface font-body-md font-medium transition-all flex items-center justify-center gap-2 border border-white/[0.08] cursor-pointer"
            >
              <QrCode size={18} className="text-secondary" />
              <span>Scan QR</span>
            </button>
          </div>

          <div className="pt-2 border-t border-white/[0.04] flex items-center justify-between text-on-surface-variant font-mono-telemetry">
            <span>PAIRING PROTOCOL: ED25519 / TLS 1.3</span>
            <span className="text-tertiary">EPHEMERAL TUNNEL</span>
          </div>
        </div>
      </div>
    );
  }

  /* ------------------------------------------------------------- */
  /* STEP 2: File Selection & Pre-Upload Staging                   */
  /* ------------------------------------------------------------- */
  const idleCount = stagedFiles.filter((f) => f.status === "idle").length;
  const isAllDone = stagedFiles.length > 0 && stagedFiles.every((f) => f.status === "done");

  return (
    <div className="w-full flex flex-col gap-6">
      <ToastStack toasts={toasts} onDismiss={dismiss} />

      {/* Top Telemetry & Session Header */}
      <section className="flex flex-col md:flex-row md:items-center justify-between gap-4 p-4 rounded-2xl bg-surface-container-low border border-white/[0.08] shadow-sm">
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={() => {
              setLinkedCode(null);
              setStagedFiles([]);
              setCodeInput("");
              setUploadStarted(false);
            }}
            className="flex items-center gap-1.5 text-xs font-body-sm text-on-surface-variant hover:text-on-surface bg-surface-container px-2.5 py-1.5 rounded-lg border border-white/[0.04] transition-colors cursor-pointer"
            title="Disconnect and change code"
          >
            <ArrowLeft size={14} />
            <span>Change Code</span>
          </button>

          <div className="flex items-center gap-2 bg-surface-container-highest px-3 py-1 rounded-lg border border-white/[0.06]">
            <span className="font-label-caps text-on-surface-variant uppercase">Pairing Channel</span>
            <div className="flex items-center gap-1 text-secondary font-mono-telemetry font-bold tracking-wider">
              <span className="w-2 h-2 rounded-full bg-secondary animate-pulse" />
              <span>{linkedCode.slice(0, 4)}</span>
              <span className="text-outline-variant">-</span>
              <span>{linkedCode.slice(4, 8)}</span>
            </div>
          </div>

          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-surface-container-high text-on-surface">
            <span className="w-2 h-2 rounded-full bg-tertiary" />
            <span className="font-body-sm font-medium">Target Active</span>
          </div>
        </div>

        <div className="flex items-center gap-4 font-mono-telemetry text-on-surface-variant">
          <div className="flex items-center gap-1.5">
            <Shield size={14} className="text-secondary" />
            <span>R2 Direct Pipe</span>
          </div>
          <div className="flex items-center gap-1.5 bg-surface-container px-2.5 py-1 rounded border border-white/[0.04]">
            <Lock size={14} className="text-primary" />
            <span>TTL: {EXPIRY_OPTIONS.find((o) => o.seconds === expirySeconds)?.label}</span>
          </div>
        </div>
      </section>

      {/* Main Dual Column Workspace */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left: Upload & File Queue Workspace (8 cols) */}
        <div className="lg:col-span-8 flex flex-col gap-5">
          {/* Drop Area */}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              if (e.dataTransfer.files?.length) {
                handleFiles(e.dataTransfer.files);
              }
            }}
            onClick={() => fileInputRef.current?.click()}
            className={`relative group cursor-pointer transition-all duration-300 rounded-2xl p-8 sm:p-10 flex flex-col items-center justify-center text-center border-2 border-dashed ${
              dragOver
                ? "border-secondary bg-secondary/5 shadow-[0_0_30px_rgba(76,215,246,0.15)]"
                : "border-white/[0.12] bg-surface-container-low hover:bg-surface-container hover:border-white/[0.2] shadow-md"
            }`}
          >
            <div className="w-14 h-14 rounded-2xl bg-surface-container-highest border border-white/[0.06] flex items-center justify-center mb-4 shadow-inner group-hover:scale-105 transition-transform text-secondary">
              <CloudUpload size={28} />
            </div>
            <h2 className="font-headline-md text-on-surface mb-1">
              Stage Files for Instant Payload Emission
            </h2>
            <p className="font-body-md text-on-surface-variant max-w-lg mb-4">
              Drag files here, browse device, or paste (
              <kbd className="px-1.5 py-0.5 bg-surface-container-highest text-on-surface rounded font-mono-telemetry border border-white/[0.06]">
                Ctrl+V
              </kbd>{" "}
              /{" "}
              <kbd className="px-1.5 py-0.5 bg-surface-container-highest text-on-surface rounded font-mono-telemetry border border-white/[0.06]">
                ⌘+V
              </kbd>
              ) screenshots directly.
            </p>
            <div className="flex items-center gap-3 font-body-sm">
              <button
                type="button"
                className="px-4 py-2 rounded-lg bg-surface-container-highest text-on-surface hover:bg-primary hover:text-on-primary transition-all font-medium flex items-center gap-2 shadow-sm border border-white/[0.06]"
              >
                <FolderOpen size={16} />
                <span>Select from Disk</span>
              </button>
              <span className="text-outline-variant font-mono-telemetry">
                Direct Browser-to-R2 Transfer
              </span>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files) handleFiles(e.target.files);
              }}
            />
          </div>

          {/* Staged Queue Manifest */}
          {stagedFiles.length > 0 && (
            <div className="rounded-2xl bg-surface-container-low p-5 sm:p-6 border border-white/[0.08] flex flex-col gap-4 shadow-sm">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="font-headline-md text-on-surface">Payload Queue</span>
                  <span className="px-2 py-0.5 rounded bg-surface-container-high text-secondary font-mono-telemetry font-medium">
                    {stagedFiles.length} item{stagedFiles.length > 1 ? "s" : ""}
                  </span>
                </div>
                {!isUploadingBatch && (
                  <button
                    onClick={clearAllStaged}
                    className="font-body-sm text-on-surface-variant hover:text-error transition-colors flex items-center gap-1.5 cursor-pointer"
                  >
                    <Trash2 size={14} />
                    <span>Clear Staging</span>
                  </button>
                )}
              </div>

              {/* File Item Rows */}
              <div className="flex flex-col gap-2">
                {stagedFiles.map((item) => (
                  <div
                    key={item.id}
                    className="flex flex-col gap-2 p-3.5 rounded-xl bg-surface-container border border-white/[0.04] transition-all hover:bg-surface-container-high"
                  >
                    <div className="flex items-center justify-between gap-3 min-w-0">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-10 h-10 rounded-lg bg-surface-container-highest border border-white/[0.06] flex items-center justify-center shrink-0">
                          <FileTypeIcon name={item.name} size={20} />
                        </div>
                        <div className="flex flex-col min-w-0">
                          <span className="font-body-md font-medium text-on-surface truncate" title={item.name}>
                            {item.name}
                          </span>
                          <div className="flex items-center gap-2 font-mono-telemetry text-on-surface-variant">
                            <span>{formatSize(item.size)}</span>
                            <span>•</span>
                            <span
                              className={
                                item.status === "done"
                                  ? "text-tertiary flex items-center gap-1"
                                  : item.status === "error"
                                  ? "text-error"
                                  : item.status === "uploading"
                                  ? "text-secondary flex items-center gap-1"
                                  : "text-on-surface-variant"
                              }
                            >
                              {item.status === "done" && (
                                <>
                                  <Check size={12} /> Ready
                                </>
                              )}
                              {item.status === "error" && (item.error || "Failed")}
                              {item.status === "uploading" && (
                                <>
                                  <Loader2 size={12} className="animate-spin" /> Uploading (
                                  {Math.round(item.progress)}%)
                                </>
                              )}
                              {item.status === "idle" && "Staged"}
                            </span>
                          </div>
                        </div>
                      </div>

                      <button
                        onClick={() => removeStagedItem(item.id)}
                        disabled={item.status === "uploading" && isUploadingBatch}
                        className="p-1.5 text-on-surface-variant hover:text-error rounded-lg hover:bg-surface-container-lowest transition-colors cursor-pointer disabled:opacity-30"
                        title="Remove payload segment"
                        type="button"
                      >
                        <X size={16} />
                      </button>
                    </div>

                    {/* Per-file progress bar when uploading */}
                    {item.status === "uploading" && (
                      <div className="w-full bg-surface-container-highest h-1.5 rounded-full overflow-hidden">
                        <div
                          className="bg-secondary h-full rounded-full transition-all duration-150"
                          style={{ width: `${item.progress}%` }}
                        />
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {/* Capacity Progress Telemetry Meter */}
              <div className="mt-2 pt-4 border-t border-white/[0.06] flex flex-col gap-2">
                <div className="flex items-center justify-between font-mono-telemetry">
                  <span className="text-on-surface-variant flex items-center gap-1.5">
                    <MemoryStick size={14} className="text-secondary" />
                    <span>CAPACITY ALLOCATION</span>
                  </span>
                  <span className="text-on-surface font-medium">
                    {formatSize(totalStagedBytes)} of 250 MB used ({Math.round(usagePct)}%)
                  </span>
                </div>

                <div className="w-full h-2 rounded-full bg-surface-container-highest overflow-hidden relative">
                  <div
                    className={`h-full transition-all duration-300 rounded-full ${
                      usagePct > 90 ? "bg-error" : "bg-secondary"
                    }`}
                    style={{ width: `${usagePct}%` }}
                  />
                </div>

                <div className="flex items-center justify-between font-mono-telemetry text-on-surface-variant text-xs">
                  <span>{formatSize(remainingBytes)} remaining allocation</span>
                  <span className="text-outline-variant">Hard Cap: 250.0 MB</span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Right: Expiration Rules & Trigger Panel (4 cols) */}
        <div className="lg:col-span-4 flex flex-col gap-5">
          {/* Ephemeral TTL Configuration Card */}
          <div className="rounded-2xl bg-surface-container-low p-5 sm:p-6 border border-white/[0.08] flex flex-col gap-4 shadow-sm">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-on-surface">
                <Layers size={18} className="text-secondary" />
                <h3 className="font-headline-md">Self-Destruct TTL</h3>
              </div>
              <span className="font-label-caps text-secondary bg-surface-container px-2 py-0.5 rounded border border-white/[0.04] uppercase">
                Zero-Trace
              </span>
            </div>

            <p className="font-body-sm text-on-surface-variant leading-relaxed">
              Targeted Cloudflare R2 files purge irreversibly once the interval lapses.
            </p>

            {/* Duration Selector Options */}
            <div className="flex flex-col gap-1.5">
              {EXPIRY_OPTIONS.map((opt) => {
                const isSelected = expirySeconds === opt.seconds;
                return (
                  <label
                    key={opt.seconds}
                    className={`flex items-center justify-between p-2.5 rounded-xl border transition-all cursor-pointer ${
                      isSelected
                        ? "bg-surface-container-highest border-secondary/40 text-on-surface shadow-sm"
                        : "bg-surface-container border-transparent hover:bg-surface-container-high text-on-surface-variant"
                    } ${uploadStarted ? "opacity-60 cursor-not-allowed" : ""}`}
                  >
                    <div className="flex items-center gap-2.5">
                      <input
                        type="radio"
                        name="expiry"
                        value={opt.seconds}
                        checked={isSelected}
                        disabled={uploadStarted}
                        onChange={() => setExpirySeconds(opt.seconds)}
                        className="accent-secondary w-4 h-4 cursor-pointer"
                      />
                      <span className="font-body-md font-medium text-on-surface">{opt.label}</span>
                    </div>
                    {opt.seconds === 3600 && (
                      <span className="font-mono-telemetry text-secondary text-xs">Recommended</span>
                    )}
                  </label>
                );
              })}
            </div>

            {/* Locking Warning Alert */}
            <div className="p-3 rounded-xl bg-surface-container border border-white/[0.04] flex items-start gap-2.5">
              <Lock size={16} className="text-secondary shrink-0 mt-0.5" />
              <div className="flex flex-col gap-0.5">
                <span className="font-label-caps uppercase text-secondary font-bold">Locking Rule</span>
                <p className="font-body-sm text-on-surface-variant leading-relaxed">
                  {uploadStarted
                    ? "Expiry locked for this batch to ensure consistent download lifetimes."
                    : "Expiry locks permanently the moment the first upload begins to ensure batch link consistency."}
                </p>
              </div>
            </div>
          </div>

          {/* Upload Execution Card */}
          <div className="rounded-2xl bg-surface-container-low p-5 sm:p-6 border border-white/[0.08] flex flex-col gap-4 shadow-sm">
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between font-mono-telemetry">
                <span className="text-on-surface-variant">SECURITY PROTOCOL</span>
                <span className="text-tertiary">AES-GCM-256</span>
              </div>
              <div className="flex items-center justify-between font-mono-telemetry">
                <span className="text-on-surface-variant">TARGET PEER</span>
                <span className="text-on-surface">Connected Recipient</span>
              </div>
              <div className="flex items-center justify-between font-mono-telemetry">
                <span className="text-on-surface-variant">STORAGE ENGINE</span>
                <span className="text-secondary">R2 Object Storage</span>
              </div>
            </div>

            {/* Primary Action Button */}
            <button
              onClick={triggerBatchUpload}
              disabled={stagedFiles.length === 0 || isUploadingBatch || isAllDone}
              className="w-full py-3.5 px-4 rounded-xl bg-secondary text-on-secondary font-headline-md font-semibold hover:bg-secondary-fixed transition-all flex items-center justify-center gap-2 shadow-lg active:scale-[0.99] disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              {isUploadingBatch ? (
                <>
                  <Loader2 size={20} className="animate-spin text-on-secondary" />
                  <span>Streaming to R2...</span>
                </>
              ) : isAllDone ? (
                <>
                  <Check size={20} />
                  <span>Transfer Completed</span>
                </>
              ) : (
                <>
                  <CloudUpload size={20} />
                  <span>
                    {idleCount > 0
                      ? `Begin Direct Upload (${idleCount} file${idleCount > 1 ? "s" : ""})`
                      : "Stage Files Above"}
                  </span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
