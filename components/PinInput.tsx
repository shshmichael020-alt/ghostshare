"use client";

import { useRef } from "react";
import { Clipboard } from "lucide-react";

interface PinInputProps {
  value: string;
  onChange: (value: string) => void;
  onComplete?: (code: string) => void;
  disabled?: boolean;
}

export default function PinInput({ value, onChange, onComplete, disabled }: PinInputProps) {
  const inputsRef = useRef<(HTMLInputElement | null)[]>([]);

  // Compute digits directly from controlled value (idiomatic React without cascading effects)
  const digits = Array.from({ length: 8 }, (_, i) => value[i] || "");

  function updateDigits(newDigits: string[]) {
    const combined = newDigits.join("");
    onChange(combined);
    if (combined.length === 8 && onComplete) {
      onComplete(combined);
    }
  }

  function handleDigitChange(index: number, char: string) {
    if (disabled) return;
    const clean = char.replace(/\D/g, "");
    if (!clean) {
      const next = [...digits];
      next[index] = "";
      updateDigits(next);
      return;
    }

    // If mobile keyboard autofilled or sent multiple digits
    if (clean.length > 1) {
      applyPastedCode(clean);
      return;
    }

    const next = [...digits];
    next[index] = clean[clean.length - 1]; // take the latest digit
    updateDigits(next);

    // Auto-advance to next box if available
    if (index < 7) {
      inputsRef.current[index + 1]?.focus();
    }
  }

  function handleKeyDown(index: number, e: React.KeyboardEvent<HTMLInputElement>) {
    if (disabled) return;
    if (e.key === "Backspace") {
      if (!digits[index] && index > 0) {
        inputsRef.current[index - 1]?.focus();
      }
    } else if (e.key === "ArrowLeft" && index > 0) {
      inputsRef.current[index - 1]?.focus();
    } else if (e.key === "ArrowRight" && index < 7) {
      inputsRef.current[index + 1]?.focus();
    }
  }

  function handlePaste(e: React.ClipboardEvent) {
    if (disabled) return;
    e.preventDefault();
    const pasted = e.clipboardData.getData("text");
    applyPastedCode(pasted);
  }

  function applyPastedCode(rawText: string) {
    let cleanCode = "";
    try {
      const url = new URL(rawText.trim());
      const c = url.searchParams.get("code");
      if (c && /^\d{8}$/.test(c)) cleanCode = c;
    } catch {
      // not a url
    }

    if (!cleanCode) {
      cleanCode = rawText.replace(/\D/g, "").slice(0, 8);
    }

    if (cleanCode) {
      const next = Array.from({ length: 8 }, (_, i) => cleanCode[i] || "");
      updateDigits(next);
      const focusIndex = Math.min(7, cleanCode.length);
      inputsRef.current[focusIndex]?.focus();
    }
  }

  async function pasteFromClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      applyPastedCode(text);
    } catch {
      // clipboard permission denied
    }
  }

  return (
    <div className="flex flex-col gap-2.5 items-center w-full">
      <div className="flex items-center justify-between w-full px-0.5">
        <label className="font-label-caps text-on-surface-variant flex items-center gap-1.5 text-[11px] sm:text-xs">
          <span>RECIPIENT SESSION TOKEN</span>
        </label>
        <button
          type="button"
          onClick={pasteFromClipboard}
          disabled={disabled}
          className="flex items-center gap-1 text-[11px] sm:text-xs font-mono-telemetry text-secondary hover:text-secondary-fixed transition-colors cursor-pointer bg-surface-container-high px-2 py-1 rounded border border-white/[0.04]"
        >
          <Clipboard size={12} />
          <span>Paste Code</span>
        </button>
      </div>

      {/* 8-box segmented input grid */}
      <div className="w-full flex items-center justify-center gap-1 sm:gap-1.5 py-1">
        {/* First group of 4 */}
        <div className="flex items-center gap-1 sm:gap-1.5 flex-1 justify-end max-w-[170px]">
          {[0, 1, 2, 3].map((i) => (
            <input
              key={i}
              ref={(el) => {
                inputsRef.current[i] = el;
              }}
              type="text"
              inputMode="numeric"
              maxLength={1}
              value={digits[i]}
              disabled={disabled}
              onChange={(e) => handleDigitChange(i, e.target.value)}
              onKeyDown={(e) => handleKeyDown(i, e)}
              onPaste={handlePaste}
              className="w-full max-w-[38px] aspect-[4/5] bg-surface-container-lowest text-center font-mono-pairing-code text-base sm:text-lg text-on-surface rounded-lg border border-white/[0.08] focus:border-secondary focus:ring-2 focus:ring-secondary/20 focus:outline-none transition-all shadow-inner disabled:opacity-40"
              aria-label={`Digit ${i + 1}`}
            />
          ))}
        </div>

        {/* Separator */}
        <div className="text-outline-variant font-mono-pairing-code select-none px-0.5 sm:px-1 shrink-0">−</div>

        {/* Second group of 4 */}
        <div className="flex items-center gap-1 sm:gap-1.5 flex-1 justify-start max-w-[170px]">
          {[4, 5, 6, 7].map((i) => (
            <input
              key={i}
              ref={(el) => {
                inputsRef.current[i] = el;
              }}
              type="text"
              inputMode="numeric"
              maxLength={1}
              value={digits[i]}
              disabled={disabled}
              onChange={(e) => handleDigitChange(i, e.target.value)}
              onKeyDown={(e) => handleKeyDown(i, e)}
              onPaste={handlePaste}
              className="w-full max-w-[38px] aspect-[4/5] bg-surface-container-lowest text-center font-mono-pairing-code text-base sm:text-lg text-on-surface rounded-lg border border-white/[0.08] focus:border-secondary focus:ring-2 focus:ring-secondary/20 focus:outline-none transition-all shadow-inner disabled:opacity-40"
              aria-label={`Digit ${i + 1}`}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
