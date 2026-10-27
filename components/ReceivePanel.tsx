"use client";

import { useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import PinDisplay from "./PinDisplay";
import { FileTypeIcon } from "./FileTypeIcon";
import { formatSize, formatCountdown } from "@/lib/format";
import { EXPIRY_OPTIONS, DEFAULT_TTL_SECONDS } from "@/lib/constants";
import { isOpfsSupported } from "@/lib/opfs";
import { useGhostSession } from "@/context/SessionContext";
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
  Radio,
  AlertTriangle,
  XCircle,
  Loader2,
  Clock,
  HardDrive,
} from "lucide-react";

interface ReceivePanelProps {
  onOpenSecurity?: () => void;
}

export default function ReceivePanel({ onOpenSecurity }: ReceivePanelProps) {
  const {
    code,
    connStatus,
    error,
    natWarning,
    remainingTtl: remaining,
    initialTtl,
    copiedLink,
    startHostSession,
    updateExpiryWindow,
    copyLink,
    shareLink,
    pendingApproval,
    handleAcceptTransfer,
    handleDeclineTransfer,
    activeReceiving,
    receivedFiles,
    downloadAllFiles,
    storageCapability,
    turnConfigured,
    candidatePair,
    connectionDiagnostic,
  } = useGhostSession();

  const [downloadingAll, setDownloadingAll] = useState(false);
  const expired = remaining !== null && remaining <= 0;
  const hasMountedRef = useRef<boolean>(false);

  // Initialize host session on mount if no active session
  useEffect(() => {
    if (hasMountedRef.current) return;
    hasMountedRef.current = true;
    if ((connStatus === "idle" || connStatus === "disconnected") && !code) {
      startHostSession(DEFAULT_TTL_SECONDS);
    }
  }, [connStatus, code, startHostSession]);

  const handleDownloadAll = async () => {
    setDownloadingAll(true);
    try {
      await downloadAllFiles();
    } finally {
      setDownloadingAll(false);
    }
  };

  const qrValue =
    typeof window !== "undefined" && code ? `${window.location.origin}/?mode=send&code=${code}` : "";

  const totalBytesReceived = receivedFiles.reduce((sum, f) => sum + f.size, 0);
  const progressRatio = remaining !== null && initialTtl > 0 ? Math.min(1, remaining / initialTtl) : 1;
  const strokeDashoffset = 56.5 * (1 - progressRatio);

  return (
    <div className="w-full flex flex-col gap-6 relative">
      {/* Screen Header with Telemetry */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="font-label-caps text-secondary tracking-widest uppercase">
              WebRTC Direct P2P Tunnel
            </span>
            <span className="text-outline-variant font-mono-telemetry">•</span>
            <span className="font-mono-telemetry text-on-surface-variant">
              {code ? `CHANNEL #cf-${code.slice(0, 4)}-${code.slice(4)}` : "INITIALIZING..."}
            </span>
          </div>
          <h1 className="font-display-hero text-on-surface tracking-tight">Receive Files</h1>
          <p className="font-body-md text-on-surface-variant max-w-xl">
            Ephemeral peer tunnel ready. Data flows directly browser-to-browser via WebRTC SCTP data channels with direct
            disk streaming and zero cloud storage.
          </p>
        </div>

        {/* Live Status indicator */}
        <div className="flex items-center gap-2.5 self-start md:self-auto">
          <div className="flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-surface-container-high border border-white/[0.06] shadow-sm">
            <span className="relative flex h-2 w-2">
              <span
                className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${
                  connStatus === "connected"
                    ? "bg-tertiary"
                    : connStatus === "connecting" || connStatus === "reconnecting"
                    ? "bg-primary"
                    : connStatus === "failed"
                    ? "bg-error"
                    : "bg-secondary"
                }`}
              />
              <span
                className={`relative inline-flex rounded-full h-2 w-2 ${
                  connStatus === "connected"
                    ? "bg-tertiary"
                    : connStatus === "connecting" || connStatus === "reconnecting"
                    ? "bg-primary"
                    : connStatus === "failed"
                    ? "bg-error"
                    : "bg-secondary"
                }`}
              />
            </span>
            <span
              className={`font-mono-telemetry font-medium ${
                connStatus === "connected"
                  ? "text-tertiary"
                  : connStatus === "connecting"
                  ? "text-primary"
                  : connStatus === "reconnecting"
                  ? "text-primary"
                  : connStatus === "failed"
                  ? "text-error"
                  : "text-secondary"
              }`}
            >
              {connStatus === "connected"
                ? "P2P Bridge Connected"
                : connStatus === "connecting"
                ? "Negotiating Handshake..."
                : connStatus === "reconnecting"
                ? "Reconnecting P2P Tunnel..."
                : connStatus === "failed"
                ? "Connection Failed"
                : "Awaiting Sender Connection..."}
            </span>
          </div>
        </div>
      </div>

      {/* NAT Warning Diagnostic Alert */}
      {natWarning && (
        <div className="p-4 rounded-xl bg-error-container/20 border border-error/30 text-error flex items-start gap-3">
          <AlertTriangle size={18} className="shrink-0 mt-0.5" />
          <div className="flex flex-col gap-1 text-xs sm:text-sm">
            <span className="font-semibold">NAT Traversal Notice</span>
            <p className="font-body-sm leading-relaxed">{natWarning}</p>
          </div>
        </div>
      )}

      {error && (
        <div className="p-4 rounded-xl bg-error-container/20 border border-error/30 text-error flex items-center justify-between">
          <span className="font-body-sm">{error}</span>
          <button
            onClick={() => startHostSession(initialTtl)}
            className="px-3 py-1 bg-surface-container-high hover:bg-surface-bright rounded text-xs text-on-surface font-medium transition-colors cursor-pointer"
          >
            Retry
          </button>
        </div>
      )}

      {/* Explicit Receiver Approval Prompt Banner */}
      {pendingApproval && (
        <div className="p-6 rounded-2xl bg-surface-container-high border-2 border-secondary shadow-2xl flex flex-col gap-4 animate-in fade-in slide-in-from-top-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-secondary/10 border border-secondary/20 flex items-center justify-center text-secondary">
                <Radio size={20} className="animate-pulse" />
              </div>
              <div>
                <h3 className="font-headline-md text-on-surface">Incoming Transfer Authorization</h3>
                <p className="font-body-sm text-on-surface-variant">
                  A connected peer wants to stream {pendingApproval.files.length} file(s) directly to your device.
                </p>
              </div>
            </div>
            <span className="font-mono-telemetry text-secondary bg-secondary/10 px-2.5 py-1 rounded border border-secondary/20">
              APPROVAL REQUIRED
            </span>
          </div>

          <div className="bg-surface-container rounded-xl p-3 max-h-48 overflow-y-auto flex flex-col gap-2 border border-white/[0.04]">
            {pendingApproval.files.map((file) => (
              <div key={file.id} className="flex items-center justify-between text-xs sm:text-sm">
                <span className="text-on-surface font-medium truncate max-w-xs">{file.name}</span>
                <span className="font-mono-telemetry text-on-surface-variant">{formatSize(file.size)}</span>
              </div>
            ))}
          </div>

          {/* Storage Capability & Quota Details */}
          {(() => {
            const batchTotal = pendingApproval.files.reduce((acc, f) => acc + f.size, 0);
            const isQuotaExceeded = storageCapability?.available !== undefined && batchTotal > storageCapability.available;
            return (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between text-xs text-on-surface-variant font-mono-telemetry bg-surface-container/60 p-2.5 rounded-lg border border-white/[0.04]">
                  <span className="flex items-center gap-1.5">
                    <HardDrive size={13} className="text-secondary" />
                    Storage: {storageCapability?.isOpfsSupported ? "OPFS Direct-to-Disk" : "RAM Buffer (100 MB max)"}
                  </span>
                  {storageCapability?.available !== undefined && (
                    <span>Device Free: {formatSize(storageCapability.available)}</span>
                  )}
                </div>
                {isQuotaExceeded && (
                  <div className="p-3 rounded-lg bg-error-container/20 border border-error/30 text-error flex items-center gap-2 text-xs">
                    <AlertTriangle size={15} className="shrink-0" />
                    <span>
                      Insufficient device storage: incoming batch requires {formatSize(batchTotal)}, but only {formatSize(storageCapability.available!)} is free.
                    </span>
                  </div>
                )}
              </div>
            );
          })()}

          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              onClick={handleDeclineTransfer}
              className="px-4 py-2 rounded-lg bg-surface-container-lowest hover:bg-surface-container text-on-surface-variant hover:text-error transition-colors font-body-sm flex items-center gap-1.5 border border-white/[0.06] cursor-pointer"
            >
              <XCircle size={16} />
              <span>Decline</span>
            </button>
            <button
              onClick={handleAcceptTransfer}
              className="px-5 py-2 rounded-lg bg-secondary text-on-secondary hover:bg-secondary-fixed transition-colors font-body-sm font-semibold flex items-center gap-1.5 shadow-md active:scale-95 cursor-pointer"
            >
              <CheckCircle2 size={16} />
              <span>Accept &amp; Stream Files</span>
            </button>
          </div>
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
              Signaling tokens and peer offers self-destruct once their time-to-live elapses to prevent stale connection attempts.
            </p>
          </div>
          <button
            onClick={() => startHostSession(initialTtl)}
            className="mt-2 flex items-center gap-2 px-5 py-2.5 rounded-lg bg-primary text-on-primary hover:bg-primary-container hover:text-on-primary-container font-body-sm font-medium transition-all shadow-md active:scale-95 cursor-pointer"
          >
            <RefreshCw size={16} />
            <span>Generate New Session</span>
          </button>
        </div>
      ) : receivedFiles.length === 0 && !activeReceiving ? (
        /* STAGE A: Waiting for files / Pairing Hub */
        <div className="flex flex-col gap-5">
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
                <PinDisplay code={code} onCopy={copyLink} />

                <div className="flex flex-wrap items-center justify-between gap-2 text-on-surface-variant pt-1 border-t border-white/[0.04]">
                  <span className="font-mono-telemetry">TRANSPORT: WebRTC DataChannel (SCTP)</span>
                  <span className="font-mono-telemetry text-tertiary">
                    {isOpfsSupported() ? "OPFS DISK STREAMING" : "BLOB RAM CACHE"}
                  </span>
                </div>
              </div>

              <div className="mt-6 p-3.5 rounded-xl bg-secondary/10 border border-secondary/20 flex items-start gap-2.5 text-on-surface">
                <Info size={18} className="text-secondary shrink-0 mt-0.5" />
                <div className="text-xs sm:text-sm font-body-sm text-on-surface-variant">
                  <span className="font-semibold text-secondary">Keep this screen open:</span> Open GhostShare on your other device, switch to <strong className="text-on-surface underline">Send Files</strong>, and enter this 8-digit code (or scan the QR code).
                </div>
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

          {/* User Expiry Configuration Bar (Default 1 Hour) */}
          <div className="p-4 rounded-xl bg-surface-container-low border border-white/[0.06] flex flex-col sm:flex-row items-center justify-between gap-3 shadow-sm">
            <div className="flex items-center gap-2">
              <Clock size={16} className="text-secondary" />
              <span className="font-body-sm text-on-surface font-medium">Session Expiration Window:</span>
              <span className="font-mono-telemetry text-tertiary text-xs">
                (Default: 1 Hour • Adjustable)
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {EXPIRY_OPTIONS.map((opt) => (
                <button
                  key={opt.seconds}
                  onClick={() => updateExpiryWindow(opt.seconds)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-mono-telemetry transition-all cursor-pointer ${
                    initialTtl === opt.seconds
                      ? "bg-secondary text-on-secondary font-bold shadow-sm"
                      : "bg-surface-container hover:bg-surface-container-high text-on-surface-variant hover:text-on-surface"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
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
                    Received Manifest ({receivedFiles.length} File{receivedFiles.length > 1 ? "s" : ""} Ready)
                  </h2>
                  <p className="font-body-sm text-on-surface-variant">
                    Direct WebRTC SCTP stream • Streamed directly onto local disk via OPFS
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-6">
                <div className="text-right">
                  <span className="font-mono-telemetry text-on-surface-variant block uppercase">Total Size</span>
                  <span className="font-mono-data text-secondary font-semibold">{formatSize(totalBytesReceived)}</span>
                </div>
                <div className="text-right">
                  <span className="font-mono-telemetry text-on-surface-variant block uppercase">Tunnel State</span>
                  <span className="font-mono-data text-on-surface font-medium">
                    {connectionDiagnostic || (connStatus === "connected" ? "P2P Active" : "Sender Detached (Files Retained)")}
                  </span>
                </div>
                <button
                  onClick={handleDownloadAll}
                  disabled={receivedFiles.length === 0 || downloadingAll}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg bg-secondary text-on-secondary hover:bg-secondary-fixed font-body-sm font-semibold transition-all shadow-md active:scale-95 cursor-pointer disabled:opacity-50"
                >
                  <Download size={16} />
                  <span>{downloadingAll ? "Downloading..." : "Download All"}</span>
                </button>
              </div>
            </div>

            {/* In-Flight File Streaming Progress Box */}
            {activeReceiving && (
              <div className="p-4 rounded-xl bg-surface-container border border-secondary/30 flex flex-col gap-2.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Loader2 size={16} className="animate-spin text-secondary" />
                    <span className="font-body-md text-on-surface font-medium truncate max-w-sm">
                      {activeReceiving.status === "verifying"
                        ? `Verifying Disk Integrity & Completeness: ${activeReceiving.name}`
                        : `Streaming to Storage: ${activeReceiving.name}`}
                    </span>
                  </div>
                  <span className="font-mono-telemetry text-secondary text-xs">
                    {formatSize(activeReceiving.receivedBytes)} / {formatSize(activeReceiving.size)} (
                    {Math.round((activeReceiving.receivedBytes / activeReceiving.size) * 100)}%)
                  </span>
                </div>
                <div className="w-full h-2 rounded-full bg-surface-container-highest overflow-hidden">
                  <div
                    className="h-full bg-secondary transition-all duration-100 rounded-full"
                    style={{
                      width: `${Math.min(100, (activeReceiving.receivedBytes / activeReceiving.size) * 100)}%`,
                    }}
                  />
                </div>
              </div>
            )}

            {/* Low-Level Telemetry Strip */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2 border-t border-white/[0.06]">
              <div className="bg-surface-container px-3 py-2 rounded-lg border border-white/[0.04]">
                <span className="font-label-caps text-on-surface-variant uppercase block">Connection</span>
                <span className="font-mono-telemetry text-on-surface truncate block">
                  {candidatePair
                    ? candidatePair.isRelayed
                      ? "TURN Relay"
                      : `Direct P2P (${candidatePair.localCandidateType})`
                    : turnConfigured
                    ? "P2P + Relay Ready"
                    : "Direct STUN"}
                </span>
              </div>
              <div className="bg-surface-container px-3 py-2 rounded-lg border border-white/[0.04]">
                <span className="font-label-caps text-on-surface-variant uppercase block">Storage Engine</span>
                <span className="font-mono-telemetry text-tertiary truncate block">
                  {storageCapability?.isOpfsSupported ? "OPFS Direct Disk" : "RAM Buffer (100MB Max)"}
                </span>
              </div>
              <div className="bg-surface-container px-3 py-2 rounded-lg border border-white/[0.04]">
                <span className="font-label-caps text-on-surface-variant uppercase block">Free Quota</span>
                <span className="font-mono-telemetry text-on-surface truncate block">
                  {storageCapability?.available !== undefined ? formatSize(storageCapability.available) : "Unbounded / Local"}
                </span>
              </div>
              <div className="bg-surface-container px-3 py-2 rounded-lg border border-white/[0.04]">
                <span className="font-label-caps text-on-surface-variant uppercase block">Retention Window</span>
                <span className="font-mono-telemetry text-secondary truncate block">
                  {remaining !== null ? `${formatCountdown(remaining)} remaining` : "1 Hour Default"}
                </span>
              </div>
            </div>
          </div>

          {/* Incoming File Manifest List */}
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between px-1">
              <div className="flex items-center gap-2">
                <span className="font-label-caps uppercase text-on-surface-variant">Available Files</span>
                <span className="bg-surface-container-high px-2 py-0.5 rounded font-mono-telemetry text-on-surface">
                  {receivedFiles.length} Item{receivedFiles.length > 1 ? "s" : ""}
                </span>
              </div>
              <span className="font-mono-telemetry text-tertiary flex items-center gap-1">
                <HardDrive size={13} /> Staged in Local Sandbox
              </span>
            </div>

            <div className="flex flex-col gap-2.5">
              {receivedFiles.map((file) => (
                <div
                  key={file.id}
                  className="bg-surface-container-low hover:bg-surface-container transition-all rounded-xl p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 border border-white/[0.06] shadow-sm"
                >
                  <div className="flex items-start gap-3.5 min-w-0">
                    <div className="w-10 h-10 rounded-lg bg-surface-container-high flex items-center justify-center shrink-0 border border-white/[0.06]">
                      <FileTypeIcon filename={file.name} size={22} />
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
                        <span>Cached on Receiver Disk • Accessible Even If Sender Disconnects</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0 self-end sm:self-auto">
                    <a
                      href={file.downloadUrl}
                      download={file.name}
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
          <span>Direct P2P DataChannels · OPFS Disk Streaming · 1-Hour Default TTL</span>
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
