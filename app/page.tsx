"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import Header from "@/components/Header";
import SecurityModal from "@/components/SecurityModal";
import SendPanel from "@/components/SendPanel";
import ReceivePanel from "@/components/ReceivePanel";
import DualPanel from "@/components/DualPanel";
import EphemeralChat from "@/components/EphemeralChat";
import { SessionProvider, useGhostSession } from "@/context/SessionContext";
import { Shield, Radio, Lock } from "lucide-react";

function GhostShareContent({ initialCode }: { initialCode?: string }) {
  const { mode, setMode, connStatus, disconnectSession } = useGhostSession();
  const [isSecurityOpen, setIsSecurityOpen] = useState(false);

  const handleModeChange = (newMode: "receive" | "send" | "dual") => {
    if (newMode !== mode) {
      if (connStatus !== "connected") {
        disconnectSession();
      }
      setMode(newMode);
      if (typeof window !== "undefined") {
        const url = new URL(window.location.href);
        url.searchParams.set("mode", newMode);
        window.history.replaceState(null, "", url.toString());
      }
    }
  };

  return (
    <div className="min-h-screen flex flex-col justify-between bg-surface selection:bg-primary-container selection:text-on-primary-container relative overflow-x-hidden">
      {/* Brand Header */}
      <Header
        mode={mode}
        onModeChange={handleModeChange}
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
          ) : mode === "send" ? (
            <SendPanel initialCode={initialCode} />
          ) : (
            <DualPanel initialCode={initialCode} />
          )}
        </div>
      </main>

      {/* Floating Ephemeral Live Chat (RAM-only, zero-storage) */}
      <EphemeralChat />

      {/* Footer */}
      <footer className="w-full border-t border-white/[0.06] bg-surface-container-lowest/80 py-6 text-on-surface-variant font-body-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-4 text-xs font-mono-telemetry">
            <span className="flex items-center gap-1.5 text-on-surface">
              <Radio size={14} className="text-secondary" /> WebRTC P2P Direct
            </span>
            <span>•</span>
            <span className="flex items-center gap-1.5 text-on-surface">
              <Lock size={14} className="text-primary" /> DTLS 1.3 Encrypted
            </span>
            <span>•</span>
            <span className="flex items-center gap-1.5 text-tertiary">
              <Shield size={14} /> Zero Cloud Storage • Unlimited P2P
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

function GhostShareWrapper() {
  const searchParams = useSearchParams();
  const rawMode = searchParams.get("mode");
  const initialMode =
    rawMode === "send" ? "send" : rawMode === "dual" ? "dual" : "receive";
  const initialCode = searchParams.get("code") ?? undefined;

  return (
    <SessionProvider initialMode={initialMode}>
      <GhostShareContent initialCode={initialCode} />
    </SessionProvider>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-canvas-default" />}>
      <GhostShareWrapper />
    </Suspense>
  );
}
