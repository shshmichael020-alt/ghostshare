"use client";

import { useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import PinDisplay from "./PinDisplay";
import { FileTypeIcon } from "./FileTypeIcon";
import ToastStack from "./ToastStack";
import { useToasts } from "@/lib/useToasts";
import { formatSize, formatCountdown } from "@/lib/format";
import { Copy, Check, Share2, Download, RefreshCw } from "lucide-react";

type StoredFile = {
  objectKey: string;
  downloadUrl: string;
  name: string;
  size: number;
  uploadedAt: number;
};

export default function ReceivePanel() {
  const [code, setCode] = useState<string | null>(null);
  const [files, setFiles] = useState<StoredFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [copied, setCopied] = useState<"code" | "link" | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const knownCountRef = useRef(0);
  const { toasts, push } = useToasts();

  async function startSession() {
    setError(null);
    setExpired(false);
    setFiles([]);
    setCode(null);
    setRemaining(null);
    knownCountRef.current = 0;
    try {
      const res = await fetch("/api/session", { method: "POST" });
      if (!res.ok) throw new Error("Could not start a session");
      const data = (await res.json()) as { code: string };
      setCode(data.code);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    startSession();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (tickRef.current) clearInterval(tickRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!code) return;
    if (pollRef.current) clearInterval(pollRef.current);

    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/session/${code}`, { cache: "no-store" });
        if (res.status === 404) {
          setExpired(true);
          if (pollRef.current) clearInterval(pollRef.current);
          return;
        }
        if (!res.ok) return;
        const data = (await res.json()) as { files?: StoredFile[]; remainingSeconds?: number };
        const newFiles: StoredFile[] = data.files ?? [];
        if (newFiles.length > knownCountRef.current) {
          const arrived = newFiles.slice(knownCountRef.current);
          arrived.forEach((f) => push(`${f.name} arrived`, "success"));
          if (typeof document !== "undefined") {
            document.title = `(${newFiles.length}) File ready — Relay`;
          }
        }
        knownCountRef.current = newFiles.length;
        setFiles(newFiles);
        if (typeof data.remainingSeconds === "number") setRemaining(data.remainingSeconds);
      } catch {
        // transient network hiccup, keep polling
      }
    }, 2000);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  useEffect(() => {
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = setInterval(() => {
      setRemaining((r) => (r !== null && r > 0 ? r - 1 : r));
    }, 1000);
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, [code]);

  const qrValue =
    typeof window !== "undefined" && code ? `${window.location.origin}/?mode=send&code=${code}` : "";

  async function copyCode() {
    if (!code) return;
    await navigator.clipboard.writeText(code);
    setCopied("code");
    push("Code copied", "default");
    setTimeout(() => setCopied(null), 1500);
  }

  async function copyLink() {
    if (!qrValue) return;
    await navigator.clipboard.writeText(qrValue);
    setCopied("link");
    push("Link copied", "default");
    setTimeout(() => setCopied(null), 1500);
  }

  async function shareLink() {
    if (!qrValue) return;
    if (navigator.share) {
      try {
        await navigator.share({ title: "Relay pairing link", url: qrValue });
      } catch {
        // user canceled the share sheet, ignore
      }
    } else {
      copyLink();
    }
  }

  return (
    <div className="flex flex-col items-center gap-6 text-center">
      <ToastStack toasts={toasts} />
      {error && <p className="text-sm" style={{ color: "var(--relay-red)" }}>{error}</p>}

      {expired ? (
        <div className="flex flex-col items-center gap-4 py-6">
          <p style={{ color: "var(--relay-text-dim)" }}>This code expired.</p>
          <button
            onClick={startSession}
            className="px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-1.5"
            style={{ background: "var(--relay-amber)", color: "#161311" }}
          >
            <RefreshCw size={14} /> Get a new code
          </button>
        </div>
      ) : (
        <>
          <div className="p-3 rounded-xl relative overflow-hidden" style={{ background: "#fff" }}>
            {code ? (
              <QRCodeSVG value={qrValue} size={168} bgColor="#ffffff" fgColor="#101215" />
            ) : (
              <div className="w-[168px] h-[168px] animate-pulse bg-neutral-300 rounded" />
            )}
          </div>

          <div className="flex flex-col items-center gap-2">
            <p className="text-xs uppercase tracking-[0.2em]" style={{ color: "var(--relay-text-dim)" }}>
              Or enter this on the sending device
            </p>
            <button onClick={copyCode} className="group relative">
              <PinDisplay code={code} />
              <span
                className="absolute -right-6 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity"
                style={{ color: "var(--relay-text-dim)" }}
              >
                {copied === "code" ? <Check size={14} /> : <Copy size={14} />}
              </span>
            </button>
          </div>

          <div className="flex gap-2">
            <button
              onClick={copyLink}
              className="text-xs px-3 py-1.5 rounded-full border flex items-center gap-1.5 transition-colors"
              style={{ borderColor: "var(--relay-line)", color: "var(--relay-text-dim)" }}
            >
              {copied === "link" ? <Check size={13} /> : <Copy size={13} />} Copy link
            </button>
            <button
              onClick={shareLink}
              className="text-xs px-3 py-1.5 rounded-full border flex items-center gap-1.5 transition-colors"
              style={{ borderColor: "var(--relay-line)", color: "var(--relay-text-dim)" }}
            >
              <Share2 size={13} /> Share
            </button>
          </div>

          <div className="flex items-center gap-2 text-sm" style={{ color: "var(--relay-text-dim)" }}>
            {files.length === 0 ? (
              <>
                <span className="w-2 h-2 rounded-full pulse-dot" style={{ background: "var(--relay-teal)" }} />
                Waiting for a file&hellip;
              </>
            ) : (
              <span style={{ color: "var(--relay-teal)" }}>
                {files.length} file{files.length > 1 ? "s" : ""} ready
              </span>
            )}
          </div>

          {files.length > 0 && (
            <div className="w-full flex flex-col gap-2 mt-2">
              {files.map((f) => (
                <a
                  key={f.objectKey}
                  href={f.downloadUrl}
                  className="flex items-center gap-3 px-4 py-3 rounded-lg border transition-colors hover:border-[var(--relay-amber)]"
                  style={{ borderColor: "var(--relay-line)", background: "var(--relay-panel-raised)" }}
                >
                  <FileTypeIcon name={f.name} className="shrink-0" size={18} />
                  <span className="truncate text-sm text-left flex-1" title={f.name}>
                    {f.name}
                  </span>
                  <span
                    className="text-xs font-mono-relay whitespace-nowrap flex items-center gap-1.5"
                    style={{ color: "var(--relay-text-dim)" }}
                  >
                    {formatSize(f.size)}
                    <Download size={13} />
                  </span>
                </a>
              ))}
            </div>
          )}

          <p className="text-xs font-mono-relay" style={{ color: "var(--relay-text-dim)" }}>
            {remaining !== null ? (
              <>Expires in {formatCountdown(remaining)} · anyone with this code can access it</>
            ) : (
              "anyone with this code can access it"
            )}
          </p>
        </>
      )}
    </div>
  );
}
