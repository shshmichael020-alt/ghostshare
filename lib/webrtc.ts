export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" },
  { urls: "stun:stun3.l.google.com:19302" },
  { urls: "stun:stun4.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" },
  { urls: "stun:global.stun.twilio.com:3478" },
];

/**
 * Waits for ICE gathering to complete or times out gracefully.
 * Pre-gathers initial host and STUN candidates directly into the offer/answer SDP.
 */
export async function waitForIceGathering(pc: RTCPeerConnection, timeoutMs = 2200): Promise<void> {
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

export interface TransferManifestFile {
  id: string;
  name: string;
  size: number;
  type: string;
}

export type WebRTCMessage =
  | { type: "transfer-request"; files: TransferManifestFile[] }
  | { type: "transfer-accept" }
  | { type: "transfer-decline"; reason?: string }
  | { type: "file-start"; id: string; name: string; size: number; mimeType: string; offset?: number }
  | { type: "file-ready"; id: string }
  | { type: "file-end"; id: string }
  | { type: "file-ack"; id: string }
  | { type: "resume-query"; id: string }
  | { type: "resume-ack"; id: string; receivedBytes: number }
  | { type: "transfer-complete" };

/**
 * Creates an RTCPeerConnection with public STUN servers and standard SCTP configuration.
 */
export function createPeerConnection(customIceServers?: RTCIceServer[]): RTCPeerConnection {
  const config: RTCConfiguration = {
    iceServers: customIceServers && customIceServers.length > 0 ? customIceServers : DEFAULT_ICE_SERVERS,
    iceCandidatePoolSize: 4,
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
 * Supports resuming from a non-zero byte offset if a temporary connection drop occurs.
 */
export async function streamFileOverDataChannel(
  channel: RTCDataChannel,
  file: File,
  fileId: string,
  startOffset: number = 0,
  onProgress: (sentBytes: number, totalBytes: number) => void,
  isCancelled: () => boolean,
): Promise<void> {
  const total = file.size;
  let offset = Math.min(startOffset, total);

  // Signal start or resume of file transmission with byte offset
  const startMsg: WebRTCMessage = {
    type: "file-start",
    id: fileId,
    name: file.name,
    size: file.size,
    mimeType: file.type || "application/octet-stream",
    offset,
  };
  channel.send(JSON.stringify(startMsg));

  // Wait for receiver to allocate file sink/handle before sending binary chunks
  await new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onReady = (e: MessageEvent) => {
      if (typeof e.data === "string") {
        try {
          const m = JSON.parse(e.data);
          if (m.type === "file-ready" && m.id === fileId) {
            cleanup();
            resolve();
          }
        } catch {}
      }
    };
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      channel.removeEventListener("message", onReady);
    };
    channel.addEventListener("message", onReady);
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, 1500);
  });

  // Stream slices
  while (offset < total) {
    if (isCancelled()) {
      throw new Error("Transfer cancelled by user");
    }

    const end = Math.min(offset + CHUNK_SIZE, total);
    const slice = file.slice(offset, end);
    const buffer = await slice.arrayBuffer();

    await sendChunkWithBackpressure(channel, buffer);

    offset = end;
    onProgress(offset, total);
  }

  // Signal end of file
  const endMsg: WebRTCMessage = {
    type: "file-end",
    id: fileId,
  };
  channel.send(JSON.stringify(endMsg));

  // Wait for receiver to flush all chunks to disk and close stream
  await new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onAck = (e: MessageEvent) => {
      if (typeof e.data === "string") {
        try {
          const m = JSON.parse(e.data);
          if (m.type === "file-ack" && m.id === fileId) {
            cleanup();
            resolve();
          }
        } catch {}
      }
    };
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      channel.removeEventListener("message", onAck);
    };
    channel.addEventListener("message", onAck);
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, 3000);
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
): Promise<boolean> {
  try {
    const offer = await pc.createOffer({ iceRestart: true });
    await pc.setLocalDescription(offer);
    return await sendSignalMessage(code, sender, target, "offer", offer);
  } catch (err) {
    console.warn("ICE restart initiation failed:", err);
    return false;
  }
}

/**
 * Helper to post signaling message to API
 */
export async function sendSignalMessage(
  code: string,
  sender: "receiver" | "sender",
  target: "receiver" | "sender",
  type: "offer" | "answer" | "candidate" | "candidate-batch" | "ping" | "leave",
  data: unknown,
): Promise<boolean> {
  try {
    const res = await fetch("/api/signal/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, sender, target, type, data }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Helper to poll signaling messages from API
 */
export async function fetchSignalMessages(
  code: string,
  role: "receiver" | "sender",
  since: number,
): Promise<Array<{ id: string; sender: string; target: string; type: string; data: unknown; timestamp: number }>> {
  try {
    const res = await fetch(
      `/api/signal/poll?code=${encodeURIComponent(code)}&role=${role}&since=${since}`,
      { cache: "no-store" },
    );
    if (!res.ok) return [];
    const json = (await res.json()) as { messages?: Array<{ id: string; sender: string; target: string; type: string; data: unknown; timestamp: number }> };
    return json.messages || [];
  } catch {
    return [];
  }
}
