"use client";

import { Ghost, ShieldCheck } from "lucide-react";

interface HeaderProps {
  mode: "receive" | "send";
  onModeChange: (mode: "receive" | "send") => void;
  onOpenSecurity: () => void;
}

export default function Header({ mode, onModeChange, onOpenSecurity }: HeaderProps) {
  return (
    <header className="fixed top-0 left-0 right-0 z-40 bg-surface-container-lowest/85 backdrop-blur-xl border-b border-white/[0.06] shadow-[0_1px_8px_rgba(0,0,0,0.4)]">
      <div className="h-16 w-full max-w-7xl mx-auto px-4 sm:px-6 flex items-center justify-between gap-4">
        {/* Brand identity */}
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-surface-container-high border border-white/[0.08] flex items-center justify-center text-primary shadow-sm">
            <Ghost size={18} strokeWidth={2} />
          </div>
          <div className="flex items-center gap-2">
            <span className="font-headline-md tracking-tight font-semibold text-on-surface">GhostShare</span>
            <span className="hidden sm:inline-block px-2 py-0.5 rounded bg-surface-container-high text-on-surface-variant font-label-caps uppercase border border-white/[0.04]">
              v1.0 • R2 Direct
            </span>
          </div>
          <div className="hidden lg:flex items-center gap-1.5 px-3 py-1 rounded-full bg-surface-container-low border border-white/[0.06]">
            <span className="h-1.5 w-1.5 rounded-full bg-tertiary animate-pulse" />
            <span className="font-mono-telemetry text-tertiary">Workers KV Online • Low Latency</span>
          </div>
        </div>

        {/* Central Mode Switcher */}
        <nav
          aria-label="Mode Navigation"
          className="flex items-center bg-surface-container-low p-1 rounded-xl border border-white/[0.06]"
        >
          <button
            onClick={() => onModeChange("receive")}
            aria-current={mode === "receive" ? "page" : undefined}
            className={`px-3 sm:px-4 py-1.5 rounded-lg font-body-sm transition-all duration-200 cursor-pointer ${
              mode === "receive"
                ? "bg-surface-container-highest text-on-surface font-medium shadow-sm border border-white/[0.06]"
                : "text-on-surface-variant hover:text-on-surface"
            }`}
          >
            Receive <span className="hidden sm:inline">Files</span>
          </button>
          <button
            onClick={() => onModeChange("send")}
            aria-current={mode === "send" ? "page" : undefined}
            className={`px-3 sm:px-4 py-1.5 rounded-lg font-body-sm transition-all duration-200 cursor-pointer ${
              mode === "send"
                ? "bg-surface-container-highest text-on-surface font-medium shadow-sm border border-white/[0.06]"
                : "text-on-surface-variant hover:text-on-surface"
            }`}
          >
            Send <span className="hidden sm:inline">Files</span>
          </button>
        </nav>

        {/* Action controls */}
        <div className="flex items-center gap-2 sm:gap-3">
          <button
            onClick={onOpenSecurity}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-on-surface-variant hover:text-on-surface hover:bg-surface-container-low transition-colors font-body-sm cursor-pointer border border-transparent hover:border-white/[0.06]"
            title="Inspect Security & Architectural Specifications"
          >
            <ShieldCheck size={16} className="text-secondary" />
            <span className="hidden md:inline">Security & Specs</span>
          </button>
        </div>
      </div>
    </header>
  );
}
