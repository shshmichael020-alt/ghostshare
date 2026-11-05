import test from "node:test";
import assert from "node:assert";
import {
  encodeBinaryFrame,
  decodeBinaryFrame,
  inspectActiveCandidatePair,
  streamFileOverDataChannel,
  WebRTCMessage,
  DEFAULT_CHUNK_SIZE,
} from "../lib/webrtc";
import {
  createIncomingFileSink,
  DEFAULT_BATCH_SIZE,
  MOBILE_BATCH_SIZE,
} from "../lib/opfs";
import {
  SenderMetricsTracker,
  ReceiverMetricsTracker,
} from "../lib/transferMetrics";

// Polyfill MessageEvent for Node.js test environment if not present
if (typeof globalThis.MessageEvent === "undefined") {
  class NodeMessageEvent extends Event {
    data: unknown;
    constructor(type: string, dict?: { data: unknown }) {
      super(type);
      this.data = dict?.data;
    }
  }
  (globalThis as unknown as Record<string, unknown>).MessageEvent = NodeMessageEvent;
}

/**
 * Creates a connected pair of mock RTCDataChannels.
 */
function createMockPairedChannels(label: string): [MockDataChannel, MockDataChannel] {
  const chA = new MockDataChannel(label);
  const chB = new MockDataChannel(label);
  chA.peer = chB;
  chB.peer = chA;
  return [chA, chB];
}

class MockDataChannel extends EventTarget {
  label: string;
  readyState: "open" | "closed" = "open";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  peer: MockDataChannel | null = null;
  sentMessages: (string | ArrayBuffer)[] = [];

  constructor(label: string) {
    super();
    this.label = label;
  }

  send(data: string | ArrayBuffer): void {
    if (this.readyState !== "open") throw new Error("Data channel not open");
    this.sentMessages.push(data);
    if (this.peer && this.peer.readyState === "open") {
      queueMicrotask(() => {
        this.peer?.dispatchEvent(new MessageEvent("message", { data }));
      });
    }
  }

  close(): void {
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
    if (this.peer && this.peer.readyState === "open") {
      this.peer.readyState = "closed";
      this.peer.dispatchEvent(new Event("close"));
    }
  }
}

test("Storage Batching: aggregates 8 contiguous 64KB chunks into 1 single 512KB disk write", async () => {
  const writeLengths: number[] = [];
  const persistedUpdates: number[] = [];

  const mockWritable = {
    seek: async () => {},
    write: async (chunk: ArrayBuffer) => {
      writeLengths.push(chunk.byteLength);
    },
    close: async () => {},
    truncate: async () => {},
  };

  const mockHandle = {
    createWritable: async () => mockWritable,
    getFile: async () => new File([new Uint8Array(512 * 1024)], "batch-test.bin"),
  } as unknown as FileSystemFileHandle;

  const totalBytes = 512 * 1024;
  const sink = await createIncomingFileSink(
    "batch-session-1",
    "batch-file-12345678",
    "batch-test.bin",
    "application/octet-stream",
    totalBytes,
    0,
    {
      userFileHandle: mockHandle,
      batchSizeBytes: DEFAULT_BATCH_SIZE, // 512 KB
      onPersistedBytes: (p) => {
        persistedUpdates.push(p);
      },
    },
  );

  const chunkSize = 64 * 1024; // 64 KB
  // Write 7 chunks (448 KB) -> should NOT trigger write yet
  for (let i = 0; i < 7; i++) {
    await sink.write(new Uint8Array(chunkSize), i * chunkSize);
  }
  assert.strictEqual(writeLengths.length, 0, "First 7 chunks should remain buffered without disk syscall");

  // Write 8th chunk (completing 512 KB) -> must flush exactly 1 batched write of 512 KB
  await sink.write(new Uint8Array(chunkSize), 7 * chunkSize);
  assert.strictEqual(writeLengths.length, 1, "8th chunk must flush the complete 512 KB batch in 1 write call");
  assert.strictEqual(writeLengths[0], 512 * 1024, "Batched write must equal exactly 512 KB");
  assert.strictEqual(persistedUpdates.length, 1);
  assert.strictEqual(persistedUpdates[0], 512 * 1024);

  const file = await sink.close();
  assert.strictEqual(file.size, totalBytes);
  // No additional write call on close since batch was already flushed
  assert.strictEqual(writeLengths.length, 1);
});

test("Storage Batching: flushes pending batch immediately when out-of-order chunk arrives", async () => {
  const writeLengths: number[] = [];
  const seekCalls: number[] = [];

  const mockWritable = {
    seek: async (pos: number) => {
      seekCalls.push(pos);
    },
    write: async (chunk: ArrayBuffer) => {
      writeLengths.push(chunk.byteLength);
    },
    close: async () => {},
    truncate: async () => {},
  };

  const mockHandle = {
    createWritable: async () => mockWritable,
    getFile: async () => new File([new Uint8Array(300 * 1024)], "ooo-batch.bin"),
  } as unknown as FileSystemFileHandle;

  const sink = await createIncomingFileSink(
    "batch-session-2",
    "batch-ooo-12345678",
    "ooo-batch.bin",
    "application/octet-stream",
    300 * 1024,
    0,
    {
      userFileHandle: mockHandle,
      batchSizeBytes: 256 * 1024, // 256 KB mobile batch size
    },
  );

  // Write chunk 0 at offset 0 (64 KB)
  await sink.write(new Uint8Array(64 * 1024), 0);
  // Write chunk 1 at offset 64 KB (64 KB) -> total contiguous buffered = 128 KB
  await sink.write(new Uint8Array(64 * 1024), 64 * 1024);
  assert.strictEqual(writeLengths.length, 0, "Contiguous chunks under 256 KB should be buffered");

  // Out-of-order chunk arrives at offset 200 KB (skipping 128 KB..200 KB)
  // Must immediately flush the 128 KB pending batch before seeking to 200 KB!
  await sink.write(new Uint8Array(100 * 1024), 200 * 1024);
  assert.strictEqual(writeLengths.length, 1, "Out-of-order chunk must flush pending batch");
  assert.strictEqual(writeLengths[0], 128 * 1024, "Flushed batch must equal 128 KB");

  // Filling gap at offset 128 KB (72 KB)
  await sink.write(new Uint8Array(72 * 1024), 128 * 1024);

  // Close must flush any remaining buffered chunks
  await sink.close();
  assert.strictEqual(writeLengths.length, 3, "Total 3 writes executed to cover all intervals");
  const totalWritten = writeLengths.reduce((a, b) => a + b, 0);
  assert.strictEqual(totalWritten, 300 * 1024, "All 300 KB must be written to disk");
});

test("Storage Batching: residual incomplete batch flushes cleanly on sink.close()", async () => {
  const writeLengths: number[] = [];

  const mockWritable = {
    seek: async () => {},
    write: async (chunk: ArrayBuffer) => {
      writeLengths.push(chunk.byteLength);
    },
    close: async () => {},
    truncate: async () => {},
  };

  const mockHandle = {
    createWritable: async () => mockWritable,
    getFile: async () => new File([new Uint8Array(100 * 1024)], "small.bin"),
  } as unknown as FileSystemFileHandle;

  // File is only 100 KB (smaller than 512 KB batch threshold)
  const sink = await createIncomingFileSink(
    "batch-session-3",
    "batch-small-12345678",
    "small.bin",
    "application/octet-stream",
    100 * 1024,
    0,
    {
      userFileHandle: mockHandle,
      batchSizeBytes: DEFAULT_BATCH_SIZE,
    },
  );

  await sink.write(new Uint8Array(50 * 1024), 0);
  await sink.write(new Uint8Array(50 * 1024), 50 * 1024);
  assert.strictEqual(writeLengths.length, 0, "No writes while under batch size");

  const file = await sink.close();
  assert.strictEqual(writeLengths.length, 1, "close() must flush remaining 100 KB in 1 single write");
  assert.strictEqual(writeLengths[0], 100 * 1024);
  assert.strictEqual(file.size, 100 * 1024);
});

test("Flow Control: sender tracks receiver persisted bytes via file-progress-ack", async () => {
  const [senderFileCh, receiverFileCh] = createMockPairedChannels("files-creator-to-joiner");
  const [senderCtrlCh, receiverCtrlCh] = createMockPairedChannels("control");

  const totalBytes = 1024 * 1024; // 1 MB
  const fileBytes = new Uint8Array(totalBytes);
  const testFile = new File([fileBytes], "flow-control.bin", { type: "application/octet-stream" });
  const fileId = "flow-test-12345678";

  const receivedProgressAcks: number[] = [];

  receiverCtrlCh.addEventListener("message", (e: Event) => {
    const me = e as MessageEvent;
    if (typeof me.data === "string") {
      const msg = JSON.parse(me.data) as WebRTCMessage;
      if (msg.type === "file-start" && msg.id === fileId) {
        receiverCtrlCh.send(JSON.stringify({ type: "file-ready", id: fileId }));
      } else if (msg.type === "file-end" && msg.id === fileId) {
        receiverCtrlCh.send(JSON.stringify({ type: "file-ack", id: fileId }));
      }
    }
  });

  // Simulate receiver sending progress acknowledgements as chunks arrive
  receiverFileCh.addEventListener("message", (e: Event) => {
    const me = e as MessageEvent;
    const frame = decodeBinaryFrame(me.data as ArrayBuffer);
    if (frame) {
      const persistedBytes = frame.offset + frame.payload.byteLength;
      receivedProgressAcks.push(persistedBytes);
      receiverCtrlCh.send(
        JSON.stringify({
          type: "file-progress-ack",
          id: fileId,
          persistedBytes,
        }),
      );
    }
  });

  const metricsTracker = new SenderMetricsTracker(fileId, totalBytes);

  await streamFileOverDataChannel(
    senderFileCh as unknown as RTCDataChannel,
    testFile,
    fileId,
    0,
    () => {},
    () => false,
    senderCtrlCh as unknown as RTCDataChannel,
    undefined,
    undefined,
    {
      chunkSize: DEFAULT_CHUNK_SIZE,
      maxInFlightBytes: 256 * 1024, // 256 KB credit window
      metricsTracker,
    },
  );

  const snapshot = metricsTracker.getSnapshot();
  assert.strictEqual(snapshot.bytesRead, totalBytes);
  assert.strictEqual(snapshot.bytesSubmitted > totalBytes, true, "Bytes submitted includes frame headers");
  assert.ok(snapshot.averageSpeedMbs > 0, "Average speed must be greater than 0");
  assert.strictEqual(receivedProgressAcks.length, 8, "Expected 8 chunks acknowledged");
  assert.strictEqual(receivedProgressAcks[receivedProgressAcks.length - 1], totalBytes);
});

test("Candidate Pair Diagnostics: classifies host, srflx, prflx, and turn-relay paths accurately", async () => {
  // Test 1: Host to host (same LAN direct)
  const mockStatsHost = new Map<string, Record<string, unknown>>([
    ["transport_1", { id: "transport_1", type: "transport", selectedCandidatePairId: "pair_1" }],
    ["pair_1", { id: "pair_1", type: "candidate-pair", localCandidateId: "loc_h", remoteCandidateId: "rem_h", state: "succeeded", currentRoundTripTime: 0.002 }],
    ["loc_h", { id: "loc_h", type: "local-candidate", candidateType: "host", protocol: "udp" }],
    ["rem_h", { id: "rem_h", type: "remote-candidate", candidateType: "host", protocol: "udp" }],
  ]);
  const hostPair = await inspectActiveCandidatePair({ getStats: async () => mockStatsHost } as unknown as RTCPeerConnection);
  assert.ok(hostPair);
  assert.strictEqual(hostPair.pathType, "host-to-host");
  assert.strictEqual(hostPair.pathLabel, "Direct Local (Host-to-Host)");
  assert.strictEqual(hostPair.isRelayed, false);
  assert.strictEqual(hostPair.currentRoundTripTime, 0.002);

  // Test 2: STUN Reflected (Direct NAT)
  const mockStatsSrflx = new Map<string, Record<string, unknown>>([
    ["transport_1", { id: "transport_1", type: "transport", selectedCandidatePairId: "pair_2" }],
    ["pair_2", { id: "pair_2", type: "candidate-pair", localCandidateId: "loc_s", remoteCandidateId: "rem_s", state: "succeeded", currentRoundTripTime: 0.025 }],
    ["loc_s", { id: "loc_s", type: "local-candidate", candidateType: "srflx", protocol: "udp" }],
    ["rem_s", { id: "rem_s", type: "remote-candidate", candidateType: "srflx", protocol: "udp" }],
  ]);
  const srflxPair = await inspectActiveCandidatePair({ getStats: async () => mockStatsSrflx } as unknown as RTCPeerConnection);
  assert.ok(srflxPair);
  assert.strictEqual(srflxPair.pathType, "srflx-direct");
  assert.strictEqual(srflxPair.pathLabel, "Direct NAT (STUN Reflected)");
  assert.strictEqual(srflxPair.isRelayed, false);

  // Test 3: TURN Relayed
  const mockStatsRelay = new Map<string, Record<string, unknown>>([
    ["transport_1", { id: "transport_1", type: "transport", selectedCandidatePairId: "pair_3" }],
    ["pair_3", { id: "pair_3", type: "candidate-pair", localCandidateId: "loc_r", remoteCandidateId: "rem_r", state: "succeeded", currentRoundTripTime: 0.080 }],
    ["loc_r", { id: "loc_r", type: "local-candidate", candidateType: "relay", protocol: "udp" }],
    ["rem_r", { id: "rem_r", type: "remote-candidate", candidateType: "srflx", protocol: "udp" }],
  ]);
  const relayPair = await inspectActiveCandidatePair({ getStats: async () => mockStatsRelay } as unknown as RTCPeerConnection);
  assert.ok(relayPair);
  assert.strictEqual(relayPair.pathType, "turn-relay");
  assert.strictEqual(relayPair.pathLabel, "TURN Relay");
  assert.strictEqual(relayPair.isRelayed, true);
});

test("Receiver Metrics Tracker: accurately records decode times, disk write latencies, and speed", async () => {
  const tracker = new ReceiverMetricsTracker("file-test-metric-1", 1024 * 1024, "opfs");

  tracker.recordBytesReceived(512 * 1024);
  tracker.recordDecodingTime(0.5);
  tracker.recordDiskWrite(512 * 1024, 1.2);

  tracker.recordBytesReceived(512 * 1024);
  tracker.recordDecodingTime(0.4);
  tracker.recordDiskWrite(1024 * 1024, 1.4);

  tracker.finish();
  const snapshot = tracker.getSnapshot();

  assert.strictEqual(snapshot.bytesReceived, 1024 * 1024);
  assert.strictEqual(snapshot.bytesPersisted, 1024 * 1024);
  assert.strictEqual(snapshot.totalWrites, 2);
  assert.strictEqual(snapshot.storageBackend, "opfs");
  assert.ok(snapshot.avgWriteLatencyMs >= 1.0 && snapshot.avgWriteLatencyMs <= 2.0);
  assert.strictEqual(snapshot.maxWriteLatencyMs, 1.4);
  assert.ok(snapshot.decodingTimeMs >= 0.8 && snapshot.decodingTimeMs <= 1.0);
  assert.ok(snapshot.averageSpeedMbs > 0);
});
