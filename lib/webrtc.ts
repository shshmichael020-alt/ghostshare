export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  // High-performance Anycast public STUN endpoints with verified low latency worldwide
  { urls: "stun:stun.cloudflare.com:3478" },
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" },
  { urls: "stun:stun3.l.google.com:19302" },
  { urls: "stun:stun4.l.google.com:19302" },
  { urls: "stun:global.stun.twilio.com:3478" },
  // OpenRelay TURN servers with multi-transport (UDP, TCP, and TLS)
  {
    urls: [
      "turn:openrelay.metered.ca:80",
      "turn:openrelay.metered.ca:443",
      "turn:openrelay.metered.ca:443?transport=tcp",
    ],
    username: "openrelayproject",
    credential: "openrelayproject",
  },
];

/**
 * Fetches dynamic ICE configuration from server-side endpoint if available,
 * gracefully falling back to DEFAULT_ICE_SERVERS on error or timeout.
 */
export async function fetchIceServers(): Promise<RTCIceServer[]> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch("/api/signal/ice-servers", { signal: controller.signal });
    clearTimeout(timeout);
    if (res.ok) {
      const data = (await res.json()) as { iceServers?: RTCIceServer[] };
      if (Array.isArray(data.iceServers) && data.iceServers.length > 0) {
        return data.iceServers;
      }
    }
  } catch {}
  return DEFAULT_ICE_SERVERS;
}

/**
 * Waits for ICE gathering to complete or times out gracefully.
 * Pre-gathers initial host and STUN candidates directly into the offer/answer SDP.
 */
export async function waitForIceGathering(pc: RTCPeerConnection, timeoutMs = 600): Promise<void> {
  if (pc.iceGatheringState === "complete") return;
  return new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const checkState = () => {
      if (pc.iceGatheringState === "complete") {
        if (timer) clearTimeout(timer);
        pc.removeEventListener("icegatheringstatechange", checkState);
        resolve();
      }
    };
    pc.addEventListener("icegatheringstatechange", checkState);
    timer = setTimeout(() => {
      pc.removeEventListener("icegatheringstatechange", checkState);
      resolve();
    }, timeoutMs);
  });
}

export const CHUNK_SIZE = 32 * 1024; // 32 KB chunk size for safe SCTP MTU traversal
export const MAX_BUFFERED_AMOUNT = 256 * 1024; // 256 KB high-water mark for backpressure

export const DATA_CHANNEL_LABELS = {
  CONTROL: "control",
  FILES_JOINER_TO_CREATOR: "files-joiner-to-creator",
  FILES_CREATOR_TO_JOINER: "files-creator-to-joiner",
  LEGACY_FILE_TRANSFER: "file-transfer",
} as const;

export interface TransferManifestFile {
  id: string;
  name: string;
  size: number;
  type: string;
}

export type WebRTCMessage =
  | { type: "transfer-request"; files: TransferManifestFile[]; batchId?: string; senderRole?: "creator" | "joiner" }
  | { type: "transfer-accept"; batchId?: string; senderRole?: "creator" | "joiner" }
  | { type: "transfer-decline"; reason?: string; batchId?: string; senderRole?: "creator" | "joiner" }
  | { type: "file-start"; id: string; name: string; size: number; mimeType: string; offset?: number; batchId?: string; senderRole?: "creator" | "joiner" }
  | { type: "file-ready"; id: string; batchId?: string; senderRole?: "creator" | "joiner" }
  | { type: "file-end"; id: string; batchId?: string; senderRole?: "creator" | "joiner" }
  | { type: "file-ack"; id: string; batchId?: string; senderRole?: "creator" | "joiner" }
  | { type: "file-error"; id: string; error: string; batchId?: string; senderRole?: "creator" | "joiner" }
  | { type: "resume-query"; id: string; senderRole?: "creator" | "joiner" }
  | { type: "resume-ack"; id: string; receivedBytes: number; senderRole?: "creator" | "joiner" }
  | { type: "transfer-complete"; batchId?: string; senderRole?: "creator" | "joiner" }
  | { type: "chat"; id: string; text: string; sentAt: number; senderRole?: "creator" | "joiner"; senderName?: string };

export const BINARY_FRAME_MAGIC = 0x4753; // 'GS' ASCII identifier

/**
 * Encodes a binary chunk with a structured framing header:
 * [0..1] Magic bytes (0x47, 0x53)
 * [2]    Version (0x01)
 * [3]    Flags (0x00)
 * [4]    File ID length N (1 byte)
 * [5..5+N-1] File ID UTF-8 (N bytes)
 * [5+N..5+N+3] Chunk Index (uint32 BE)
 * [5+N+4..5+N+11] Chunk Offset (uint64 BE)
 * [5+N+12..] Raw chunk binary payload
 */
export function encodeBinaryFrame(
  fileId: string,
  chunkIndex: number,
  offset: number,
  payload: ArrayBuffer,
): ArrayBuffer {
  const enc = new TextEncoder();
  const idBytes = enc.encode(fileId);
  if (idBytes.length > 255) {
    throw new Error("File ID exceeds 255 bytes limit");
  }
  const headerLen = 5 + idBytes.length + 4 + 8;
  const out = new Uint8Array(headerLen + payload.byteLength);
  const view = new DataView(out.buffer);

  view.setUint16(0, BINARY_FRAME_MAGIC, false);
  view.setUint8(2, 1); // version 1
  view.setUint8(3, 0); // flags
  view.setUint8(4, idBytes.length);
  out.set(idBytes, 5);

  const idxOffset = 5 + idBytes.length;
  view.setUint32(idxOffset, chunkIndex, false);
  view.setBigUint64(idxOffset + 4, BigInt(offset), false);

  out.set(new Uint8Array(payload), idxOffset + 12);
  return out.buffer;
}

/**
 * Decodes a binary frame. If magic bytes match, returns structured metadata & payload slice.
 * If not matching magic bytes, returns null to allow raw unframed binary fallback.
 */
export function decodeBinaryFrame(
  buffer: ArrayBuffer,
): { fileId: string; chunkIndex: number; offset: number; payload: ArrayBuffer } | null {
  if (buffer.byteLength < 18) return null;
  const view = new DataView(buffer);
  if (view.getUint16(0, false) !== BINARY_FRAME_MAGIC) {
    return null;
  }
  const idLen = view.getUint8(4);
  const headerLen = 5 + idLen + 4 + 8;
  if (buffer.byteLength < headerLen) return null;

  const idBytes = new Uint8Array(buffer, 5, idLen);
  const dec = new TextDecoder();
  const fileId = dec.decode(idBytes);

  const idxOffset = 5 + idLen;
  const chunkIndex = view.getUint32(idxOffset, false);
  const offset = Number(view.getBigUint64(idxOffset + 4, false));

  const payload = buffer.slice(idxOffset + 12);
  return { fileId, chunkIndex, offset, payload };
}

/**
 * Validates that an ICE candidate object contains a non-empty candidate string.
 * Prevents mobile WebRTC crashes caused by processing empty end-of-candidate markers.
 */
export function isValidIceCandidateInit(cand: unknown): cand is RTCIceCandidateInit {
  if (!cand || typeof cand !== "object") return false;
  const c = cand as Record<string, unknown>;
  return typeof c.candidate === "string" && c.candidate.trim().length > 0;
}

/**
 * Creates an RTCPeerConnection configured for robust mobile, desktop, and cross-NAT traversal.
 * Enforces max-bundle to multiplex all channels on a single socket, preventing mobile OS drops.
 */
export function createPeerConnection(customIceServers?: RTCIceServer[]): RTCPeerConnection {
  const config: RTCConfiguration = {
    iceServers: customIceServers && customIceServers.length > 0 ? customIceServers : DEFAULT_ICE_SERVERS,
    iceTransportPolicy: "all",
    bundlePolicy: "max-bundle",
    iceCandidatePoolSize: 2,
  };
  return new RTCPeerConnection(config);
}

/**
 * Sends a binary chunk across RTCDataChannel respecting backpressure.
 * If bufferedAmount exceeds MAX_BUFFERED_AMOUNT, halts sending until bufferedamountlow triggers.
 */
export async function sendChunkWithBackpressure(
  channel: RTCDataChannel,
  chunk: ArrayBuffer,
): Promise<void> {
  if (channel.readyState !== "open") {
    throw new Error("Data channel is closed");
  }

  // Ensure threshold is configured for browser notification
  if (channel.bufferedAmountLowThreshold === 0) {
    channel.bufferedAmountLowThreshold = 64 * 1024;
  }

  // If buffer is above high-water mark, wait for drain or failsafe timeout
  while (channel.bufferedAmount > MAX_BUFFERED_AMOUNT) {
    if (channel.readyState !== "open") {
      throw new Error("Data channel closed while waiting for buffer to drain");
    }

    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const onLow = () => {
        if (timer) clearTimeout(timer);
        channel.removeEventListener("bufferedamountlow", onLow);
        resolve();
      };
      channel.addEventListener("bufferedamountlow", onLow);
      timer = setTimeout(() => {
        channel.removeEventListener("bufferedamountlow", onLow);
        resolve();
      }, 30);
    });
  }

  channel.send(chunk);
}

/**
 * Streams a single File chunk-by-chunk across RTCDataChannel.
 * Slices the file on demand so large payloads never saturate browser RAM.
 * Frames each chunk with structured metadata and enforces explicit readiness and write acknowledgements.
 * Control messages (signals) can optionally use a dedicated controlChannel to avoid backpressure head-of-line blocking.
 */
export async function streamFileOverDataChannel(
  channel: RTCDataChannel,
  file: File,
  fileId: string,
  startOffset: number = 0,
  onProgress: (sentBytes: number, totalBytes: number) => void,
  isCancelled: () => boolean,
  controlChannel?: RTCDataChannel,
  batchId?: string,
): Promise<void> {
  const ctrl = controlChannel || channel;
  if (channel.readyState !== "open" || ctrl.readyState !== "open") {
    throw new Error("Data channel is not open");
  }

  const total = file.size;
  let offset = Math.min(startOffset, total);

  // Signal start of file transmission with unique ID, batch ID, and offset on control channel
  const startMsg: WebRTCMessage = {
    type: "file-start",
    id: fileId,
    name: file.name,
    size: file.size,
    mimeType: file.type || "application/octet-stream",
    offset,
    batchId,
  };
  ctrl.send(JSON.stringify(startMsg));

  // Await explicit receiver file-ready confirmation before sending binary data
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    const onMessage = (e: MessageEvent) => {
      if (typeof e.data === "string") {
        try {
          const m = JSON.parse(e.data) as WebRTCMessage;
          if (m.type === "file-ready" && m.id === fileId) {
            cleanup();
            resolve();
          } else if (m.type === "file-error" && m.id === fileId) {
            cleanup();
            reject(new Error(`Receiver rejected file: ${m.error}`));
          }
        } catch {}
      }
    };

    const onClose = () => {
      cleanup();
      reject(new Error("Data channel closed while waiting for receiver readiness"));
    };

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      ctrl.removeEventListener("message", onMessage);
      ctrl.removeEventListener("close", onClose);
    };

    ctrl.addEventListener("message", onMessage);
    ctrl.addEventListener("close", onClose);

    timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Receiver readiness confirmation timed out for file ID: ${fileId}`));
    }, 8000);
  });

  // Stream binary slices with backpressure flow control and framed metadata
  let chunkIndex = 0;
  while (offset < total) {
    if (isCancelled()) {
      throw new Error("Transfer cancelled by user");
    }

    if (channel.readyState !== "open") {
      throw new Error("Data channel closed during file streaming");
    }

    const end = Math.min(offset + CHUNK_SIZE, total);
    const slice = file.slice(offset, end);
    const rawBuffer = await slice.arrayBuffer();

    // Frame the binary chunk with fileId, chunkIndex, and byte offset for concurrent routing safety
    const framedChunk = encodeBinaryFrame(fileId, chunkIndex, offset, rawBuffer);
    await sendChunkWithBackpressure(channel, framedChunk);

    offset = end;
    chunkIndex++;
    onProgress(offset, total);
  }

  // Ensure all queued binary chunks are completely flushed from the data channel buffer
  while (channel.bufferedAmount > 0) {
    if (channel.readyState !== "open") break;
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const onLow = () => {
        if (timer) clearTimeout(timer);
        channel.removeEventListener("bufferedamountlow", onLow);
        resolve();
      };
      channel.addEventListener("bufferedamountlow", onLow);
      timer = setTimeout(() => {
        channel.removeEventListener("bufferedamountlow", onLow);
        resolve();
      }, 30);
    });
  }

  // Signal end of file on control channel
  const endMsg: WebRTCMessage = {
    type: "file-end",
    id: fileId,
    batchId,
  };
  ctrl.send(JSON.stringify(endMsg));

  // Await explicit completion acknowledgement from receiver after disk flush
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    const onMessage = (e: MessageEvent) => {
      if (typeof e.data === "string") {
        try {
          const m = JSON.parse(e.data) as WebRTCMessage;
          if (m.type === "file-ack" && m.id === fileId) {
            cleanup();
            resolve();
          } else if (m.type === "file-error" && m.id === fileId) {
            cleanup();
            reject(new Error(`Receiver failed to persist file: ${m.error}`));
          }
        } catch {}
      }
    };

    const onClose = () => {
      cleanup();
      reject(new Error("Data channel closed while waiting for file completion acknowledgement"));
    };

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      ctrl.removeEventListener("message", onMessage);
      ctrl.removeEventListener("close", onClose);
    };

    ctrl.addEventListener("message", onMessage);
    ctrl.addEventListener("close", onClose);

    timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Receiver file write acknowledgement timed out for file ID: ${fileId}`));
    }, 15000);
  });
}

/**
 * Triggers an ICE restart across RTCPeerConnection to silently recover from network drops.
 */
export async function triggerIceRestart(
  pc: RTCPeerConnection,
  code: string,
  sender: "sender" | "receiver",
  target: "sender" | "receiver",
  token?: string,
): Promise<boolean> {
  try {
    const offer = await pc.createOffer({ iceRestart: true });
    await pc.setLocalDescription(offer);
    return await sendSignalMessage(code, sender, target, "offer", offer, token);
  } catch (err) {
    console.warn("ICE restart initiation failed:", err);
    return false;
  }
}

/**
 * Helper to post signaling message to API with participant capability authentication
 */
export async function sendSignalMessage(
  code: string,
  sender: "receiver" | "sender",
  target: "receiver" | "sender",
  type: "offer" | "answer" | "candidate" | "candidate-batch" | "ping" | "leave",
  data: unknown,
  token?: string,
): Promise<boolean> {
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
    const res = await fetch("/api/signal/message", {
      method: "POST",
      headers,
      body: JSON.stringify({ code, sender, target, type, data, token }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Helper to poll signaling messages from API strictly greater than sequence cursor
 */
export async function fetchSignalMessages(
  code: string,
  role: "receiver" | "sender",
  sinceSeq: number,
  token?: string,
): Promise<{
  messages: Array<{
    seq?: number;
    id: string;
    sender: string;
    target: string;
    type: string;
    data: unknown;
    timestamp: number;
  }>;
  cursor: number;
}> {
  try {
    const headers: Record<string, string> = {};
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
    const tokenQuery = token ? `&token=${encodeURIComponent(token)}` : "";
    const res = await fetch(
      `/api/signal/poll?code=${encodeURIComponent(code)}&role=${role}&since=${sinceSeq}${tokenQuery}`,
      { cache: "no-store", headers },
    );
    if (!res.ok) return { messages: [], cursor: sinceSeq };
    const json = (await res.json()) as {
      messages?: Array<{
        seq?: number;
        id: string;
        sender: string;
        target: string;
        type: string;
        data: unknown;
        timestamp: number;
      }>;
      cursor?: number;
    };
    return {
      messages: json.messages || [],
      cursor: typeof json.cursor === "number" ? json.cursor : sinceSeq,
    };
  } catch {
    return { messages: [], cursor: sinceSeq };
  }
}
