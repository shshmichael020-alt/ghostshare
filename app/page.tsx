"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import SendPanel from "@/components/SendPanel";
import ReceivePanel from "@/components/ReceivePanel";
import { Ghost } from "lucide-react";

function Home() {
  const params = useSearchParams();
  const initialMode = params.get("mode") === "send" ? "send" : "receive";
  const initialCode = params.get("code") ?? undefined;
  const [mode, setMode] = useState<"send" | "receive">(initialMode);

  return (
    <main className="min-h-screen flex flex-col items-center px-4 py-10 sm:py-16">
      <div className="w-full max-w-md flex flex-col gap-8">
        <header className="text-center flex flex-col items-center gap-2">
          <div
            className="w-11 h-11 rounded-2xl flex items-center justify-center border"
            style={{ borderColor: "var(--relay-line)", background: "var(--relay-panel)", color: "var(--relay-amber)" }}
          >
            <Ghost size={22} strokeWidth={1.75} />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">GhostShare</h1>
          <p className="text-sm" style={{ color: "var(--relay-text-dim)" }}>
            Move a file between two browsers. No account, no app.
          </p>
        </header>

        <div
          className="relative grid grid-cols-2 p-1 rounded-xl border"
          style={{ borderColor: "var(--relay-line)", background: "var(--relay-panel)" }}
        >
          <div
            className="absolute top-1 bottom-1 w-[calc(50%-4px)] rounded-lg transition-transform duration-300 ease-out"
            style={{
              background: "var(--relay-panel-raised)",
              transform: mode === "send" ? "translateX(0%)" : "translateX(calc(100% + 8px))",
            }}
          />
          {(["send", "receive"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className="relative z-10 py-2.5 rounded-lg text-sm font-medium capitalize transition-colors"
              style={{ color: mode === m ? "var(--relay-amber)" : "var(--relay-text-dim)" }}
            >
              {m}
            </button>
          ))}
        </div>

        <section
          className="rounded-2xl border p-6 sm:p-8"
          style={{ borderColor: "var(--relay-line)", background: "var(--relay-panel)" }}
        >
          {mode === "send" ? <SendPanel initialCode={initialCode} /> : <ReceivePanel />}
        </section>

        <p className="text-center text-xs" style={{ color: "var(--relay-text-dim)" }}>
          Up to 250 MB per transfer · files and codes delete automatically · anyone with the code can access it
        </p>
      </div>
    </main>
  );
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <Home />
    </Suspense>
  );
}
