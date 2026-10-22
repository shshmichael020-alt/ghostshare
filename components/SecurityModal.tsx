"use client";

import { useEffect } from "react";
import { X, Shield, Lock, Cloud, Clock, Zap, CheckCircle2 } from "lucide-react";

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
                TRANSPARENCY MANIFEST • ZERO-KNOWLEDGE PIPELINE
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
              <Cloud size={18} />
            </div>
            <div className="space-y-1">
              <h3 className="font-body-md font-semibold text-on-surface flex items-center gap-2">
                Direct-to-R2 Signed Pipeline
                <span className="font-mono-telemetry text-secondary bg-secondary/10 px-2 py-0.5 rounded border border-secondary/20">
                  NO PROXY
                </span>
              </h3>
              <p className="text-sm leading-relaxed">
                File bytes are never streamed through intermediate proxy servers or the Worker request body. The sender
                browser transmits payloads directly to Cloudflare R2 object storage via presigned S3-compatible PUT
                URLs signed using AWS Signature V4 with SHA-256 HMAC.
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
                Pairing tokens are generated using cryptographically secure random values via the Web Crypto API,
                preventing predictability. Sessions reside in Cloudflare Workers KV with automatic time-to-live (TTL)
                expiration. No passwords, user profiles, or tracking identifiers exist.
              </p>
            </div>
          </div>

          {/* Section 3: Ephemeral lifecycle */}
          <div className="flex gap-4 items-start">
            <div className="w-9 h-9 rounded-xl bg-tertiary/10 border border-tertiary/20 flex items-center justify-center text-tertiary shrink-0 mt-0.5">
              <Clock size={18} />
            </div>
            <div className="space-y-1">
              <h3 className="font-body-md font-semibold text-on-surface flex items-center gap-2">
                Automated Self-Destruction
                <span className="font-mono-telemetry text-tertiary bg-tertiary/10 px-2 py-0.5 rounded border border-tertiary/20">
                  LOCKED TTL
                </span>
              </h3>
              <p className="text-sm leading-relaxed">
                Transfers feature configurable retention between 30 minutes and 24 hours. The moment the first upload
                commences, the session expiration interval locks irrevocably to prevent batch desynchronization. Both
                KV session keys and presigned download URLs automatically lapse once the chosen window concludes.
              </p>
            </div>
          </div>

          {/* Section 4: Storage isolation & integrity */}
          <div className="flex gap-4 items-start">
            <div className="w-9 h-9 rounded-xl bg-surface-container-high border border-white/[0.08] flex items-center justify-center text-on-surface shrink-0 mt-0.5">
              <Zap size={18} />
            </div>
            <div className="space-y-1">
              <h3 className="font-body-md font-semibold text-on-surface flex items-center gap-2">
                Private Bucket & Strict Quotas
                <span className="font-mono-telemetry text-on-surface bg-white/10 px-2 py-0.5 rounded">
                  250 MB CAP
                </span>
              </h3>
              <p className="text-sm leading-relaxed">
                The storage bucket remains strictly private with zero public read permissions. Senders cannot overwrite
                existing objects, exceed the 250 MB per-session ceiling, or manipulate internal object paths. The server
                verifies object presence and actual byte sizes before finalizing registrations.
              </p>
            </div>
          </div>

          {/* Verification checklist */}
          <div className="p-4 rounded-xl bg-surface-container-low border border-white/[0.06] space-y-2">
            <span className="font-label-caps text-on-surface-variant">SECURITY CONTROLS SUMMARY</span>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs font-mono-telemetry">
              <div className="flex items-center gap-1.5 text-tertiary">
                <CheckCircle2 size={14} /> TLS 1.3 Transport Encryption
              </div>
              <div className="flex items-center gap-1.5 text-tertiary">
                <CheckCircle2 size={14} /> HMAC-SHA256 Signed URLs
              </div>
              <div className="flex items-center gap-1.5 text-tertiary">
                <CheckCircle2 size={14} /> Rate Limited Session Endpoints
              </div>
              <div className="flex items-center gap-1.5 text-tertiary">
                <CheckCircle2 size={14} /> RFC 6266 Header Sanitization
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
