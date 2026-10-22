"use client";

import { useState } from "react";
import { Copy, Check } from "lucide-react";

interface PinDisplayProps {
  code: string | null;
  onCopy?: () => void;
}

export default function PinDisplay({ code, onCopy }: PinDisplayProps) {
  const [copied, setCopied] = useState(false);

  const part1 = code ? code.slice(0, 4) : "····";
  const part2 = code ? code.slice(4, 8) : "····";

  async function handleCopy() {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      if (onCopy) onCopy();
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // fallback
    }
  }

  return (
    <div className="flex flex-col sm:flex-row items-center justify-between gap-4 bg-surface-container-lowest p-4 sm:p-5 rounded-xl border border-white/[0.08] shadow-inner w-full">
      {/* 8-Digit Segmented Code Display */}
      <div className="flex items-center gap-3 select-all">
        <span className="font-mono-pairing-code text-on-surface tracking-widest drop-shadow-sm">
          {part1}
        </span>
        <span className="text-outline-variant font-mono-pairing-code font-light select-none">
          -
        </span>
        <span className="font-mono-pairing-code text-secondary tracking-widest drop-shadow-sm">
          {part2}
        </span>
      </div>

      {/* Copy Code Action Button */}
      <button
        onClick={handleCopy}
        disabled={!code}
        className="w-full sm:w-auto flex items-center justify-center gap-2 px-4 py-2.5 bg-primary text-on-primary hover:bg-primary-container hover:text-on-primary-container active:scale-95 transition-all rounded-lg font-body-sm font-medium shadow-md cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {copied ? (
          <>
            <Check size={16} />
            <span>COPIED</span>
          </>
        ) : (
          <>
            <Copy size={16} />
            <span>Copy Code</span>
          </>
        )}
      </button>
    </div>
  );
}
