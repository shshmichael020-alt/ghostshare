"use client";

import React, { useState, useRef, useEffect } from "react";
import { formatSize, formatCountdown } from "@/lib/format";
import { FileTypeIcon } from "./FileTypeIcon";
import PinDisplay from "./PinDisplay";
import PinInput from "./PinInput";
import QrScannerModal from "./QrScannerModal";
import { QRCodeSVG } from "qrcode.react";
import { EXPIRY_OPTIONS } from "@/lib/constants";
import { useGhostSession } from "@/context/SessionContext";
import {
  Upload,
  FolderOpen,
  Download,
  Trash2,
  RefreshCw,
  Loader2,
  AlertCircle,
  CheckCircle2,
  Radio,
  Clock,
  QrCode,
  Share2,
  Copy,
  Check,
  ArrowRight,
  ArrowLeftRight,
  FileCheck,
  Layers,
} from "lucide-react";

export default function DualPanel({ initialCode }: { initialCode?: string } = {}) {
  const {
    role,
    code,
    connStatus,
    error,
    natWarning,
    remainingTtl,
    initialTtl,
    copiedLink,
    startHostSession,
    joinGuestSession,
    disconnectSession,
    updateExpiryWindow,
    copyLink,
    shareLink,
    stagedFiles,
    outboundPhase,
    handleFiles,
    removeStagedItem,
    clearAllStaged,
    triggerTransferRequest,
    retryFailedFile,
    pendingApproval,
    handleAcceptTransfer,
    handleDeclineTransfer,
    activeReceiving,
    receivedFiles,
    downloadAllFiles,
    storageCapability,
    candidatePair,
    pushToast,
  } = useGhostSession();

  const [inputCode, setInputCode] = useState(initialCode ?? "");
  const [isJoining, setIsJoining] = useState(false);
  const [isStartingHost, setIsStartingHost] = useState(false);
  const [isScannerOpen, setIsScannerOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hasAutoJoinedRef = useRef(false);

  useEffect(() => {
    if (hasAutoJoinedRef.current) return;
    if (initialCode && initialCode.length === 8 && connStatus === "idle") {
      hasAutoJoinedRef.current = true;
      const timer = setTimeout(() => {
        joinGuestSession(initialCode);
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [initialCode, connStatus, joinGuestSession]);

  // Drag and drop handlers
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFiles(e.dataTransfer.files);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFiles(e.target.files);
    }
    // reset input so the same files can be re-selected if needed
    e.target.value = "";
  };

  const onJoinSubmit = async (codeToUse: string) => {
    if (codeToUse.length !== 8) return;
    setIsJoining(true);
    const success = await joinGuestSession(codeToUse);
    setIsJoining(false);
    if (!success) {
      pushToast("Failed to join session. Check code or try again.", "error");
    }
  };

  const onStartHost = async () => {
    setIsStartingHost(true);
    const newCode = await startHostSession(initialTtl);
    setIsStartingHost(false);
    if (!newCode) {
      pushToast("Failed to create session. Please retry.", "error");
    }
  };

  const totalStagedSize = stagedFiles.reduce((acc, f) => acc + f.size, 0);
  const pendingFilesSize =
    pendingApproval?.files.reduce((acc, f) => acc + f.size, 0) ?? 0;

  // Render Setup / Connection Interface if disconnected or idle
  if (connStatus === "idle" || connStatus === "disconnected" || connStatus === "failed") {
    return (
      <div className="w-full max-w-4xl mx-auto space-y-8 animate-in fade-in duration-300">
        {/* Banner */}
        <div className="text-center space-y-2">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-surface-container-high border border-white/[0.08] text-xs font-mono-telemetry text-secondary mb-2">
            <ArrowLeftRight size={14} />
            Simultaneous Bidirectional WebRTC P2P
          </div>
          <h1 className="font-headline-lg text-2xl sm:text-3xl font-bold text-on-surface">
            Dual Mode Workspace
          </h1>
          <p className="font-body-md text-on-surface-variant max-w-xl mx-auto text-sm">
            Send and receive files concurrently with your peer over an encrypted direct WebRTC data tunnel, with real-time ephemeral live chat.
          </p>
        </div>

        {error && (
          <div className="p-4 rounded-xl bg-error-container/40 border border-error/30 text-error flex items-center gap-3">
            <AlertCircle size={20} className="shrink-0" />
            <p className="text-xs font-medium">{error}</p>
          </div>
        )}

        {/* Pairing cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Card 1: Host a Session */}
          <div className="p-6 rounded-2xl bg-surface-container-low border border-white/[0.08] flex flex-col justify-between hover:border-white/[0.15] transition-all">
            <div className="space-y-4">
              <div className="w-10 h-10 rounded-xl bg-primary/20 border border-primary/30 flex items-center justify-center text-primary">
                <Radio size={20} />
              </div>
              <div>
                <h3 className="font-headline-md text-base font-semibold text-on-surface">
                  Host New Session
                </h3>
                <p className="font-body-sm text-xs text-on-surface-variant mt-1">
                  Generate an 8-digit secure code and QR code. Your peer joins with the code to start exchanging files.
                </p>
              </div>
            </div>

            <button
              onClick={onStartHost}
              disabled={isStartingHost}
              className="mt-6 w-full py-3 px-4 rounded-xl bg-primary text-on-primary font-medium text-xs sm:text-sm hover:bg-primary/90 transition-all flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50 shadow-md"
            >
              {isStartingHost ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  Generating Session...
                </>
              ) : (
                <>
                  Generate Pairing Code
                  <ArrowRight size={16} />
                </>
              )}
            </button>
          </div>

          {/* Card 2: Join an Existing Session */}
          <div className="p-6 rounded-2xl bg-surface-container-low border border-white/[0.08] flex flex-col justify-between hover:border-white/[0.15] transition-all">
            <div className="space-y-4">
              <div className="w-10 h-10 rounded-xl bg-secondary/20 border border-secondary/30 flex items-center justify-center text-secondary">
                <QrCode size={20} />
              </div>
              <div>
                <h3 className="font-headline-md text-base font-semibold text-on-surface">
                  Join Peer Session
                </h3>
                <p className="font-body-sm text-xs text-on-surface-variant mt-1">
                  Enter the 8-digit pairing code displayed on your peer&apos;s device or scan their QR code.
                </p>
              </div>

              <div className="pt-2">
                <PinInput
                  value={inputCode}
                  onChange={(val) => setInputCode(val)}
                  onComplete={onJoinSubmit}
                  disabled={isJoining}
                />
              </div>
            </div>

            <div className="mt-6 flex items-center gap-3">
              <button
                onClick={() => setIsScannerOpen(true)}
                className="py-3 px-3.5 rounded-xl bg-surface-container-high hover:bg-surface-container-highest text-on-surface border border-white/[0.08] text-xs font-medium transition-colors flex items-center justify-center gap-2 cursor-pointer"
                title="Scan QR Code"
              >
                <QrCode size={16} className="text-secondary" />
                <span>Scan QR</span>
              </button>

              <button
                onClick={() => onJoinSubmit(inputCode)}
                disabled={isJoining || inputCode.length !== 8}
                className="flex-1 py-3 px-4 rounded-xl bg-surface-container-highest hover:bg-white/[0.1] text-on-surface font-medium text-xs sm:text-sm border border-white/[0.1] transition-all flex items-center justify-center gap-2 cursor-pointer disabled:opacity-40"
              >
                {isJoining ? (
                  <>
                    <Loader2 size={16} className="animate-spin" />
                    Connecting...
                  </>
                ) : (
                  <>
                    Connect
                    <ArrowRight size={16} />
                  </>
                )}
              </button>
            </div>
          </div>
        </div>

        {isScannerOpen && (
          <QrScannerModal
            isOpen={isScannerOpen}
            onClose={() => setIsScannerOpen(false)}
            onScanSuccess={(scannedCode) => {
              setInputCode(scannedCode);
              setIsScannerOpen(false);
              onJoinSubmit(scannedCode);
            }}
          />
        )}
      </div>
    );
  }

  // Render Joiner Connecting State
  if ((connStatus === "connecting" || connStatus === "reconnecting") && role === "joiner") {
    return (
      <div className="w-full max-w-md mx-auto space-y-6 animate-in fade-in duration-300">
        <div className="p-6 sm:p-8 rounded-3xl bg-surface-container-low border border-white/[0.08] shadow-xl text-center space-y-6">
          <div className="w-16 h-16 rounded-2xl bg-secondary/15 border border-secondary/25 flex items-center justify-center mx-auto text-secondary">
            <Loader2 size={32} className="animate-spin" />
          </div>
          <div className="space-y-2">
            <h2 className="font-headline-lg text-xl sm:text-2xl font-bold text-on-surface">
              {connStatus === "reconnecting" ? "Reconnecting to Peer..." : "Connecting to Peer..."}
            </h2>
            <p className="text-xs text-on-surface-variant max-w-sm mx-auto">
              Negotiating direct WebRTC tunnel for session{" "}
              <span className="font-mono font-bold text-on-surface">#{code}</span>. Please ensure the other device remains active.
            </p>
          </div>
          <div className="pt-2">
            <button
              onClick={disconnectSession}
              className="px-4 py-2 rounded-xl bg-surface-container-high hover:bg-error-container/30 text-on-surface-variant hover:text-error text-xs font-medium transition-colors cursor-pointer border border-white/[0.08]"
            >
              Cancel Connection
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Render Host Awaiting Guest Connection
  if (connStatus === "awaiting" || connStatus === "connecting" || connStatus === "reconnecting") {
    return (
      <div className="w-full max-w-2xl mx-auto space-y-6 animate-in fade-in duration-300">
        <div className="p-6 sm:p-8 rounded-3xl bg-surface-container-low border border-white/[0.08] shadow-xl text-center space-y-6">
          <div className="space-y-2">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-secondary/15 text-secondary border border-secondary/25 text-xs font-mono-telemetry">
              <span className="w-2 h-2 rounded-full bg-secondary animate-pulse" />
              {connStatus === "awaiting"
                ? "Awaiting Peer Connection"
                : connStatus === "reconnecting"
                ? "Reconnecting WebRTC Tunnel"
                : "Establishing P2P Tunnel..."}
            </div>
            <h2 className="font-headline-lg text-xl sm:text-2xl font-bold text-on-surface">
              Pair with Your Peer
            </h2>
            <p className="text-xs text-on-surface-variant max-w-sm mx-auto">
              Share the code below or have them scan the QR code to open the bidirectional tunnel.
            </p>
          </div>

          {/* Pairing Code Display */}
          {code && <PinDisplay code={code} onCopy={copyLink} />}

          {/* QR Code */}
          {code && (
            <div className="flex flex-col items-center justify-center p-4 bg-white rounded-2xl w-48 h-48 mx-auto shadow-inner">
              <QRCodeSVG
                value={`${typeof window !== "undefined" ? window.location.origin : ""}?code=${code}&mode=dual`}
                size={160}
                level="M"
              />
            </div>
          )}

          {/* Controls: Share & Copy Link */}
          <div className="flex flex-wrap items-center justify-center gap-3">
            <button
              onClick={copyLink}
              className="px-4 py-2 rounded-xl bg-surface-container-high hover:bg-surface-container-highest text-on-surface border border-white/[0.08] text-xs font-medium transition-colors flex items-center gap-2 cursor-pointer"
            >
              {copiedLink ? <Check size={14} className="text-tertiary" /> : <Copy size={14} />}
              {copiedLink ? "Link Copied!" : "Copy Link"}
            </button>
            <button
              onClick={shareLink}
              className="px-4 py-2 rounded-xl bg-surface-container-high hover:bg-surface-container-highest text-on-surface border border-white/[0.08] text-xs font-medium transition-colors flex items-center gap-2 cursor-pointer"
            >
              <Share2 size={14} />
              Share Link
            </button>
          </div>

          {/* Countdown & Expiry Selector */}
          {remainingTtl !== null && (
            <div className="pt-4 border-t border-white/[0.06] flex flex-wrap items-center justify-between text-xs text-on-surface-variant">
              <div className="flex items-center gap-1.5 font-mono-telemetry">
                <Clock size={14} className="text-primary" />
                <span>Expires in:</span>
                <span className="font-bold text-on-surface">
                  {formatCountdown(remainingTtl)}
                </span>
              </div>

              {role === "creator" && (
                <div className="flex items-center gap-2">
                  <span className="text-[11px]">Extend:</span>
                  <select
                    value={initialTtl}
                    onChange={(e) => updateExpiryWindow(Number(e.target.value))}
                    className="bg-surface-container-high border border-white/[0.08] rounded-lg px-2 py-1 text-xs text-on-surface focus:outline-none cursor-pointer"
                  >
                    {EXPIRY_OPTIONS.map((opt) => (
                      <option key={opt.seconds} value={opt.seconds}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          )}

          <div className="pt-3 flex flex-col sm:flex-row items-center justify-center gap-3">
            <button
              type="button"
              onClick={disconnectSession}
              className="px-4 py-2 rounded-xl bg-surface-container-high hover:bg-surface-container-highest text-on-surface border border-white/[0.08] text-xs font-medium transition-colors flex items-center gap-2 cursor-pointer"
            >
              <ArrowLeftRight size={14} className="text-secondary" />
              <span>Join a Peer Instead</span>
            </button>
            <button
              type="button"
              onClick={disconnectSession}
              className="text-xs text-on-surface-variant hover:text-error transition-colors underline cursor-pointer py-1"
            >
              Cancel Session
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Active Connected Dual Workspace
  return (
    <div className="w-full max-w-6xl mx-auto space-y-6 animate-in fade-in duration-300">
      {/* Active Session Status Bar */}
      <div className="p-4 rounded-2xl bg-surface-container-low border border-white/[0.08] flex flex-wrap items-center justify-between gap-4 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="w-3 h-3 rounded-full bg-tertiary animate-pulse" />
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-on-surface">Dual P2P Tunnel Active</span>
              <span className="px-2 py-0.5 rounded text-[10px] font-mono-telemetry bg-surface-container-high text-on-surface-variant uppercase border border-white/[0.06]">
                Code: {code}
              </span>
              {candidatePair && (
                <span className="px-2 py-0.5 rounded text-[10px] font-mono-telemetry bg-surface-container-high text-secondary border border-white/[0.06]">
                  {candidatePair.isRelayed ? "TURN Relay" : `Direct (${candidatePair.localCandidateType})`}
                </span>
              )}
            </div>
            <p className="text-[11px] text-on-surface-variant font-mono-telemetry">
              Direct DTLS Encrypted DataChannel • Zero-Server Buffer
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {remainingTtl !== null && (
            <div className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-surface-container-high border border-white/[0.06] text-xs font-mono-telemetry">
              <Clock size={13} className="text-primary" />
              <span>TTL: {formatCountdown(remainingTtl)}</span>
            </div>
          )}

          <button
            onClick={disconnectSession}
            className="px-3 py-1.5 rounded-xl bg-surface-container-high hover:bg-error/20 hover:text-error text-on-surface-variant border border-white/[0.08] text-xs font-medium transition-colors cursor-pointer"
          >
            End Session
          </button>
        </div>
      </div>

      {natWarning && (
        <div className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-300 text-xs flex items-center gap-2.5">
          <AlertCircle size={16} className="shrink-0" />
          <span>{natWarning}</span>
        </div>
      )}

      {/* Main Dual Workspace: Two Equal Columns */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
        {/* ======================================================== */}
        {/* COLUMN 1: OUTBOUND TRANSFERS (SEND)                     */}
        {/* ======================================================== */}
        <div className="p-5 sm:p-6 rounded-3xl bg-surface-container-low border border-white/[0.08] flex flex-col space-y-5 shadow-lg">
          <div className="flex items-center justify-between pb-3 border-b border-white/[0.06]">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-xl bg-primary/20 border border-primary/30 flex items-center justify-center text-primary">
                <Upload size={16} />
              </div>
              <div>
                <h2 className="font-headline-md text-sm sm:text-base font-semibold text-on-surface">
                  Outbound Transfer
                </h2>
                <p className="text-[11px] text-on-surface-variant">
                  Stream files directly to your peer
                </p>
              </div>
            </div>

            {stagedFiles.length > 0 && outboundPhase === "idle" && (
              <button
                onClick={clearAllStaged}
                className="text-xs text-on-surface-variant hover:text-error transition-colors flex items-center gap-1 cursor-pointer"
              >
                <Trash2 size={13} />
                Clear
              </button>
            )}
          </div>

          {/* Drag & Drop Area */}
          <div
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            className={`border-2 border-dashed rounded-2xl p-6 text-center cursor-pointer transition-all duration-200 flex flex-col items-center justify-center min-h-[140px] ${
              dragOver
                ? "border-primary bg-primary/10"
                : "border-white/[0.1] hover:border-white/[0.2] bg-surface-container-lowest/50"
            }`}
          >
            <input
              ref={fileInputRef}
              type="file"
              multiple
              onChange={handleFileChange}
              className="hidden"
            />
            <FolderOpen
              size={28}
              className={`mb-2 transition-transform duration-200 ${
                dragOver ? "scale-110 text-primary" : "text-on-surface-variant"
              }`}
            />
            <p className="text-xs font-medium text-on-surface">
              Click to browse or drop files here
            </p>
            <p className="text-[11px] text-on-surface-variant mt-1">
              Direct P2P transfer • Zero cloud upload (Storage &amp; Quota aware)
            </p>
          </div>

          {/* Staged Files List */}
          {stagedFiles.length > 0 && (
            <div className="space-y-2 max-h-60 overflow-y-auto pr-1 scrollbar-thin">
              <div className="text-[11px] font-mono-telemetry text-on-surface-variant flex justify-between">
                <span>Staged Files ({stagedFiles.length})</span>
                <span>Total: {formatSize(totalStagedSize)}</span>
              </div>

              {stagedFiles.map((item) => (
                <div
                  key={item.id}
                  className="p-3 rounded-xl bg-surface-container-high/60 border border-white/[0.06] flex items-center justify-between gap-3 text-xs"
                >
                  <div className="flex items-center gap-2.5 min-w-0 flex-1">
                    <FileTypeIcon filename={item.name} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-on-surface">{item.name}</p>
                      <p className="text-[10px] text-on-surface-variant font-mono-telemetry">
                        {formatSize(item.size)}
                        {item.status === "uploading" && ` • ${item.progress}%`}
                        {item.status === "awaiting-verification" && ` • Verifying...`}
                        {item.status === "requesting" && ` • Awaiting approval`}
                        {item.status === "accepted" && ` • Accepted`}
                        {item.status === "error" && item.error && (
                          <span className="text-error truncate block mt-0.5" title={item.error}>
                            • {item.error}
                          </span>
                        )}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {item.status === "uploading" && (
                      <div className="w-16 bg-surface-container-lowest rounded-full h-1.5 overflow-hidden border border-white/[0.05]">
                        <div
                          className="bg-primary h-full transition-all duration-150"
                          style={{ width: `${item.progress}%` }}
                        />
                      </div>
                    )}
                    {item.status === "awaiting-verification" && (
                      <span className="text-secondary flex items-center gap-1 text-[11px] font-medium">
                        <Loader2 size={13} className="animate-spin" /> Verifying
                      </span>
                    )}
                    {item.status === "done" && (
                      <span className="text-tertiary flex items-center gap-1 text-[11px] font-medium">
                        <CheckCircle2 size={14} /> Sent
                      </span>
                    )}
                    {item.status === "error" && (
                      <button
                        onClick={() => retryFailedFile(item.id)}
                        className="text-error hover:underline flex items-center gap-1 text-[11px] cursor-pointer"
                        title={item.error || "Retry transfer"}
                      >
                        <RefreshCw size={13} /> Retry
                      </button>
                    )}
                    {item.status === "idle" && (
                      <button
                        onClick={() => removeStagedItem(item.id)}
                        className="text-on-surface-variant hover:text-error transition-colors p-1 rounded cursor-pointer"
                        title="Remove file"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Outbound Action Button */}
          <div>
            <button
              onClick={triggerTransferRequest}
              disabled={
                stagedFiles.length === 0 ||
                outboundPhase === "awaiting-approval" ||
                outboundPhase === "transferring"
              }
              className="w-full py-3 px-4 rounded-xl bg-primary text-on-primary font-medium text-xs sm:text-sm hover:bg-primary/90 transition-all flex items-center justify-center gap-2 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed shadow-md"
            >
              {outboundPhase === "awaiting-approval" ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  Awaiting Peer Approval...
                </>
              ) : outboundPhase === "transferring" ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  Streaming Files to Peer...
                </>
              ) : (
                <>
                  <Upload size={16} />
                  Send {stagedFiles.length > 0 ? `${stagedFiles.length} File${stagedFiles.length > 1 ? "s" : ""}` : "Files"}
                  {stagedFiles.length > 0 && ` (${formatSize(totalStagedSize)})`}
                </>
              )}
            </button>
          </div>
        </div>

        {/* ======================================================== */}
        {/* COLUMN 2: INBOUND TRANSFERS (RECEIVE)                    */}
        {/* ======================================================== */}
        <div className="p-5 sm:p-6 rounded-3xl bg-surface-container-low border border-white/[0.08] flex flex-col space-y-5 shadow-lg">
          <div className="flex items-center justify-between pb-3 border-b border-white/[0.06]">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-xl bg-secondary/20 border border-secondary/30 flex items-center justify-center text-secondary">
                <Download size={16} />
              </div>
              <div>
                <h2 className="font-headline-md text-sm sm:text-base font-semibold text-on-surface">
                  Inbound Transfers
                </h2>
                <p className="text-[11px] text-on-surface-variant">
                  Files received directly from peer via OPFS
                </p>
              </div>
            </div>

            {receivedFiles.length > 1 && (
              <button
                onClick={downloadAllFiles}
                className="text-xs text-primary hover:underline flex items-center gap-1 cursor-pointer font-medium"
              >
                <Download size={13} />
                Save All
              </button>
            )}
          </div>

          {/* Pending Inbound Approval Banner */}
          {pendingApproval && (
            <div className="p-4 rounded-2xl bg-secondary/15 border border-secondary/30 space-y-3 animate-in fade-in duration-200">
              <div className="flex items-start gap-3">
                <Layers size={20} className="text-secondary shrink-0 mt-0.5" />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold text-on-surface">
                    Incoming Transfer Request
                  </p>
                  <p className="text-[11px] text-on-surface-variant mt-0.5">
                    Peer wants to stream {pendingApproval.files.length} file{pendingApproval.files.length > 1 ? "s" : ""} (
                    {formatSize(pendingFilesSize)})
                  </p>
                  <div className="mt-2 space-y-1 max-h-24 overflow-y-auto">
                    {pendingApproval.files.map((f) => (
                      <div
                        key={f.id}
                        className="text-[10px] font-mono-telemetry text-on-surface-variant truncate flex justify-between"
                      >
                        <span className="truncate mr-2">• {f.name}</span>
                        <span>{formatSize(f.size)}</span>
                      </div>
                    ))}
                  </div>

                  {storageCapability?.available !== undefined && pendingFilesSize > storageCapability.available && (
                    <p className="text-[10px] text-error font-medium mt-1">
                      ⚠️ Insufficient space: Requires {formatSize(pendingFilesSize)}, free {formatSize(storageCapability.available)}
                    </p>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-2 pt-1">
                <button
                  onClick={handleAcceptTransfer}
                  className="flex-1 py-2 px-3 rounded-xl bg-secondary text-on-secondary font-medium text-xs hover:bg-secondary/90 transition-colors cursor-pointer flex items-center justify-center gap-1.5"
                >
                  <Check size={14} /> Accept &amp; Receive
                </button>
                <button
                  onClick={handleDeclineTransfer}
                  className="py-2 px-3 rounded-xl bg-surface-container-high hover:bg-white/[0.08] text-on-surface-variant hover:text-on-surface transition-colors text-xs cursor-pointer font-medium"
                >
                  Decline
                </button>
              </div>
            </div>
          )}

          {/* Active Receiving Progress Bar */}
          {activeReceiving && (
            <div className="p-3.5 rounded-xl bg-surface-container-high/80 border border-white/[0.08] space-y-2 animate-in fade-in">
              <div className="flex items-center justify-between text-xs">
                <span className="truncate font-medium text-on-surface flex items-center gap-1.5">
                  <Loader2 size={13} className="animate-spin text-secondary" />
                  {activeReceiving.status === "verifying"
                    ? `Verifying: ${activeReceiving.name}`
                    : `Receiving: ${activeReceiving.name}`}
                </span>
                <span className="font-mono-telemetry text-[11px] text-on-surface-variant shrink-0">
                  {formatSize(activeReceiving.receivedBytes)} / {formatSize(activeReceiving.size)}
                </span>
              </div>
              <div className="w-full bg-surface-container-lowest rounded-full h-1.5 overflow-hidden border border-white/[0.05]">
                <div
                  className="bg-secondary h-full transition-all duration-150"
                  style={{
                    width: `${Math.min(
                      100,
                      Math.round((activeReceiving.receivedBytes / activeReceiving.size) * 100),
                    )}%`,
                  }}
                />
              </div>
            </div>
          )}

          {/* Received Files List */}
          {receivedFiles.length === 0 ? (
            <div className="flex-1 min-h-[160px] flex flex-col items-center justify-center p-6 text-center text-on-surface-variant border border-dashed border-white/[0.08] rounded-2xl bg-surface-container-lowest/30">
              <FileCheck size={28} className="text-on-surface-variant/50 mb-2" />
              <p className="text-xs font-medium text-on-surface">No received files yet</p>
              <p className="text-[11px] mt-1 max-w-xs">
                When your peer streams files, they write directly to zero-RAM OPFS storage and appear here ready to save.
              </p>
            </div>
          ) : (
            <div className="space-y-2 max-h-72 overflow-y-auto pr-1 scrollbar-thin">
              <div className="text-[11px] font-mono-telemetry text-on-surface-variant flex justify-between">
                <span>Received Files ({receivedFiles.length})</span>
                <span>
                  Total:{" "}
                  {formatSize(receivedFiles.reduce((acc, f) => acc + f.size, 0))}
                </span>
              </div>

              {receivedFiles.map((file) => (
                <div
                  key={file.id}
                  className="p-3 rounded-xl bg-surface-container-high/60 border border-white/[0.06] flex items-center justify-between gap-3 text-xs"
                >
                  <div className="flex items-center gap-2.5 min-w-0 flex-1">
                    <FileTypeIcon filename={file.name} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-on-surface">{file.name}</p>
                      <p className="text-[10px] text-on-surface-variant font-mono-telemetry">
                        {formatSize(file.size)} •{" "}
                        {new Date(file.receivedAt).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </p>
                    </div>
                  </div>

                  <a
                    href={file.downloadUrl}
                    download={file.name}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="p-2 rounded-lg bg-surface-container-highest hover:bg-primary hover:text-on-primary text-on-surface transition-colors cursor-pointer shrink-0 shadow-sm flex items-center justify-center"
                    title={`Download ${file.name}`}
                  >
                    <Download size={14} />
                  </a>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
