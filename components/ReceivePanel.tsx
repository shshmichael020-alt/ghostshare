"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { QRCodeSVG } from "qrcode.react";
import PinDisplay from "./PinDisplay";
import { FileTypeIcon } from "./FileTypeIcon";
import ToastStack from "./ToastStack";
import { useToasts } from "@/lib/useToasts";
import { formatSize, formatCountdown } from "@/lib/format";
import {
  Key,
  QrCode,
  Copy,
  Check,
  Share2,
  Download,
  RefreshCw,
  Info,
  ShieldCheck,
  CheckCircle2,
  ExternalLink,
  Layers,
} from "lucide-react";

export type StoredFile = {
  objectKey: string;
  downloadUrl: string;
  name: string;
  size: number;
  uploadedAt: number;
};

interface ReceivePanelProps {
  onOpenSecurity?: () => void;
}

export default function ReceivePanel({ onOpenSecurity }: ReceivePanelProps) {
  const [code, setCode] = useState<string | null>(null);
  const [files, setFiles] = useState<StoredFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [initialTtl, setInitialTtl] = useState<number>(3600);
  const [copiedLink, setCopiedLink] = useState(false);
  const [downloadingAll, setDownloadingAll] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const knownCountRef = useRef(0);
  const { toasts, push, dismiss } = useToasts();

  const startSession = useCallback(async () => {
    setError(null);
    setExpired(false);
    setFiles([]);
    setCode(null);
    setRemaining(null);
    knownCountRef.current = 0;

    try {
      const res = await fetch("/api/session", { method: "POST" });
      if (!res.ok) {
        const errData = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(errData.error || "Could not start receiving session");
      }
      const data = (await res.json()) as { code: string; expiresAt?: number };
      setCode(data.code);
      if (data.expiresAt) {
        const rem = Math.max(0, Math.round((data.expiresAt - Date.now()) / 1000));
        setRemaining(rem);
        setInitialTtl(rem || 3600);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  // Initialize session on mount
  useEffect(() => {
    let cancelled = false;
    async function init() {
      if (!cancelled) {
        await startSession();
      }
    }
    init();

    return () => {
      cancelled = true;
      if (pollRef.current) clearInterval(pollRef.current);
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, [startSession]);

  // Polling for incoming files from sender
  useEffect(() => {
    if (!code) return;
    if (pollRef.current) clearInterval(pollRef.current);

    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/session/${code}`, { cache: "no-store" });
        if (res.status === 404 || res.status === 410) {
          setExpired(true);
          if (pollRef.current) clearInterval(pollRef.current);
          return;
        }
        if (!res.ok) return;

        const data = (await res.json()) as {
          files?: StoredFile[];
          remainingSeconds?: number;
          ttlSeconds?: number;
        };

        const newFiles: StoredFile[] = data.files ?? [];
        if (newFiles.length > knownCountRef.current) {
          const arrived = newFiles.slice(knownCountRef.current);
          arrived.forEach((f) => {
            push(`Incoming file: ${f.name} is ready for download`, "success");
          });
          if (typeof document !== "undefined") {
            document.title = `(${newFiles.length}) Ready — GhostShare`;
          }
        }
        knownCountRef.current = newFiles.length;
        setFiles(newFiles);

        if (typeof data.remainingSeconds === "number") {
          setRemaining(data.remainingSeconds);
        }
        if (typeof data.ttlSeconds === "number") {
          setInitialTtl(data.ttlSeconds);
        }
      } catch {
        // Transient network error, keep polling
      }
    }, 2500);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [code, push]);

  // 1-second countdown ticker
  useEffect(() => {
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = setInterval(() => {
      setRemaining((r) => {
        if (r === null) return null;
        if (r <= 1) {
          setExpired(true);
          return 0;
        }
        return r - 1;
      });
    }, 1000);

    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, [code]);

  const qrValue =
    typeof window !== "undefined" && code ? `${window.location.origin}/?mode=send&code=${code}` : "";

  async function copyLink() {
    if (!qrValue) return;
    try {
      await navigator.clipboard.writeText(qrValue);
      setCopiedLink(true);
      push("Direct pairing link copied to clipboard", "default");
      setTimeout(() => setCopiedLink(false), 2000);
    } catch {
      // ignore
    }
  }

  async function shareLink() {
    if (!qrValue) return;
    if (navigator.share) {
      try {
        await navigator.share({
          title: "GhostShare File Transfer",
          text: `Connect to GhostShare session with code ${code}`,
          url: qrValue,
        });
      } catch {
        // User dismissed share dialog
      }
    } else {
      copyLink();
    }
  }

  // Trigger sequential download of all ready files
  async function downloadAllFiles() {
    if (files.length === 0 || downloadingAll) return;
    setDownloadingAll(true);
    push(`Downloading ${files.length} file${files.length > 1 ? "s" : ""}...`, "default");

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const link = document.createElement("a");
      link.href = file.downloadUrl;
      link.download = file.name;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      // 500ms delay between files to avoid aggressive popup blockers
      if (i < files.length - 1) {
        await new Promise((r) => setTimeout(r, 600));
      }
    }
    setDownloadingAll(false);
  }

  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);

  // Calculate countdown SVG circle progress
  const progressRatio = remaining !== null && initialTtl > 0 ? Math.min(1, remaining / initialTtl) : 1;
  const strokeDashoffset = 56.5 * (1 - progressRatio);

  return (
    <div className="w-full flex flex-col gap-6 relative">
      <ToastStack toasts={toasts} onDismiss={dismiss} />

      {/* Screen Header with Telemetry */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="font-label-caps text-secondary tracking-widest uppercase">
              Inbound Session Channel
            </span>
            <span className="text-outline-variant font-mono-telemetry">•</span>
            <span className="font-mono-telemetry text-on-surface-variant">
              {code ? `SESSION_ID #cf-${code.slice(0, 4)}-${code.slice(4)}` : "INITIALIZING..."}
            </span>
          </div>
          <h1 className="font-display-hero text-on-surface tracking-tight">Receive Files</h1>
          <p className="font-body-md text-on-surface-variant max-w-xl">
            Ephemeral peer tunnel ready. Data flows directly into private Cloudflare R2 buckets without transit logs
            or server body proxies.
          </p>
        </div>

        {/* Live Status indicator */}
        <div className="flex items-center gap-2.5 self-start md:self-auto">
          <div className="flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-surface-container-high border border-white/[0.06] shadow-sm">
            <span className="relative flex h-2 w-2">
              <span
                className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${
                  files.length > 0 ? "bg-tertiary" : "bg-secondary"
                }`}
              />
              <span
                className={`relative inline-flex rounded-full h-2 w-2 ${
                  files.length > 0 ? "bg-tertiary" : "bg-secondary"
                }`}
              />
            </span>
            <span
              className={`font-mono-telemetry font-medium ${
                files.length > 0 ? "text-tertiary" : "text-secondary"
              }`}
            >
              {files.length > 0
                ? `Synchronized • ${files.length} File${files.length > 1 ? "s" : ""} Available`
                : "Awaiting Sender Connection..."}
            </span>
          </div>
        </div>
      </div>

      {error && (
        <div className="p-4 rounded-xl bg-error-container/20 border border-error/30 text-error flex items-center justify-between">
          <span className="font-body-sm">{error}</span>
          <button
            onClick={startSession}
            className="px-3 py-1 bg-surface-container-high hover:bg-surface-bright rounded text-xs text-on-surface font-medium transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {expired ? (
        /* Expired Session State */
        <div className="p-8 sm:p-12 rounded-2xl bg-surface-container-low border border-white/[0.08] shadow-xl flex flex-col items-center justify-center text-center gap-4">
          <div className="w-12 h-12 rounded-full bg-error-container/20 border border-error/30 flex items-center justify-center text-error">
            <RefreshCw size={22} />
          </div>
          <div className="space-y-1">
            <h2 className="font-headline-md text-on-surface">This Pairing Session Has Expired</h2>
            <p className="font-body-md text-on-surface-variant max-w-md">
              Pairing tokens and presigned links self-destruct once their time-to-live elapses to maintain
              zero-knowledge privacy.
            </p>
          </div>
          <button
            onClick={startSession}
            className="mt-2 flex items-center gap-2 px-5 py-2.5 rounded-lg bg-primary text-on-primary hover:bg-primary-container hover:text-on-primary-container font-body-sm font-medium transition-all shadow-md active:scale-95 cursor-pointer"
          >
            <RefreshCw size={16} />
            <span>Generate New Session</span>
          </button>
        </div>
      ) : files.length === 0 ? (
        /* STAGE A: Waiting for files / Pairing Hub */
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
          {/* Left Hero: Monospace Pairing Code Card */}
          <div className="lg:col-span-7 rounded-2xl bg-surface-container-low p-6 sm:p-8 flex flex-col justify-between border border-white/[0.08] shadow-xl relative overflow-hidden">
            <div className="absolute -right-16 -top-16 w-48 h-48 bg-primary/10 rounded-full blur-3xl pointer-events-none" />

            <div className="flex flex-col gap-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Key size={18} className="text-secondary" />
                  <span className="font-label-caps text-on-surface-variant uppercase">
                    Ephemeral 8-Digit Pairing Token
                  </span>
                </div>

                {/* Countdown pill with dynamic ring */}
                <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-surface-container-highest border border-white/[0.06] shadow-sm">
                  <svg className="w-3.5 h-3.5 -rotate-90" viewBox="0 0 24 24">
                    <circle
                      className="text-surface-container"
                      cx="12"
                      cy="12"
                      fill="none"
                      r="9"
                      stroke="currentColor"
                      strokeWidth="2.5"
                    />
                    <circle
                      className="text-tertiary transition-all duration-1000"
                      cx="12"
                      cy="12"
                      fill="none"
                      r="9"
                      stroke="currentColor"
                      strokeDasharray="56.5"
                      strokeDashoffset={strokeDashoffset}
                      strokeWidth="2.5"
                    />
                  </svg>
                  <span className="font-mono-telemetry text-on-surface font-semibold tracking-wider">
                    {remaining !== null ? `Expires in ${formatCountdown(remaining)}` : "Generating..."}
                  </span>
                </div>
              </div>

              {/* Segmented Pin Display Component */}
              <PinDisplay code={code} onCopy={() => push("Pairing code copied to clipboard", "default")} />

              <div className="flex flex-wrap items-center justify-between gap-2 text-on-surface-variant pt-1 border-t border-white/[0.04]">
                <span className="font-mono-telemetry">HANDSHAKE PROTOCOL: TLS 1.3 / AES-GCM-256</span>
                <span className="font-mono-telemetry text-tertiary">BURNS UPON RECEPTION</span>
              </div>
            </div>

            <div className="mt-6 pt-4 flex items-center gap-2 text-on-surface-variant border-t border-white/[0.06]">
              <Info size={16} className="text-secondary shrink-0" />
              <p className="font-body-sm">
                Enter this temporary code into GhostShare on the sending device or scan the QR code to pair.
              </p>
            </div>
          </div>

          {/* Right Hero: High-Precision QR Code Card */}
          <div className="lg:col-span-5 rounded-2xl bg-surface-container-low p-6 sm:p-8 flex flex-col items-center justify-between border border-white/[0.08] shadow-xl">
            <div className="w-full flex items-center justify-between">
              <span className="font-label-caps text-on-surface-variant flex items-center gap-1.5 uppercase">
                <QrCode size={16} className="text-secondary" />
                Direct Device Link
              </span>
              <span className="font-mono-telemetry text-outline bg-surface-container px-2 py-0.5 rounded">
                AUTO-SYNC
              </span>
            </div>

            {/* QR Canvas Container with strict high-contrast compliance */}
            <div className="my-5 p-4 bg-white rounded-2xl shadow-2xl flex flex-col items-center justify-center transition-transform hover:scale-[1.02]">
              {code ? (
                <QRCodeSVG
                  value={qrValue}
                  size={190}
                  level="M"
                  bgColor="#ffffff"
                  fgColor="#0c0e12"
                  className="rounded"
                />
              ) : (
                <div className="w-[190px] h-[190px] bg-neutral-200 animate-pulse rounded" />
              )}
            </div>

            {/* Link & Share Actions */}
            <div className="w-full flex items-center justify-center gap-2">
              <button
                onClick={copyLink}
                className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-surface-container-highest hover:bg-surface-bright text-on-surface font-body-sm transition-colors cursor-pointer border border-white/[0.06]"
              >
                {copiedLink ? <Check size={14} className="text-tertiary" /> : <Copy size={14} />}
                <span>{copiedLink ? "Link Copied" : "Copy Link"}</span>
              </button>
              <button
                onClick={shareLink}
                className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-surface-container-highest hover:bg-surface-bright text-on-surface font-body-sm transition-colors cursor-pointer border border-white/[0.06]"
              >
                <Share2 size={14} />
                <span>Share URL</span>
              </button>
            </div>
          </div>
        </div>
      ) : (
        /* STAGE B: Active Live Incoming Stream & Downloads Hub */
        <div className="flex flex-col gap-6">
          {/* Bento Overview Card */}
          <div className="bg-surface-container-low rounded-2xl p-6 sm:p-7 border border-white/[0.08] shadow-xl flex flex-col gap-5">
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
              <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-xl bg-secondary/10 text-secondary border border-secondary/20 flex items-center justify-center">
                  <Layers size={22} />
                </div>
                <div>
                  <h2 className="font-headline-md text-on-surface font-medium">
                    Receiving Batch ({files.length} File{files.length > 1 ? "s" : ""} Ready)
                  </h2>
                  <p className="font-body-sm text-on-surface-variant">
                    Direct R2 signed GET transfer • Zero Worker proxy overhead
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-6">
                <div className="text-right">
                  <span className="font-mono-telemetry text-on-surface-variant block uppercase">Total Size</span>
                  <span className="font-mono-data text-secondary font-semibold">{formatSize(totalBytes)}</span>
                </div>
                <div className="text-right">
                  <span className="font-mono-telemetry text-on-surface-variant block uppercase">Time Remaining</span>
                  <span className="font-mono-data text-on-surface font-medium">
                    {remaining !== null ? formatCountdown(remaining) : "Active"}
                  </span>
                </div>
                <button
                  onClick={downloadAllFiles}
                  disabled={downloadingAll}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg bg-secondary text-on-secondary hover:bg-secondary-fixed font-body-sm font-semibold transition-all shadow-md active:scale-95 cursor-pointer disabled:opacity-50"
                >
                  <Download size={16} />
                  <span>{downloadingAll ? "Downloading..." : "Download All"}</span>
                </button>
              </div>
            </div>

            {/* Low-Level Telemetry Strip */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2 border-t border-white/[0.06]">
              <div className="bg-surface-container px-3 py-2 rounded-lg border border-white/[0.04]">
                <span className="font-label-caps text-on-surface-variant uppercase block">Target Bucket</span>
                <span className="font-mono-telemetry text-on-surface">ghostshare-files</span>
              </div>
              <div className="bg-surface-container px-3 py-2 rounded-lg border border-white/[0.04]">
                <span className="font-label-caps text-on-surface-variant uppercase block">Transport</span>
                <span className="font-mono-telemetry text-on-surface">TLS 1.3 / Direct R2</span>
              </div>
              <div className="bg-surface-container px-3 py-2 rounded-lg border border-white/[0.04]">
                <span className="font-label-caps text-on-surface-variant uppercase block">Signing Auth</span>
                <span className="font-mono-telemetry text-on-surface">AWS SigV4 HMAC</span>
              </div>
              <div className="bg-surface-container px-3 py-2 rounded-lg border border-white/[0.04]">
                <span className="font-label-caps text-on-surface-variant uppercase block">TTL Retention</span>
                <span className="font-mono-telemetry text-tertiary">
                  {remaining !== null ? `${formatCountdown(remaining)} remaining` : "Active"}
                </span>
              </div>
            </div>
          </div>

          {/* Incoming File Manifest List */}
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between px-1">
              <div className="flex items-center gap-2">
                <span className="font-label-caps uppercase text-on-surface-variant">Incoming File Manifest</span>
                <span className="bg-surface-container-high px-2 py-0.5 rounded font-mono-telemetry text-on-surface">
                  {files.length} Item{files.length > 1 ? "s" : ""}
                </span>
              </div>
              <span className="font-mono-telemetry text-on-surface-variant">Egress Signed: HMAC-SHA256</span>
            </div>

            <div className="flex flex-col gap-2.5">
              {files.map((file) => (
                <div
                  key={file.objectKey}
                  className="bg-surface-container-low hover:bg-surface-container transition-all rounded-xl p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 border border-white/[0.06] shadow-sm"
                >
                  <div className="flex items-start gap-3.5 min-w-0">
                    <div className="w-10 h-10 rounded-lg bg-surface-container-high flex items-center justify-center shrink-0 border border-white/[0.06]">
                      <FileTypeIcon name={file.name} size={22} />
                    </div>
                    <div className="flex flex-col min-w-0 gap-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-body-md font-medium text-on-surface truncate" title={file.name}>
                          {file.name}
                        </span>
                        <span className="bg-surface-container-high px-2 py-0.5 rounded font-mono-telemetry text-on-surface-variant">
                          {formatSize(file.size)}
                        </span>
                        <span className="inline-flex items-center gap-1 bg-tertiary/10 text-tertiary px-2 py-0.5 rounded font-label-caps border border-tertiary/20">
                          <CheckCircle2 size={12} /> READY
                        </span>
                      </div>
                      <div className="flex items-center gap-2 font-mono-telemetry text-on-surface-variant">
                        <span>Object Key:</span>
                        <span className="truncate max-w-[200px] sm:max-w-xs text-on-surface">
                          {file.objectKey}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0 self-end sm:self-auto">
                    <a
                      href={file.downloadUrl}
                      download={file.name}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="px-4 py-2 rounded-lg bg-secondary text-on-secondary font-body-sm font-medium hover:bg-secondary-fixed transition-colors flex items-center gap-2 shadow-sm cursor-pointer"
                    >
                      <Download size={16} />
                      <span>Download</span>
                    </a>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Footer Specs Quick Link */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-4 border-t border-white/[0.04] text-on-surface-variant font-body-sm">
        <div className="flex items-center gap-2">
          <ShieldCheck size={16} className="text-secondary" />
          <span>Zero logs · Raw binary fidelity · Automatic edge purge</span>
        </div>
        {onOpenSecurity && (
          <button
            onClick={onOpenSecurity}
            className="text-xs font-mono-telemetry text-primary hover:text-primary-fixed transition-colors flex items-center gap-1 cursor-pointer"
          >
            <span>View Architecture Specifications</span>
            <ExternalLink size={12} />
          </button>
        )}
      </div>
    </div>
  );
}
