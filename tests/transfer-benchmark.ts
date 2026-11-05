import {
  encodeBinaryFrame,
  decodeBinaryFrame,
  streamFileOverDataChannel,
  WebRTCMessage,
  DEFAULT_CHUNK_SIZE,
} from "../lib/webrtc";
import {
  createIncomingFileSink,
  DEFAULT_BATCH_SIZE,
} from "../lib/opfs";
import {
  SenderMetricsTracker,
  ReceiverMetricsTracker,
} from "../lib/transferMetrics";
import * as fs from "node:fs";
import * as path from "node:path";

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

class BenchmarkDataChannel extends EventTarget {
  label: string;
  readyState: "open" | "closed" = "open";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  peer: BenchmarkDataChannel | null = null;
  highWaterMark = 1024 * 1024;
  lowWaterMark = 256 * 1024;

  constructor(label: string) {
    super();
    this.label = label;
  }

  send(data: string | ArrayBuffer): void {
    if (this.readyState !== "open") throw new Error("Channel closed");
    const bytes = typeof data === "string" ? data.length : data.byteLength;
    this.bufferedAmount += bytes;

    // Simulate async network delivery with event loop scheduling
    setImmediate(() => {
      this.bufferedAmount = Math.max(0, this.bufferedAmount - bytes);
      if (this.bufferedAmount <= this.lowWaterMark) {
        this.dispatchEvent(new Event("bufferedamountlow"));
      }
      if (this.peer && this.peer.readyState === "open") {
        this.peer.dispatchEvent(new MessageEvent("message", { data }));
      }
    });
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

function createPairedBenchmarkChannels(label: string): [BenchmarkDataChannel, BenchmarkDataChannel] {
  const chA = new BenchmarkDataChannel(label);
  const chB = new BenchmarkDataChannel(label);
  chA.peer = chB;
  chB.peer = chA;
  return [chA, chB];
}

interface BenchmarkRunResult {
  sizeMb: number;
  run: number;
  durationMs: number;
  throughputMBs: number;
  throughputMbps: number;
  writesCount: number;
}

async function runNetworkOnlyBenchmark(sizeMb: number, run: number): Promise<BenchmarkRunResult> {
  const [senderFile, receiverFile] = createPairedBenchmarkChannels("files-creator-to-joiner");
  const [senderCtrl, receiverCtrl] = createPairedBenchmarkChannels("control");

  const totalBytes = sizeMb * 1024 * 1024;
  const rawBytes = new Uint8Array(totalBytes);
  // Fill deterministically
  for (let i = 0; i < 1024; i++) rawBytes[i] = i % 256;
  const file = new File([rawBytes], `net-${sizeMb}mb-${run}.bin`, { type: "application/octet-stream" });
  const fileId = `file-net-${sizeMb}mb-run${run}-id`;

  let bytesReceived = 0;

  receiverCtrl.addEventListener("message", (e: Event) => {
    const me = e as MessageEvent;
    if (typeof me.data === "string") {
      const msg = JSON.parse(me.data) as WebRTCMessage;
      if (msg.type === "file-start" && msg.id === fileId) {
        receiverCtrl.send(JSON.stringify({ type: "file-ready", id: fileId }));
      } else if (msg.type === "file-end" && msg.id === fileId) {
        receiverCtrl.send(JSON.stringify({ type: "file-ack", id: fileId }));
      }
    }
  });

  receiverFile.addEventListener("message", (e: Event) => {
    const me = e as MessageEvent;
    const frame = decodeBinaryFrame(me.data as ArrayBuffer);
    if (frame) {
      bytesReceived += frame.payload.byteLength;
      receiverCtrl.send(
        JSON.stringify({
          type: "file-progress-ack",
          id: fileId,
          persistedBytes: bytesReceived,
        }),
      );
    }
  });

  const t0 = performance.now();
  await streamFileOverDataChannel(
    senderFile as unknown as RTCDataChannel,
    file,
    fileId,
    0,
    () => {},
    () => false,
    senderCtrl as unknown as RTCDataChannel,
    undefined,
    undefined,
    { chunkSize: DEFAULT_CHUNK_SIZE, maxInFlightBytes: 4 * 1024 * 1024 },
  );
  const durationMs = performance.now() - t0;
  const durationSec = durationMs / 1000;
  const throughputMBs = sizeMb / durationSec;
  const throughputMbps = throughputMBs * 8;

  senderFile.close();
  receiverFile.close();
  senderCtrl.close();
  receiverCtrl.close();

  return {
    sizeMb,
    run,
    durationMs,
    throughputMBs,
    throughputMbps,
    writesCount: 0,
  };
}

async function runFullPipelineBenchmark(sizeMb: number, run: number): Promise<BenchmarkRunResult> {
  const [senderFile, receiverFile] = createPairedBenchmarkChannels("files-creator-to-joiner");
  const [senderCtrl, receiverCtrl] = createPairedBenchmarkChannels("control");

  const totalBytes = sizeMb * 1024 * 1024;
  const rawBytes = new Uint8Array(totalBytes);
  const file = new File([rawBytes], `full-${sizeMb}mb-${run}.bin`, { type: "application/octet-stream" });
  const fileId = `file-full-${sizeMb}mb-run${run}-id`;

  // Real disk file backend simulation using Node fs
  const tmpFilePath = path.join(process.cwd(), "scratch", `bench-${sizeMb}mb-${run}.tmp`);
  const fd = fs.openSync(tmpFilePath, "w+");
  let writeCalls = 0;

  const mockWritable = {
    seek: async (pos: number) => {},
    write: async (chunk: ArrayBuffer | Uint8Array) => {
      writeCalls++;
      const buf = Buffer.from(chunk instanceof Uint8Array ? chunk.buffer : chunk, chunk instanceof Uint8Array ? chunk.byteOffset : 0, chunk.byteLength);
      fs.writeSync(fd, buf);
    },
    close: async () => {
      fs.closeSync(fd);
    },
    truncate: async () => {},
  };

  const mockHandle = {
    createWritable: async () => mockWritable,
    getFile: async () => new File([new Uint8Array(totalBytes)], `full-${sizeMb}mb-${run}.bin`),
  } as unknown as FileSystemFileHandle;

  let sink: Awaited<ReturnType<typeof createIncomingFileSink>> | null = null;

  receiverCtrl.addEventListener("message", async (e: Event) => {
    const me = e as MessageEvent;
    if (typeof me.data === "string") {
      const msg = JSON.parse(me.data) as WebRTCMessage;
      if (msg.type === "file-start" && msg.id === fileId) {
        sink = await createIncomingFileSink(
          "bench-session",
          fileId,
          msg.name,
          msg.mimeType,
          msg.size,
          0,
          {
            userFileHandle: mockHandle,
            batchSizeBytes: DEFAULT_BATCH_SIZE, // 512 KB
            onPersistedBytes: (persisted) => {
              receiverCtrl.send(
                JSON.stringify({
                  type: "file-progress-ack",
                  id: fileId,
                  persistedBytes: persisted,
                }),
              );
            },
          },
        );
        receiverCtrl.send(JSON.stringify({ type: "file-ready", id: fileId }));
      } else if (msg.type === "file-end" && msg.id === fileId && sink) {
        await sink.close();
        receiverCtrl.send(JSON.stringify({ type: "file-ack", id: fileId }));
      }
    }
  });

  receiverFile.addEventListener("message", async (e: Event) => {
    const me = e as MessageEvent;
    const frame = decodeBinaryFrame(me.data as ArrayBuffer);
    if (frame && sink) {
      await sink.write(frame.payload, frame.offset);
    }
  });

  const t0 = performance.now();
  await streamFileOverDataChannel(
    senderFile as unknown as RTCDataChannel,
    file,
    fileId,
    0,
    () => {},
    () => false,
    senderCtrl as unknown as RTCDataChannel,
    undefined,
    undefined,
    { chunkSize: DEFAULT_CHUNK_SIZE, maxInFlightBytes: 4 * 1024 * 1024 },
  );
  const durationMs = performance.now() - t0;
  const durationSec = durationMs / 1000;
  const throughputMBs = sizeMb / durationSec;
  const throughputMbps = throughputMBs * 8;

  senderFile.close();
  receiverFile.close();
  senderCtrl.close();
  receiverCtrl.close();

  try {
    fs.unlinkSync(tmpFilePath);
  } catch {}

  return {
    sizeMb,
    run,
    durationMs,
    throughputMBs,
    throughputMbps,
    writesCount: writeCalls,
  };
}

async function runBenchmarks() {
  console.log("================================================================================");
  console.log("  GHOSTSHARE FILE TRANSFER PERFORMANCE BENCHMARK SUITE");
  console.log("================================================================================");

  const sizes = [5, 10, 25];

  console.log("\n--- TEST A: NETWORK-ONLY TRANSFER (Memory Sink, 0 Disk Syscalls) ---");
  for (const size of sizes) {
    const results: BenchmarkRunResult[] = [];
    for (let run = 1; run <= 3; run++) {
      const res = await runNetworkOnlyBenchmark(size, run);
      results.push(res);
      console.log(`  ${size} MB Run ${run}: ${res.durationMs.toFixed(1)} ms | ${res.throughputMBs.toFixed(2)} MB/s (${res.throughputMbps.toFixed(2)} Mbps)`);
    }
    const avgThroughput = results.reduce((acc, r) => acc + r.throughputMBs, 0) / results.length;
    console.log(`  -> ${size} MB Average: ${avgThroughput.toFixed(2)} MB/s (${(avgThroughput * 8).toFixed(2)} Mbps)`);
  }

  console.log("\n--- TEST B: FULL END-TO-END FILE TRANSFER (Pipelined Read + 512KB Batch Disk Write + Ack) ---");
  for (const size of sizes) {
    const results: BenchmarkRunResult[] = [];
    for (let run = 1; run <= 3; run++) {
      const res = await runFullPipelineBenchmark(size, run);
      results.push(res);
      console.log(`  ${size} MB Run ${run}: ${res.durationMs.toFixed(1)} ms | ${res.throughputMBs.toFixed(2)} MB/s (${res.throughputMbps.toFixed(2)} Mbps) | ${res.writesCount} disk writes`);
    }
    const avgThroughput = results.reduce((acc, r) => acc + r.throughputMBs, 0) / results.length;
    console.log(`  -> ${size} MB Average: ${avgThroughput.toFixed(2)} MB/s (${(avgThroughput * 8).toFixed(2)} Mbps)`);
  }

  console.log("\n================================================================================");
  console.log("  BENCHMARK COMPLETE");
  console.log("================================================================================");
}

runBenchmarks().catch(console.error);
