import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CHUNK_SIZE,
  MOBILE_CHUNK_SIZE,
  MAX_CHUNK_SIZE,
  MIN_CHUNK_SIZE,
  DEFAULT_HIGH_WATER_MARK,
  DEFAULT_LOW_WATER_MARK,
  MOBILE_HIGH_WATER_MARK,
  MOBILE_LOW_WATER_MARK,
  getAdaptiveChunkSize,
  sendChunkWithBackpressure,
  streamFileOverDataChannel,
  encodeBinaryFrame,
  decodeBinaryFrame,
  inspectActiveCandidatePair,
} from "../lib/webrtc";
import { createIncomingFileSink } from "../lib/opfs";

// Polyfill MessageEvent for Node.js test environment if not present
if (typeof globalThis.MessageEvent === "undefined") {
  (globalThis as unknown as Record<string, unknown>).MessageEvent = class MessageEvent extends Event {
    data: unknown;
    constructor(type: string, init?: { data?: unknown }) {
      super(type);
      this.data = init?.data;
    }
  };
}

class MockDataChannel extends EventTarget {
  label: string;
  readyState: "open" | "closed" = "open";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  peer: MockDataChannel | null = null;
  sentMessages: (string | ArrayBuffer)[] = [];
  drainDelayMs = 0;

  constructor(label: string) {
    super();
    this.label = label;
  }

  send(data: string | ArrayBuffer): void {
    if (this.readyState !== "open") {
      throw new Error(`Data channel is ${this.readyState}`);
    }
    this.sentMessages.push(data);
    const byteLen = typeof data === "string" ? data.length : data.byteLength;
    this.bufferedAmount += byteLen;

    if (this.peer && this.peer.readyState === "open") {
      const event = new MessageEvent("message", { data });
      queueMicrotask(() => {
        if (this.peer && this.peer.readyState === "open") {
          this.peer.dispatchEvent(event);
        }
      });
    }

    if (this.drainDelayMs >= 0) {
      setTimeout(() => {
        this.bufferedAmount = Math.max(0, this.bufferedAmount - byteLen);
        if (this.bufferedAmount <= this.bufferedAmountLowThreshold) {
          this.dispatchEvent(new Event("bufferedamountlow"));
        }
      }, this.drainDelayMs);
    }
  }

  close(): void {
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
  }
}

function createPairedChannels(label: string) {
  const a = new MockDataChannel(label);
  const b = new MockDataChannel(label);
  a.peer = b;
  b.peer = a;
  return [a, b] as const;
}

test("Adaptive Chunk Sizing: selects appropriate chunk size based on platform and SCTP", () => {
  // 1. Mobile devices get 64 KB
  assert.strictEqual(getAdaptiveChunkSize(null, true), MOBILE_CHUNK_SIZE);
  assert.strictEqual(MOBILE_CHUNK_SIZE, 64 * 1024);

  // 2. Desktop default without SCTP stats gets 128 KB
  assert.strictEqual(getAdaptiveChunkSize(null, false), DEFAULT_CHUNK_SIZE);
  assert.strictEqual(DEFAULT_CHUNK_SIZE, 128 * 1024);

  // 3. Desktop with small SCTP maxMessageSize bounds safely
  const mockSmallSctpPc = {
    sctp: { maxMessageSize: 40 * 1024 },
  } as unknown as RTCPeerConnection;
  assert.strictEqual(getAdaptiveChunkSize(mockSmallSctpPc, false), 39 * 1024);

  // 4. Desktop with large SCTP maxMessageSize bounds at MAX_CHUNK_SIZE (256 KB)
  const mockLargeSctpPc = {
    sctp: { maxMessageSize: 512 * 1024 },
  } as unknown as RTCPeerConnection;
  assert.strictEqual(getAdaptiveChunkSize(mockLargeSctpPc, false), MAX_CHUNK_SIZE);
  assert.strictEqual(MAX_CHUNK_SIZE, 256 * 1024);

  // 5. Very small SCTP clamped at MIN_CHUNK_SIZE (32 KB)
  const mockTinySctpPc = {
    sctp: { maxMessageSize: 10 * 1024 },
  } as unknown as RTCPeerConnection;
  assert.strictEqual(getAdaptiveChunkSize(mockTinySctpPc, false), MIN_CHUNK_SIZE);
  assert.strictEqual(MIN_CHUNK_SIZE, 32 * 1024);
});

test("Binary Framing: cached preEncodedIdBytes produces identical frame output", () => {
  const fileId = "test-file-id-12345678";
  const chunkIndex = 42;
  const offset = 1048576;
  const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer;

  // Standard encoding
  const standardFrame = encodeBinaryFrame(fileId, chunkIndex, offset, payload);

  // Optimized encoding with pre-encoded ID bytes
  const preEncoded = new TextEncoder().encode(fileId);
  const optimizedFrame = encodeBinaryFrame(fileId, chunkIndex, offset, payload, preEncoded);

  assert.strictEqual(standardFrame.byteLength, optimizedFrame.byteLength);
  const stdView = new Uint8Array(standardFrame);
  const optView = new Uint8Array(optimizedFrame);
  for (let i = 0; i < stdView.length; i++) {
    assert.strictEqual(stdView[i], optView[i]);
  }

  // Decoding matches
  const decoded = decodeBinaryFrame(optimizedFrame);
  assert.ok(decoded);
  assert.strictEqual(decoded.fileId, fileId);
  assert.strictEqual(decoded.chunkIndex, chunkIndex);
  assert.strictEqual(decoded.offset, offset);
  assert.deepStrictEqual(new Uint8Array(decoded.payload), new Uint8Array(payload));
});

test("Event-Driven Backpressure: pauses when buffer exceeds high-water and resumes on low-water", async () => {
  const channel = new MockDataChannel("test-dc");
  const highWater = 64 * 1024;
  const lowWater = 16 * 1024;

  // Artificially preload buffer above highWater
  channel.bufferedAmount = 80 * 1024;

  // Schedule a drain in 30ms that drops buffer to lowWater and fires bufferedamountlow
  setTimeout(() => {
    channel.bufferedAmount = 10 * 1024;
    channel.dispatchEvent(new Event("bufferedamountlow"));
  }, 30);

  const startWait = Date.now();
  const chunk = new Uint8Array(1024).buffer;
  await sendChunkWithBackpressure(channel as unknown as RTCDataChannel, chunk, highWater, lowWater);
  const elapsed = Date.now() - startWait;

  assert.ok(elapsed >= 20, `Expected backpressure wait >= 20ms, got ${elapsed}ms`);
  assert.strictEqual(channel.bufferedAmountLowThreshold, lowWater);
  assert.strictEqual(channel.sentMessages.length, 1);
});

test("Event-Driven Backpressure: watchdog timer prevents indefinite hangs if event is delayed", async () => {
  const channel = new MockDataChannel("test-dc");
  // Set drainDelayMs to negative so simulated network does NOT fire bufferedamountlow
  channel.drainDelayMs = -1;
  channel.bufferedAmount = 2 * DEFAULT_HIGH_WATER_MARK;

  // Artificially reset bufferedAmount after 50ms without firing the event
  setTimeout(() => {
    channel.bufferedAmount = 0;
  }, 50);

  const start = Date.now();
  const chunk = new Uint8Array(1024).buffer;
  await sendChunkWithBackpressure(
    channel as unknown as RTCDataChannel,
    chunk,
    DEFAULT_HIGH_WATER_MARK,
    DEFAULT_LOW_WATER_MARK,
  );
  const elapsed = Date.now() - start;

  // Should have resumed via watchdog within ~300ms without throwing
  assert.ok(elapsed >= 40 && elapsed <= 450, `Watchdog resolved in ${elapsed}ms`);
});

test("Pipelined File Streaming: end-to-end stream with 128 KB chunks, read-ahead, and ack", async () => {
  const [senderFileCh, receiverFileCh] = createPairedChannels("files-joiner-to-creator");
  const [senderCtrlCh, receiverCtrlCh] = createPairedChannels("control");

  const totalBytes = 512 * 1024; // 512 KB (4 x 128 KB chunks)
  const fileBytes = new Uint8Array(totalBytes);
  for (let i = 0; i < totalBytes; i++) {
    fileBytes[i] = i % 256;
  }
  const testFile = new File([fileBytes], "pipelined-test.dat", { type: "application/octet-stream" });
  const fileId = "pipe-test-12345678";

  // Receiver control message handler
  receiverCtrlCh.addEventListener("message", (e: Event) => {
    const me = e as MessageEvent;
    if (typeof me.data === "string") {
      const msg = JSON.parse(me.data);
      if (msg.type === "file-start" && msg.id === fileId) {
        receiverCtrlCh.send(JSON.stringify({ type: "file-ready", id: fileId }));
      } else if (msg.type === "file-end" && msg.id === fileId) {
        receiverCtrlCh.send(JSON.stringify({ type: "file-ack", id: fileId }));
      }
    }
  });

  let progressCalls = 0;
  let lastProgressSent = 0;

  await streamFileOverDataChannel(
    senderFileCh as unknown as RTCDataChannel,
    testFile,
    fileId,
    0,
    (sent, total) => {
      progressCalls++;
      lastProgressSent = sent;
      assert.strictEqual(total, totalBytes);
    },
    () => false,
    senderCtrlCh as unknown as RTCDataChannel,
    undefined,
    undefined,
    { chunkSize: DEFAULT_CHUNK_SIZE },
  );

  assert.strictEqual(lastProgressSent, totalBytes);
  assert.ok(progressCalls >= 4, `Expected at least 4 progress events, got ${progressCalls}`);
  assert.strictEqual(senderFileCh.sentMessages.length, 4);

  // Verify all 4 framed chunks
  for (let i = 0; i < senderFileCh.sentMessages.length; i++) {
    const raw = senderFileCh.sentMessages[i] as ArrayBuffer;
    const frame = decodeBinaryFrame(raw);
    assert.ok(frame);
    assert.strictEqual(frame.fileId, fileId);
    assert.strictEqual(frame.chunkIndex, i);
    assert.strictEqual(frame.offset, i * DEFAULT_CHUNK_SIZE);
    assert.strictEqual(frame.payload.byteLength, DEFAULT_CHUNK_SIZE);
  }
});

test("OPFS & FSA Streamer: skips redundant seek() on sequential chunks", async () => {
  const seekCalls: number[] = [];
  const writeCalls: number[] = [];

  const mockWritable = {
    seek: async (pos: number) => {
      seekCalls.push(pos);
    },
    write: async (chunk: ArrayBuffer) => {
      writeCalls.push(chunk.byteLength);
    },
    close: async () => {},
    truncate: async () => {},
  };

  const mockHandle = {
    createWritable: async () => mockWritable,
    getFile: async () => new File([new Uint8Array(300)], "test.bin"),
  } as unknown as FileSystemFileHandle;

  const sink = await createIncomingFileSink(
    "test-sequential-session",
    "test-seq-file-12345678",
    "test.bin",
    "application/octet-stream",
    300,
    0,
    { userFileHandle: mockHandle },
  );

  // Write chunk 0 at offset 0 (sequential)
  await sink.write(new Uint8Array(100).buffer, 0);
  // Write chunk 1 at offset 100 (sequential)
  await sink.write(new Uint8Array(100).buffer, 100);
  // Write chunk 2 at offset 200 (sequential)
  await sink.write(new Uint8Array(100).buffer, 200);

  await sink.close();

  // All 3 writes executed
  assert.strictEqual(writeCalls.length, 3);
  // Since all chunks were contiguous and sequential, seekCalls should be 0!
  assert.strictEqual(seekCalls.length, 0, `Expected 0 seek calls for sequential writes, got ${seekCalls.length}`);
});

test("OPFS & FSA Streamer: seeks accurately when an out-of-order chunk arrives", async () => {
  const seekCalls: number[] = [];
  const writeCalls: number[] = [];

  const mockWritable = {
    seek: async (pos: number) => {
      seekCalls.push(pos);
    },
    write: async (chunk: ArrayBuffer) => {
      writeCalls.push(chunk.byteLength);
    },
    close: async () => {},
    truncate: async () => {},
  };

  const mockHandle = {
    createWritable: async () => mockWritable,
    getFile: async () => new File([new Uint8Array(300)], "test-ooo.bin"),
  } as unknown as FileSystemFileHandle;

  const sink = await createIncomingFileSink(
    "test-ooo-session",
    "test-ooo-file-12345678",
    "test-ooo.bin",
    "application/octet-stream",
    300,
    0,
    { userFileHandle: mockHandle },
  );

  // Chunk 0 at 0 (sequential)
  await sink.write(new Uint8Array(100).buffer, 0);
  // Chunk 2 at 200 (out-of-order, cursor was at 100) -> must seek to 200!
  await sink.write(new Uint8Array(100).buffer, 200);
  // Chunk 1 at 100 (filling gap, cursor was at 300) -> must seek to 100!
  await sink.write(new Uint8Array(100).buffer, 100);

  await sink.close();

  assert.strictEqual(writeCalls.length, 3);
  assert.deepStrictEqual(seekCalls, [200, 100]);
});

test("Candidate Pair Inspection: resolves transport and extracts RTT and bandwidth stats", async () => {
  const mockStats = new Map<string, Record<string, unknown>>([
    [
      "transport_1",
      {
        id: "transport_1",
        type: "transport",
        selectedCandidatePairId: "pair_active",
      },
    ],
    [
      "pair_active",
      {
        id: "pair_active",
        type: "candidate-pair",
        localCandidateId: "local_1",
        remoteCandidateId: "remote_1",
        state: "succeeded",
        selected: true,
        currentRoundTripTime: 0.024, // 24ms
        availableOutgoingBitrate: 85000000, // 85 Mbps
        bytesSent: 15420000,
        bytesReceived: 320000,
      },
    ],
    [
      "local_1",
      {
        id: "local_1",
        type: "local-candidate",
        candidateType: "srflx",
        protocol: "udp",
      },
    ],
    [
      "remote_1",
      {
        id: "remote_1",
        type: "remote-candidate",
        candidateType: "srflx",
        protocol: "udp",
      },
    ],
  ]);

  const mockPc = {
    getStats: async () => mockStats,
  } as unknown as RTCPeerConnection;

  const result = await inspectActiveCandidatePair(mockPc);
  assert.ok(result);
  assert.strictEqual(result.localCandidateType, "srflx");
  assert.strictEqual(result.remoteCandidateType, "srflx");
  assert.strictEqual(result.protocol, "udp");
  assert.strictEqual(result.isRelayed, false);
  assert.strictEqual(result.currentRoundTripTime, 0.024);
  assert.strictEqual(result.availableOutgoingBitrate, 85000000);
  assert.strictEqual(result.bytesSent, 15420000);
  assert.strictEqual(result.bytesReceived, 320000);
});
