"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import { formatSize } from "@/lib/format";
import { FileTypeIcon } from "./FileTypeIcon";
import PinInput from "./PinInput";
import QrScannerModal from "./QrScannerModal";
import { useGhostSession } from "@/context/SessionContext";
import {
  QrCode,
  X,
  Loader2,
  Check,
  AlertCircle,
  ArrowLeft,
  FolderOpen,
  CloudUpload,
  Layers,
  MemoryStick,
  Sparkles,
  Shield,
  Trash2,
  Radio,
  AlertTriangle,
  RefreshCw,
} from "lucide-react";

export default function SendPanel({ initialCode }: { initialCode?: string }) {
  const {
    code: activeSessionCode,
    connStatus,
    error: sessionError,
    natWarning: sessionNatWarning,
    joinGuestSession,
    disconnectSession,
    stagedFiles,
    outboundPhase,
    handleFiles,
    removeStagedItem,
    clearAllStaged,
    triggerTransferRequest,
    retryFailedFile,
  } = useGhostSession();

  const [codeInput, setCodeInput] = useState(initialCode ?? activeSessionCode ?? "");
  const [checking, setChecking] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [isScannerOpen, setIsScannerOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hasAutoJoinedRef = useRef(false);

  const isConnecting = checking || connStatus === "connecting" || connStatus === "reconnecting";

  const connectToReceiver = useCallback(
    async (codeToConnect: string) => {
      if (checking || connStatus === "connecting" || connStatus === "reconnecting" || codeToConnect.length !== 8) return;
      setChecking(true);
      setCodeError(null);

      const success = await joinGuestSession(codeToConnect);
      setChecking(false);
      if (!success) {
        setCodeError(sessionError || "That 8-digit code is invalid, non-existent, or expired.");
      }
    },
    [checking, connStatus, joinGuestSession, sessionError],
  );

  useEffect(() => {
    if (hasAutoJoinedRef.current) return;
    if (initialCode && initialCode.length === 8 && connStatus === "idle") {
      hasAutoJoinedRef.current = true;
      const timer = setTimeout(() => {
        connectToReceiver(initialCode);
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [initialCode, connStatus, connectToReceiver]);

  /* ------------------------------------------------------------- */
  /* STEP 1: Connect / Verify PIN Screen                           */
  /* ------------------------------------------------------------- */
  if (connStatus !== "connected") {
    return (
      <div className="w-full flex flex-col items-center">
        <QrScannerModal
          isOpen={isScannerOpen}
          onClose={() => setIsScannerOpen(false)}
          onScanSuccess={(scannedCode) => {
            setCodeInput(scannedCode);
            setIsScannerOpen(false);
            connectToReceiver(scannedCode);
          }}
        />

        {/* Ambient atmospheric glow */}
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[700px] h-[340px] bg-gradient-to-b from-primary/10 via-secondary/5 to-transparent blur-3xl pointer-events-none -z-10" />

        {/* Hero Context */}
        <div className="text-center max-w-lg mb-8">
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-surface-container-high text-primary font-label-caps tracking-widest uppercase mb-3 border border-white/[0.06]">
            <Sparkles size={14} />
            <span>WebRTC Direct P2P Tunnel</span>
          </div>
          <h2 className="font-headline-lg text-on-surface tracking-tight font-medium mb-2">
            Establish Encrypted Bridge
          </h2>
          <p className="font-body-md text-on-surface-variant">
            Connect directly with your receiving device via ephemeral WebRTC SCTP data channels. Zero cloud file storage,
            zero credit cards, pure peer-to-peer byte stream.
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

          {/* Instruction banner */}
          <div className="p-3.5 rounded-xl bg-surface-container-high border border-white/[0.06] flex items-start gap-2.5 text-xs sm:text-sm font-body-sm text-on-surface-variant">
            <Radio size={16} className="text-secondary shrink-0 mt-0.5" />
            <div>
              <span className="font-semibold text-on-surface">Step 1:</span> Open GhostShare on the other device and stay on <span className="text-secondary font-medium">Receive Files</span>.
              <br />
              <span className="font-semibold text-on-surface">Step 2:</span> Enter that device&apos;s 8-digit code below to establish the direct bridge.
            </div>
          </div>

          {/* Segmented Pin Input Component */}
          <PinInput
            value={codeInput}
            onChange={(val) => {
              setCodeInput(val);
              setCodeError(null);
            }}
            onComplete={(code) => connectToReceiver(code)}
            disabled={isConnecting}
          />

          {(codeError || sessionError) && (
            <div className="p-3.5 rounded-xl bg-error-container/20 border border-error/30 text-error flex items-start gap-2 text-xs font-body-sm">
              <AlertCircle size={16} className="shrink-0 mt-0.5" />
              <span>{codeError || sessionError}</span>
            </div>
          )}

          {sessionNatWarning && (
            <div className="p-3.5 rounded-xl bg-error-container/20 border border-error/30 text-error flex items-start gap-2 text-xs font-body-sm">
              <AlertTriangle size={16} className="shrink-0 mt-0.5" />
              <span>{sessionNatWarning}</span>
            </div>
          )}

          {/* Action Row */}
          <div className="flex flex-col sm:flex-row gap-3 pt-2">
            <button
              onClick={() => connectToReceiver(codeInput)}
              disabled={codeInput.length !== 8 || isConnecting}
              className="flex-1 py-3 px-4 rounded-xl bg-primary text-on-primary font-body-md font-semibold hover:bg-primary-container hover:text-on-primary-container transition-all flex items-center justify-center gap-2 shadow-md active:scale-[0.99] disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              {isConnecting ? <Loader2 size={18} className="animate-spin" /> : null}
              <span>
                {connStatus === "reconnecting"
                  ? "Reconnecting WebRTC Bridge..."
                  : isConnecting
                  ? "Negotiating WebRTC Bridge..."
                  : "Connect Recipient"}
              </span>
            </button>

            {isConnecting && (
              <button
                type="button"
                onClick={() => {
                  disconnectSession();
                  setChecking(false);
                }}
                className="py-3 px-4 rounded-xl bg-surface-container-high hover:bg-error-container/30 text-on-surface-variant hover:text-error text-sm font-body-sm transition-colors cursor-pointer border border-white/[0.08]"
              >
                Cancel
              </button>
            )}

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
            <span>PAIRING PROTOCOL: WebRTC / SCTP</span>
            <span className="text-tertiary">ZERO-KNOWLEDGE P2P</span>
          </div>
        </div>
      </div>
    );
  }

  /* ------------------------------------------------------------- */
  /* STEP 2: File Selection & Direct P2P Streaming                 */
  /* ------------------------------------------------------------- */
  const idleCount = stagedFiles.filter((f) => f.status === "idle").length;
  const isAllDone = stagedFiles.length > 0 && stagedFiles.every((f) => f.status === "done");
  const displayCode = activeSessionCode || codeInput || "CONNECTED";

  return (
    <div className="w-full flex flex-col gap-6">
      {/* Top Telemetry & Session Header */}
      <section className="flex flex-col md:flex-row md:items-center justify-between gap-4 p-4 rounded-2xl bg-surface-container-low border border-white/[0.08] shadow-sm">
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={disconnectSession}
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
              <span>{displayCode.slice(0, 4)}</span>
              <span className="text-outline-variant">-</span>
              <span>{displayCode.slice(4, 8)}</span>
            </div>
          </div>

          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-surface-container-high text-on-surface">
            <span className="w-2 h-2 rounded-full bg-tertiary" />
            <span className="font-body-sm font-medium">Peer Connected (P2P Direct)</span>
          </div>
        </div>

        <div className="flex items-center gap-4 font-mono-telemetry text-on-surface-variant">
          <div className="flex items-center gap-1.5">
            <Shield size={14} className="text-secondary" />
            <span>DTLS 1.3 Encryption</span>
          </div>
          <div className="flex items-center gap-1.5 bg-surface-container px-2.5 py-1 rounded border border-white/[0.04]">
            <Radio size={14} className="text-primary" />
            <span>STUN Traversal Active</span>
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
              Stage Files for Instant Peer Transfer
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
                Direct Browser-to-Browser Transfer
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
                {(outboundPhase === "idle" || outboundPhase === "done") && (
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
                          <FileTypeIcon filename={item.name} size={20} />
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
                                  : item.status === "uploading" || item.status === "awaiting-verification"
                                  ? "text-secondary flex items-center gap-1"
                                  : item.status === "requesting" || item.status === "accepted"
                                  ? "text-primary flex items-center gap-1"
                                  : "text-on-surface-variant"
                              }
                            >
                              {item.status === "done" && (
                                <>
                                  <Check size={12} /> Transferred
                                </>
                              )}
                              {item.status === "error" && (
                                <span className="inline-flex items-center gap-1.5">
                                  <span>{item.error || "Failed"}</span>
                                  <button
                                    onClick={() => retryFailedFile(item.id)}
                                    className="text-primary hover:underline flex items-center gap-0.5 cursor-pointer"
                                  >
                                    <RefreshCw size={11} /> Retry
                                  </button>
                                </span>
                              )}
                              {item.status === "uploading" && (
                                <>
                                  <Loader2 size={12} className="animate-spin" /> Streaming ({item.progress}%)
                                </>
                              )}
                              {item.status === "awaiting-verification" && (
                                <>
                                  <Loader2 size={12} className="animate-spin" /> Verifying...
                                </>
                              )}
                              {item.status === "accepted" && "Accepted, preparing..."}
                              {item.status === "requesting" && "Awaiting Approval"}
                              {item.status === "idle" && "Ready to Stream"}
                            </span>
                          </div>
                        </div>
                      </div>

                      {item.status === "idle" && (
                        <button
                          onClick={() => removeStagedItem(item.id)}
                          className="p-1.5 text-on-surface-variant hover:text-error transition-colors rounded-lg hover:bg-surface-container-highest cursor-pointer"
                          title="Remove from queue"
                        >
                          <X size={16} />
                        </button>
                      )}
                    </div>

                    {item.status === "uploading" && (
                      <div className="w-full h-1.5 rounded-full bg-surface-container-highest overflow-hidden">
                        <div
                          className="h-full bg-secondary transition-all duration-100 rounded-full"
                          style={{ width: `${item.progress}%` }}
                        />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right: Transfer Controls & System Specs (4 cols) */}
        <div className="lg:col-span-4 flex flex-col gap-5">
          <div className="rounded-2xl bg-surface-container-low p-6 border border-white/[0.08] shadow-xl flex flex-col gap-5">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center text-primary">
                <Layers size={20} />
              </div>
              <div>
                <h3 className="font-headline-md text-on-surface">Transfer Dispatch</h3>
                <span className="font-mono-telemetry text-on-surface-variant">
                  {idleCount > 0 ? `${idleCount} pending` : "Queue idle"}
                </span>
              </div>
            </div>

            <div className="flex flex-col gap-3 py-2 border-y border-white/[0.06] font-body-sm text-on-surface-variant">
              <div className="flex justify-between items-center">
                <span>Total Staged Size:</span>
                <span className="font-mono-data text-on-surface font-medium">
                  {formatSize(stagedFiles.reduce((acc, f) => acc + f.size, 0))}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span>Transport Target:</span>
                <span className="font-mono-telemetry text-secondary">#cf-{displayCode}</span>
              </div>
              <div className="flex justify-between items-center">
                <span>Stream Protocol:</span>
                <span className="font-mono-telemetry text-tertiary">SCTP Chunk Streaming</span>
              </div>
            </div>

            {/* Action Trigger Button */}
            <button
              onClick={triggerTransferRequest}
              disabled={
                stagedFiles.length === 0 ||
                idleCount === 0 ||
                outboundPhase === "awaiting-approval" ||
                outboundPhase === "transferring"
              }
              className="w-full py-3.5 px-4 rounded-xl bg-primary text-on-primary font-body-md font-semibold hover:bg-primary-container hover:text-on-primary-container transition-all flex items-center justify-center gap-2 shadow-lg active:scale-[0.99] disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              {outboundPhase === "awaiting-approval" ? (
                <>
                  <Loader2 size={18} className="animate-spin" />
                  <span>Awaiting Recipient Approval...</span>
                </>
              ) : outboundPhase === "transferring" ? (
                <>
                  <Loader2 size={18} className="animate-spin" />
                  <span>Streaming via WebRTC...</span>
                </>
              ) : (
                <>
                  <MemoryStick size={18} />
                  <span>
                    {isAllDone && idleCount === 0
                      ? "Batch Completed"
                      : `Transfer ${idleCount > 0 ? `${idleCount} Item${idleCount > 1 ? "s" : ""}` : "Files"}`}
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
