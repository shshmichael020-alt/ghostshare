"use client";

import { useEffect, useRef, useState } from "react";
import { X, Camera, AlertCircle, RefreshCw } from "lucide-react";

interface QrScannerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onScanSuccess: (code: string) => void;
}

function extractCode(text: string): string | null {
  const trimmed = text.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 8) return digits;
  try {
    const url = new URL(trimmed);
    const c = url.searchParams.get("code");
    if (c) {
      const clean = c.replace(/\D/g, "");
      if (clean.length === 8) return clean;
    }
  } catch {
    // not a valid url
  }
  return null;
}

export default function QrScannerModal({ isOpen, onClose, onScanSuccess }: QrScannerModalProps) {
  const [error, setError] = useState<string | null>(null);
  const [initializing, setInitializing] = useState(true);
  const scannerRef = useRef<HTMLDivElement>(null);
  const html5QrRef = useRef<import("html5-qrcode").Html5Qrcode | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    let isMounted = true;

    async function startScanner() {
      try {
        const { Html5Qrcode } = await import("html5-qrcode");
        if (!isMounted || !scannerRef.current) return;

        const qr = new Html5Qrcode("qr-scanner-element");
        html5QrRef.current = qr;

        const config = {
          fps: 15,
          qrbox: (viewfinderWidth: number, viewfinderHeight: number) => {
            const minEdge = Math.min(viewfinderWidth, viewfinderHeight);
            const edge = Math.floor(minEdge * 0.75);
            return { width: Math.max(edge, 160), height: Math.max(edge, 160) };
          },
        };

        const onScan = async (decodedText: string) => {
          const code = extractCode(decodedText);
          if (code) {
            try {
              await qr.stop();
              qr.clear();
            } catch {
              // ignore
            }
            onScanSuccess(code);
            onClose();
          }
        };

        // Enumerate video devices first
        let cameras: { id: string; label: string }[] = [];
        try {
          cameras = await Html5Qrcode.getCameras();
        } catch {
          // Camera enumeration may require prior permission
        }

        let started = false;
        if (cameras && cameras.length > 0) {
          // If back camera is detected, use it; otherwise use the primary webcam
          const backCam = cameras.find((c) => /back|rear|environment/i.test(c.label));
          const selectedCamId = backCam ? backCam.id : cameras[0].id;
          try {
            await qr.start(selectedCamId, config, onScan, undefined);
            started = true;
          } catch (camErr) {
            console.warn("Direct deviceId start failed, trying facingMode:", camErr);
          }
        }

        if (!started) {
          try {
            await qr.start({ facingMode: "environment" }, config, onScan, undefined);
            started = true;
          } catch (envErr) {
            console.warn("Environment facingMode failed, falling back to user camera:", envErr);
            await qr.start({ facingMode: "user" }, config, onScan, undefined);
            started = true;
          }
        }

        if (isMounted) {
          setInitializing(false);
          setError(null);
        }
      } catch (err) {
        if (isMounted) {
          console.error("Camera error:", err);
          setError("Unable to access camera. Please check camera permissions or enter the 8-digit code manually.");
          setInitializing(false);
        }
      }
    }

    const timer = setTimeout(startScanner, 10);

    return () => {
      isMounted = false;
      clearTimeout(timer);
      if (html5QrRef.current) {
        try {
          html5QrRef.current.stop().then(() => html5QrRef.current?.clear()).catch(() => {});
        } catch {
          // ignore
        }
      }
    };
  }, [isOpen, onClose, onScanSuccess]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md">
      <div
        className="w-full max-w-md bg-surface-container rounded-2xl border border-white/[0.1] shadow-2xl overflow-hidden flex flex-col"
        role="dialog"
        aria-modal="true"
        aria-labelledby="qr-scanner-title"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-white/[0.08] bg-surface-container-high/60">
          <div className="flex items-center gap-2">
            <Camera size={18} className="text-secondary" />
            <h2 id="qr-scanner-title" className="font-headline-md text-on-surface">
              Scan Pairing QR Code
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-on-surface-variant hover:text-on-surface hover:bg-surface-container-highest transition-colors cursor-pointer"
            aria-label="Close scanner"
          >
            <X size={18} />
          </button>
        </div>

        {/* Video feed viewport */}
        <div className="p-6 flex flex-col items-center justify-center gap-4">
          <div className="relative w-full max-w-[280px] aspect-square rounded-xl overflow-hidden bg-black border border-white/[0.1] shadow-inner flex items-center justify-center">
            <div id="qr-scanner-element" ref={scannerRef} className="w-full h-full" />
            {initializing && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-surface-container-lowest/90 text-on-surface-variant font-mono-telemetry">
                <RefreshCw size={24} className="animate-spin text-secondary" />
                <span>Initializing camera sensor...</span>
              </div>
            )}
          </div>

          {error ? (
            <div className="p-3 rounded-lg bg-error-container/20 border border-error/30 text-error flex items-start gap-2 text-xs font-body-sm w-full">
              <AlertCircle size={16} className="shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          ) : (
            <p className="font-body-sm text-on-surface-variant text-center">
              Align the QR code displayed on the receiving screen within the frame.
            </p>
          )}

          <button
            onClick={onClose}
            className="w-full py-2.5 rounded-lg bg-surface-container-highest hover:bg-surface-bright text-on-surface font-body-sm font-medium transition-colors cursor-pointer border border-white/[0.08]"
          >
            Switch to Manual Code Entry
          </button>
        </div>
      </div>
    </div>
  );
}
