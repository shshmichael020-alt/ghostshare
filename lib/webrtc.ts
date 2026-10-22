export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" },
  { urls: "stun:openrelay.metered.ca:80" },
  {
    urls: "turn:openrelay.metered.ca:80",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
  {
    urls: "turn:openrelay.metered.ca:443",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
  {
    urls: "turn:openrelay.metered.ca:443?transport=tcp",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
];

/**
 * Waits for ICE gathering to complete or times out gracefully.
 * Gathering candidates before sending SDP embeds all host, STUN (srflx), and TURN (relay)
 * candidates directly into the offer/answer SDP, avoiding KV race conditions.
 */
export async function waitForIceGathering(pc: RTCPeerConnection, timeoutMs = 1500): Promise<void> {
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

  if (channel.bufferedAmount > MAX_BUFFERED_AMOUNT) {
    await new Promise<void>((resolve, reject) => {
      const onLow = () => {
        cleanup();
        resolve();
      };
      const onClose = () => {
        cleanup();
        reject(new Error("Data channel closed while waiting for buffer to drain"));
      };
      const cleanup = () => {
        channel.removeEventListener("bufferedamountlow", onLow);
        channel.removeEventListener("close", onClose);
      };

      channel.addEventListener("bufferedamountlow", onLow);
      channel.addEventListener("close", onClose);
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
  type: "offer" | "answer" | "candidate" | "ping" | "leave",
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
