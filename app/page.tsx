"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import Header from "@/components/Header";
import SecurityModal from "@/components/SecurityModal";
import SendPanel from "@/components/SendPanel";
import ReceivePanel from "@/components/ReceivePanel";
import { Shield, Cloud, Lock } from "lucide-react";

function GhostShareHome() {
  const searchParams = useSearchParams();
  const initialMode = searchParams.get("mode") === "send" ? "send" : "receive";
  const initialCode = searchParams.get("code") ?? undefined;

  const [mode, setMode] = useState<"receive" | "send">(initialMode);
  const [isSecurityOpen, setIsSecurityOpen] = useState(false);

  return (
    <div className="min-h-screen flex flex-col justify-between bg-surface selection:bg-primary-container selection:text-on-primary-container relative overflow-x-hidden">
      {/* Brand Header */}
      <Header
        mode={mode}
        onModeChange={(m) => setMode(m)}
        onOpenSecurity={() => setIsSecurityOpen(true)}
      />

      {/* Security Specifications Dialog */}
      <SecurityModal isOpen={isSecurityOpen} onClose={() => setIsSecurityOpen(false)} />

      {/* Main Workspace Canvas */}
      <main className="w-full pt-20 sm:pt-24 pb-16 flex-1 flex flex-col items-center">
        {/* Ambient atmospheric glows */}
        <div className="absolute top-12 left-1/2 -translate-x-1/2 w-[720px] h-[340px] bg-secondary/10 rounded-full blur-[120px] pointer-events-none -z-10" />
        <div className="absolute top-52 right-12 w-[400px] h-[300px] bg-primary/10 rounded-full blur-[100px] pointer-events-none -z-10" />

        <div className="w-full max-w-6xl mx-auto px-4 sm:px-6 flex flex-col">
          {mode === "receive" ? (
            <ReceivePanel onOpenSecurity={() => setIsSecurityOpen(true)} />
          ) : (
            <SendPanel initialCode={initialCode} />
          )}
        </div>
      </main>

      {/* Footer */}
      <footer className="w-full border-t border-white/[0.06] bg-surface-container-lowest/80 py-6 text-on-surface-variant font-body-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-4 text-xs font-mono-telemetry">
            <span className="flex items-center gap-1.5 text-on-surface">
              <Cloud size={14} className="text-secondary" /> Cloudflare R2 Direct
            </span>
            <span>•</span>
            <span className="flex items-center gap-1.5 text-on-surface">
              <Lock size={14} className="text-primary" /> Workers KV Ephemeral
            </span>
            <span>•</span>
            <span className="flex items-center gap-1.5 text-tertiary">
              <Shield size={14} /> 250 MB Combined Transfer
            </span>
          </div>

          <div className="text-xs text-on-surface-variant/70 text-center sm:text-right">
            <span>GhostShare v1.0 — Raw bytes, zero transcoding, self-destructing data tunnels.</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-canvas-default" />}>
      <GhostShareHome />
    </Suspense>
  );
}
