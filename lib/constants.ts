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

// Cap applies to the WHOLE transfer (one session), not per file - a sender
// can add file after file until this running total is reached.
export const MAX_TRANSFER_BYTES = 250 * 1024 * 1024; // 250 MB

export function isValidTtl(seconds: unknown): seconds is number {
  return typeof seconds === "number" && EXPIRY_OPTIONS.some((o) => o.seconds === seconds);
}
