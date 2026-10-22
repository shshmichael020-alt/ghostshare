"use client";

import type { Toast } from "@/lib/useToasts";

export default function ToastStack({ toasts }: { toasts: Toast[] }) {
  if (toasts.length === 0) return null;
  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 flex flex-col gap-2 z-50 items-stretch px-4 w-full max-w-sm pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="px-4 py-2.5 rounded-lg border text-sm shadow-xl text-center backdrop-blur-md animate-[toast-in_0.2s_ease-out]"
          style={{
            background: "rgba(25,28,33,0.92)",
            borderColor:
              t.tone === "error" ? "var(--relay-red)" : t.tone === "success" ? "var(--relay-teal)" : "var(--relay-line)",
            color: "var(--relay-text)",
          }}
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}
