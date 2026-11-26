"use client";

import { Ghost, ShieldCheck, Moon, Sun } from "lucide-react";
import { useTheme } from "@/lib/theme";

interface HeaderProps {
  mode: "receive" | "send" | "dual";
  onModeChange: (mode: "receive" | "send" | "dual") => void;
  onOpenSecurity: () => void;
}

export default function Header({ mode, onModeChange, onOpenSecurity }: HeaderProps) {
  const { isLight, toggleTheme } = useTheme();
  const themeActionLabel = isLight ? "Switch to Dark Mode" : "Switch to Light Mode";

  return (
    <header className="fixed top-0 left-0 right-0 z-40 bg-surface-container-lowest/85 backdrop-blur-xl border-b border-border-default shadow-header transition-colors duration-200">
      <div className="h-16 w-full max-w-7xl mx-auto px-2.5 sm:px-6 flex items-center justify-between gap-1.5 sm:gap-4">
        {/* Brand identity */}
        <div className="flex items-center gap-1.5 sm:gap-3 shrink-0">
          <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg bg-surface-container-high border border-border-default flex items-center justify-center text-primary shadow-sm shrink-0 transition-colors duration-200">
            <Ghost size={17} strokeWidth={2} />
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className="tracking-tight font-semibold text-on-surface text-[15px] sm:text-xl whitespace-nowrap">
              GhostShare
            </span>
            <span className="hidden sm:inline-block px-2 py-0.5 rounded bg-surface-container-high text-on-surface-variant font-label-caps uppercase border border-border-subtle">
              v1.0 • WebRTC P2P
            </span>
          </div>
          <div className="hidden lg:flex items-center gap-1.5 px-3 py-1 rounded-full bg-surface-container-low border border-border-default transition-colors duration-200">
            <span className="h-1.5 w-1.5 rounded-full bg-tertiary animate-pulse" />
            <span className="font-mono-telemetry text-tertiary">WebRTC P2P Direct • Zero Cloud Storage</span>
          </div>
        </div>

        {/* Central Mode Switcher */}
        <nav
          aria-label="Mode Navigation"
          className="flex items-center bg-surface-container-low p-0.5 sm:p-1 rounded-xl border border-border-default transition-colors duration-200 shrink-0"
        >
          <button
            onClick={() => onModeChange("receive")}
            aria-current={mode === "receive" ? "page" : undefined}
            className={`px-2 sm:px-4 py-1.5 rounded-lg font-body-sm transition-all duration-200 cursor-pointer ${
              mode === "receive"
                ? "bg-surface-container-highest text-on-surface font-medium shadow-sm border border-border-default"
                : "text-on-surface-variant hover:text-on-surface"
            }`}
          >
            Receive <span className="hidden sm:inline">Files</span>
          </button>
          <button
            onClick={() => onModeChange("send")}
            aria-current={mode === "send" ? "page" : undefined}
            className={`px-2 sm:px-4 py-1.5 rounded-lg font-body-sm transition-all duration-200 cursor-pointer ${
              mode === "send"
                ? "bg-surface-container-highest text-on-surface font-medium shadow-sm border border-border-default"
                : "text-on-surface-variant hover:text-on-surface"
            }`}
          >
            Send <span className="hidden sm:inline">Files</span>
          </button>
          <button
            onClick={() => onModeChange("dual")}
            aria-current={mode === "dual" ? "page" : undefined}
            className={`px-2 sm:px-4 py-1.5 rounded-lg font-body-sm transition-all duration-200 cursor-pointer ${
              mode === "dual"
                ? "bg-surface-container-highest text-on-surface font-medium shadow-sm border border-border-default"
                : "text-on-surface-variant hover:text-on-surface"
            }`}
          >
            Dual <span className="hidden sm:inline">Mode</span>
          </button>
        </nav>

        {/* Action controls */}
        <div className="flex items-center gap-1 sm:gap-2.5 shrink-0">
          <button
            type="button"
            onClick={toggleTheme}
            aria-label={themeActionLabel}
            title={themeActionLabel}
            className="flex items-center justify-center w-7 h-7 sm:w-8 sm:h-8 rounded-lg text-on-surface-variant hover:text-on-surface hover:bg-surface-container-low transition-all duration-200 cursor-pointer border border-transparent hover:border-border-default focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
          >
            {isLight ? (
              <Sun size={16} className="text-warning transition-transform duration-200" />
            ) : (
              <Moon size={16} className="text-primary transition-transform duration-200" />
            )}
          </button>

          <button
            onClick={onOpenSecurity}
            className="flex items-center gap-1.5 px-1.5 sm:px-3 py-1.5 rounded-lg text-on-surface-variant hover:text-on-surface hover:bg-surface-container-low transition-colors duration-200 font-body-sm cursor-pointer border border-transparent hover:border-border-default"
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
