import { NextResponse } from "next/server";

export const MAX_SESSION_PAYLOAD_BYTES = 8 * 1024; // 8192 bytes (8 KB)
export const MAX_SIGNALING_PAYLOAD_BYTES = 64 * 1024; // 65536 bytes (64 KB)

export type BoundedBodyResult<T> =
  | { ok: true; data: T | null; bytesRead: number }
  | { ok: false; status: 400 | 413; error: string };

/**
 * Reads a Request body incrementally up to maxBytes.
 * Enforces byte limits before buffering or allocating memory for the complete payload.
 *
 * 1. Checks Content-Length header for early rejection if present and oversized.
 * 2. Reads chunks from request.body stream incrementally, tracking exact byte count.
 * 3. Immediately cancels the incoming stream and returns HTTP 413 if the limit is exceeded.
 * 4. Decodes UTF-8 and parses JSON only if total bytes <= maxBytes.
 */
export async function readBoundedJson<T = unknown>(
  request: Request,
  maxBytes: number,
): Promise<BoundedBodyResult<T>> {
  // 1. Check Content-Length header for early rejection if present
  const clHeader = request.headers.get("content-length");
  if (clHeader !== null) {
    const cl = parseInt(clHeader, 10);
    if (!Number.isNaN(cl) && cl > maxBytes) {
      return {
        ok: false,
        status: 413,
        error: `Payload exceeds maximum allowed size (${maxBytes} bytes)`,
      };
    }
  }

  // If no body stream is attached (e.g., empty body)
  if (!request.body) {
    return { ok: true, data: null, bytesRead: 0 };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytesReceived = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      if (value && value.byteLength > 0) {
        bytesReceived += value.byteLength;
        if (bytesReceived > maxBytes) {
          // Immediately cancel the reader to prevent consuming or buffering further incoming stream bytes
          try {
            await reader.cancel("Payload exceeds maximum allowed size");
          } catch {}
          return {
            ok: false,
            status: 413,
            error: `Payload exceeds maximum allowed size (${maxBytes} bytes)`,
          };
        }
        chunks.push(value);
      }
    }
  } catch {
    return {
      ok: false,
      status: 400,
      error: "Stream read failure or unexpected client disconnect",
    };
  }

  if (bytesReceived === 0) {
    return { ok: true, data: null, bytesRead: 0 };
  }

  // Allocate single contiguous buffer matching exact bytes received
  const buffer = new Uint8Array(bytesReceived);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return {
      ok: false,
      status: 400,
      error: "Invalid UTF-8 encoding in request payload",
    };
  }

  if (!text.trim()) {
    return { ok: true, data: null, bytesRead: bytesReceived };
  }

  try {
    const data = JSON.parse(text) as T;
    return { ok: true, data, bytesRead: bytesReceived };
  } catch {
    return {
      ok: false,
      status: 400,
      error: "Invalid JSON format",
    };
  }
}

/**
 * Generates an opaque short correlation error identifier for server diagnostics.
 */
export function generateErrorId(): string {
  try {
    return crypto.randomUUID().slice(0, 8);
  } catch {
    return Math.random().toString(36).slice(2, 10);
  }
}

/**
 * Returns a standardized, safe client-facing error response.
 * Sanitizes internal diagnostic messages to prevent leaking stack traces,
 * database schema details, or sensitive infrastructure exception messages.
 */
export function safeErrorResponse(
  clientMessage: string,
  status: number,
  category = "internal_error",
  internalError?: unknown,
): NextResponse {
  const errorId = generateErrorId();
  if (internalError) {
    const errName = (internalError as Error)?.name || "UnknownError";
    // Internal logging records category, ID, and error name without printing request tokens or file content
    console.error(`[${category}][${errorId}] ${clientMessage} (${errName})`);
  }
  return NextResponse.json(
    { error: clientMessage, errorId },
    { status },
  );
}
