"use client";

import type { Toast } from "@/lib/useToasts";
import { CheckCircle2, AlertCircle, Info, X } from "lucide-react";

interface ToastStackProps {
  toasts: Toast[];
  onDismiss?: (id: string) => void;
}

export default function ToastStack({ toasts, onDismiss }: ToastStackProps) {
  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-20 inset-x-4 sm:top-20 sm:right-6 sm:left-auto sm:inset-x-auto sm:max-w-md sm:w-full z-50 flex flex-col gap-2.5 max-w-md mx-auto pointer-events-none">
      {toasts.map((t) => {
        const isError = t.tone === "error";
        const isSuccess = t.tone === "success";

        return (
          <div
            key={t.id}
            className={`pointer-events-auto flex items-center justify-between gap-3 px-4 py-3 rounded-xl border shadow-2xl backdrop-blur-xl transition-all duration-300 animate-toast ${
              isError
                ? "bg-surface-container-high/95 border-error/30 text-error"
                : isSuccess
                ? "bg-surface-container-high/95 border-tertiary/30 text-on-surface"
                : "bg-surface-container-high/95 border-white/[0.1] text-on-surface"
            }`}
          >
            <div className="flex items-center gap-2.5 min-w-0 flex-1">
              {isError ? (
                <AlertCircle size={16} className="text-error shrink-0" />
              ) : isSuccess ? (
                <CheckCircle2 size={16} className="text-tertiary shrink-0" />
              ) : (
                <Info size={16} className="text-secondary shrink-0" />
              )}
              <span className="font-body-sm font-medium break-words text-xs sm:text-sm leading-snug">{t.message}</span>
            </div>
            {onDismiss && (
              <button
                onClick={() => onDismiss(t.id)}
                className="p-1 rounded text-on-surface-variant hover:text-on-surface transition-colors cursor-pointer shrink-0 ml-1"
                aria-label="Dismiss toast"
              >
                <X size={14} />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
