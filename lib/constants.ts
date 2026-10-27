// Selectable expiry windows, shown as buttons in the Send panel.
export const EXPIRY_OPTIONS = [
  { label: "30 min", seconds: 30 * 60 },
  { label: "1 hour", seconds: 60 * 60 },
  { label: "2 hours", seconds: 2 * 60 * 60 },
  { label: "3 hours", seconds: 3 * 60 * 60 },
  { label: "6 hours", seconds: 6 * 60 * 60 },
  { label: "12 hours", seconds: 12 * 60 * 60 },
  { label: "24 hours", seconds: 24 * 60 * 60 },
] as const;

export const DEFAULT_TTL_SECONDS = 60 * 60; // 1 hour - used for the waiting room, before a sender picks
export const MAX_TTL_SECONDS = 24 * 60 * 60;

// Peer-to-peer transfers stream directly without server-side file size caps.
// Maximum file size depends on browser storage capabilities (OPFS disk space, user-selected file destination, or 100 MB RAM fallback).
export const MAX_TRANSFER_BYTES = Infinity;

export function isValidTtl(seconds: unknown): seconds is number {
  return typeof seconds === "number" && EXPIRY_OPTIONS.some((o) => o.seconds === seconds);
}
