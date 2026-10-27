"use client";

import { useEffect } from "react";
import { X, Shield, Lock, Radio, Clock, Zap, CheckCircle2 } from "lucide-react";

interface SecurityModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function SecurityModal({ isOpen, onClose }: SecurityModalProps) {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    if (isOpen) {
      window.addEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "hidden";
    }
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "";
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-md">
      <div
        className="w-full max-w-2xl bg-surface-container rounded-2xl border border-white/[0.1] shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
        role="dialog"
        aria-modal="true"
        aria-labelledby="security-specs-title"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-white/[0.08] bg-surface-container-high/60">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center text-primary">
              <Shield size={18} />
            </div>
            <div>
              <h2 id="security-specs-title" className="font-headline-md text-on-surface">
                Security & Architecture Specs
              </h2>
              <p className="font-mono-telemetry text-on-surface-variant">
                TRANSPARENCY MANIFEST • ZERO-KNOWLEDGE P2P PIPELINE
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-on-surface-variant hover:text-on-surface hover:bg-surface-container-highest transition-colors cursor-pointer"
            aria-label="Close dialog"
          >
            <X size={18} />
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="p-6 overflow-y-auto space-y-6 text-on-surface-variant font-body-md">
          {/* Section 1: Data path */}
          <div className="flex gap-4 items-start">
            <div className="w-9 h-9 rounded-xl bg-secondary/10 border border-secondary/20 flex items-center justify-center text-secondary shrink-0 mt-0.5">
              <Radio size={18} />
            </div>
            <div className="space-y-1">
              <h3 className="font-body-md font-semibold text-on-surface flex items-center gap-2">
                Pure WebRTC P2P DataChannels
                <span className="font-mono-telemetry text-secondary bg-secondary/10 px-2 py-0.5 rounded border border-secondary/20">
                  ZERO CLOUD STORAGE
                </span>
              </h3>
              <p className="text-sm leading-relaxed">
                File bytes are never uploaded to any cloud storage provider (no R2, B2, or S3) and never transit through
                any application proxy server. File payloads flow directly from browser RAM to browser RAM across encrypted
                WebRTC SCTP data channels authenticated with DTLS 1.3.
              </p>
            </div>
          </div>

          {/* Section 2: Zero credentials / accounts */}
          <div className="flex gap-4 items-start">
            <div className="w-9 h-9 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center text-primary shrink-0 mt-0.5">
              <Lock size={18} />
            </div>
            <div className="space-y-1">
              <h3 className="font-body-md font-semibold text-on-surface flex items-center gap-2">
                Cryptographic Pairing Handshake
                <span className="font-mono-telemetry text-primary bg-primary/10 px-2 py-0.5 rounded border border-primary/20">
                  WEB CRYPTO
                </span>
              </h3>
              <p className="text-sm leading-relaxed">
                Pairing tokens are generated using unbiased rejection sampling over the Web Crypto CSPRNG
                (`crypto.getRandomValues`). The signaling server exchanges only ephemeral session descriptions (SDP) and
                ICE candidate addresses. No file names, bytes, user accounts, or persistent logs ever exist on the signaling layer.
              </p>
            </div>
          </div>

          {/* Section 3: Ephemeral lifecycle & Explicit Approval */}
          <div className="flex gap-4 items-start">
            <div className="w-9 h-9 rounded-xl bg-tertiary/10 border border-tertiary/20 flex items-center justify-center text-tertiary shrink-0 mt-0.5">
              <Clock size={18} />
            </div>
            <div className="space-y-1">
              <h3 className="font-body-md font-semibold text-on-surface flex items-center gap-2">
                Explicit Receiver Authorization
                <span className="font-mono-telemetry text-tertiary bg-tertiary/10 px-2 py-0.5 rounded border border-tertiary/20">
                  CONSENT REQUIRED
                </span>
              </h3>
              <p className="text-sm leading-relaxed">
                Before any bytes stream across the data channel, the sender must submit a transfer request manifest.
                The receiver is presented with an explicit approval prompt displaying file names and sizes. If the receiver
                declines or cancels, no file chunks are dispatched. Signaling channels automatically self-destruct after 15 minutes.
              </p>
            </div>
          </div>

          {/* Section 4: Memory Safety & Backpressure */}
          <div className="flex gap-4 items-start">
            <div className="w-9 h-9 rounded-xl bg-surface-container-high border border-white/[0.08] flex items-center justify-center text-on-surface shrink-0 mt-0.5">
              <Zap size={18} />
            </div>
            <div className="space-y-1">
              <h3 className="font-body-md font-semibold text-on-surface flex items-center gap-2">
                SCTP Chunking &amp; Backpressure Throttling
                <span className="font-mono-telemetry text-tertiary bg-tertiary/10 px-2 py-0.5 rounded border border-tertiary/20">
                  DIRECT-TO-DISK P2P
                </span>
              </h3>
              <p className="text-sm leading-relaxed">
                Files are streamed in 32 KB binary slices directly via `File.slice()`, avoiding browser RAM exhaustion.
                When the WebRTC buffer exceeds 256 KB, transmission pauses automatically until the network adapter triggers
                the `bufferedamountlow` event. Transfers bypass cloud storage, streaming directly to disk via OPFS where supported,
                bounded by device storage quota and browser memory safety limits.
              </p>
            </div>
          </div>

          {/* Verification checklist */}
          <div className="p-4 rounded-xl bg-surface-container-low border border-white/[0.06] space-y-2">
            <span className="font-label-caps text-on-surface-variant">SECURITY CONTROLS SUMMARY</span>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs font-mono-telemetry">
              <div className="flex items-center gap-1.5 text-tertiary">
                <CheckCircle2 size={14} /> End-to-End DTLS 1.3 Encryption
              </div>
              <div className="flex items-center gap-1.5 text-tertiary">
                <CheckCircle2 size={14} /> Public STUN NAT Traversal
              </div>
              <div className="flex items-center gap-1.5 text-tertiary">
                <CheckCircle2 size={14} /> Zero Cloud Storage / Zero Credit Cards
              </div>
              <div className="flex items-center gap-1.5 text-tertiary">
                <CheckCircle2 size={14} /> Automatic Memory Backpressure Control
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-white/[0.08] bg-surface-container-high/40 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg bg-surface-container-highest hover:bg-surface-bright text-on-surface font-body-sm font-medium transition-colors cursor-pointer border border-white/[0.08]"
          >
            Acknowledge & Close
          </button>
        </div>
      </div>
    </div>
  );
}