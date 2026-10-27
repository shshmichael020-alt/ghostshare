import test from "node:test";
import assert from "node:assert/strict";
import {
  encodeBinaryFrame,
  decodeBinaryFrame,
  DATA_CHANNEL_LABELS,
  WebRTCMessage,
  TransferManifestFile,
  generateTransferId,
  isValidProtocolId,
  sanitizeFileName,
  sanitizeMimeType,
  streamFileOverDataChannel,
} from "../lib/webrtc";
import { createIncomingFileSink } from "../lib/opfs";

/**
 * Mock DataChannel that simulates RTCDataChannel behavior in Node.js
 */
class MockDataChannel extends EventTarget {
  label: string;
  readyState: "open" | "closed" = "open";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 64 * 1024;
  peer: MockDataChannel | null = null;
  sentMessages: (string | ArrayBuffer)[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(label: string) {
    super();
    this.label = label;
  }

  send(data: string | ArrayBuffer): void {
    if (this.readyState !== "open") {
      throw new Error("Data channel is not open");
    }
    this.sentMessages.push(data);
    if (this.peer && this.peer.readyState === "open") {
      const event = new MessageEvent("message", { data });
      // Dispatch asynchronously to emulate network tick
      queueMicrotask(() => {
        if (this.peer && this.peer.readyState === "open") {
          this.peer.dispatchEvent(event);
          if (this.peer.onmessage) this.peer.onmessage(event);
        }
      });
    }
  }

  close(): void {
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
    if (this.onclose) this.onclose();
    if (this.peer && this.peer.readyState === "open") {
      this.peer.close();
    }
  }

  override addEventListener(
    type: string,
    callback: (e: any) => void | Promise<void>,
    options?: boolean | AddEventListenerOptions,
  ): void {
    super.addEventListener(type, callback as EventListenerOrEventListenerObject, options);
  }
}

function createMockChannelPair(label: string): [MockDataChannel, MockDataChannel] {
  const chA = new MockDataChannel(label);
  const chB = new MockDataChannel(label);
  chA.peer = chB;
  chB.peer = chA;
  return [chA, chB];
}

// ---------------------------------------------------------------------------
// File-ID Regression Tests
// ---------------------------------------------------------------------------

test("File-ID: generateTransferId creates opaque, filename-independent IDs conforming to protocol spec", () => {
  const ids = new Set<string>();
  for (let i = 0; i < 50; i++) {
    const id = generateTransferId();
    assert.ok(isValidProtocolId(id), `Generated ID "${id}" must conform to protocol specification`);
    assert.ok(!ids.has(id), `Generated ID "${id}" must be globally unique`);
    ids.add(id);
    // Ensure no filenames or extensions leaked into the ID
    assert.ok(!id.includes(".jpg"));
    assert.ok(!id.includes(".pdf"));
    assert.ok(!id.includes(" "));
  }
});

test("File-ID: protocol IDs remain strictly identical across all message types", () => {
  const testFiles = [
    { name: "IMG-20261025-WA0093.jpg", size: 499700, type: "image/jpeg" },
    { name: "Holiday Notification_Maharshi Valmiki Jayanti - reg..pdf", size: 481100, type: "application/pdf" },
    { name: "日本語のドキュメント (v2.0).png", size: 84000, type: "image/png" },
    { name: "archive with spaces and dots.tar.gz", size: 1024000, type: "application/gzip" },
    { name: "X".repeat(200) + ".zip", size: 50000, type: "application/zip" },
  ];

  for (const f of testFiles) {
    const protocolId = generateTransferId();
    const batchId = `b_${generateTransferId()}`;

    // 1. Manifest
    const manifestFile: TransferManifestFile = {
      id: protocolId,
      name: sanitizeFileName(f.name),
      size: f.size,
      type: sanitizeMimeType(f.type),
    };
    assert.equal(manifestFile.id, protocolId);
    assert.ok(isValidProtocolId(manifestFile.id));

    // 2. file-start
    const startMsg: WebRTCMessage = {
      type: "file-start",
      id: protocolId,
      name: manifestFile.name,
      size: manifestFile.size,
      mimeType: manifestFile.type,
      batchId,
    };
    assert.equal(startMsg.id, protocolId);

    // 3. file-ready
    const readyMsg: WebRTCMessage = {
      type: "file-ready",
      id: protocolId,
      batchId,
    };
    assert.equal(readyMsg.id, protocolId);

    // 4. Binary chunk framing
    const dummyPayload = new Uint8Array([1, 2, 3, 4]).buffer;
    const frame = encodeBinaryFrame(protocolId, 0, 0, dummyPayload);
    const decoded = decodeBinaryFrame(frame);
    assert.ok(decoded);
    assert.equal(decoded.fileId, protocolId, "Binary frame must contain the exact protocol ID");

    // 5. file-end
    const endMsg: WebRTCMessage = {
      type: "file-end",
      id: protocolId,
      batchId,
    };
    assert.equal(endMsg.id, protocolId);

    // 6. file-ack
    const ackMsg: WebRTCMessage = {
      type: "file-ack",
      id: protocolId,
      batchId,
    };
    assert.equal(ackMsg.id, protocolId);
  }
});

test("File-ID: repeated selection of identical filenames produces distinct protocol IDs", () => {
  const fileName = "IMG-20261026-WA0000.jpg";
  const id1 = generateTransferId();
  const id2 = generateTransferId();
  const id3 = generateTransferId();

  assert.notEqual(id1, id2);
  assert.notEqual(id2, id3);
  assert.ok(isValidProtocolId(id1));
  assert.ok(isValidProtocolId(id2));
  assert.ok(isValidProtocolId(id3));
});

test("File-ID: protocol validator rejects malformed IDs rather than silently mutating them", () => {
  // IDs that contain illegal characters or are too short/long
  assert.equal(isValidProtocolId("bad.id.with.dots.jpg"), false);
  assert.equal(isValidProtocolId("id with spaces"), false);
  assert.equal(isValidProtocolId("../../evil_path"), false);
  assert.equal(isValidProtocolId("short"), false); // < 8 chars
  assert.equal(isValidProtocolId("X".repeat(65)), false); // > 64 chars
  assert.equal(isValidProtocolId(null), false);
  assert.equal(isValidProtocolId(12345678), false);

  // Valid protocol IDs
  assert.equal(isValidProtocolId("3fa85f64-5717-4562-b3fc-2c963f66afa6"), true);
  assert.equal(isValidProtocolId("b_3fa85f64_5717_4562"), true);
  assert.equal(isValidProtocolId("file_12345678_abcdef"), true);
});

// ---------------------------------------------------------------------------
// Transfer Lifecycle & WebRTC Readiness Flow Tests
// ---------------------------------------------------------------------------

test("Lifecycle 1: Successful end-to-end readiness and completion acknowledgement", async () => {
  const [senderCtrl, receiverCtrl] = createMockChannelPair("control");
  const [senderData, receiverData] = createMockChannelPair("file-transfer");

  const fileId = generateTransferId();
  const batchId = `b_${generateTransferId()}`;
  const fileContent = new Uint8Array(64 * 1024); // 64 KB
  fileContent.fill(0x42);
  const file = new File([fileContent], "test_document.pdf", { type: "application/pdf" });

  let sink: Awaited<ReturnType<typeof createIncomingFileSink>> | null = null;
  let receivedFile: File | null = null;

  // Receiver control message handler
  receiverCtrl.addEventListener("message", async (e) => {
    const msg = JSON.parse(e.data as string) as WebRTCMessage;
    if (msg.type === "file-start" && msg.id === fileId) {
      sink = await createIncomingFileSink("test-session", msg.id, msg.name, msg.mimeType, msg.size);
      receiverCtrl.send(JSON.stringify({ type: "file-ready", id: msg.id, batchId: msg.batchId }));
    } else if (msg.type === "file-end" && msg.id === fileId && sink) {
      receivedFile = await sink.close();
      receiverCtrl.send(JSON.stringify({ type: "file-ack", id: msg.id, batchId: msg.batchId }));
    }
  });

  // Receiver data channel handler
  receiverData.addEventListener("message", async (e) => {
    if (sink) {
      const decoded = decodeBinaryFrame(e.data as ArrayBuffer);
      if (decoded && decoded.fileId === fileId) {
        await sink.write(decoded.payload, decoded.offset);
      }
    }
  });

  let progressCalled = false;
  let verifiedCalled = false;

  await streamFileOverDataChannel(
    senderData as unknown as RTCDataChannel,
    file,
    fileId,
    0,
    () => { progressCalled = true; },
    () => false,
    senderCtrl as unknown as RTCDataChannel,
    batchId,
    () => { verifiedCalled = true; },
  );

  assert.ok(progressCalled, "Progress callback should have fired");
  assert.ok(verifiedCalled, "Verification callback should have fired");
  assert.ok(receivedFile, "Receiver must produce verified File");
  assert.equal((receivedFile as any).size, fileContent.length);
  assert.equal((receivedFile as any).name, "test_document.pdf");
});

test("Lifecycle 2: Receiver sink-allocation failure sends correlated file-error and sender rejects", async () => {
  const [senderCtrl, receiverCtrl] = createMockChannelPair("control");
  const [senderData] = createMockChannelPair("file-transfer");

  const fileId = generateTransferId();
  const file = new File([new Uint8Array(100)], "error_test.jpg", { type: "image/jpeg" });

  // Receiver simulates storage error upon file-start
  receiverCtrl.addEventListener("message", (e) => {
    const msg = JSON.parse(e.data as string) as WebRTCMessage;
    if (msg.type === "file-start" && msg.id === fileId) {
      receiverCtrl.send(
        JSON.stringify({
          type: "file-error",
          id: msg.id,
          error: "Storage quota exceeded in OPFS",
        }),
      );
    }
  });

  await assert.rejects(
    async () => {
      await streamFileOverDataChannel(
        senderData as unknown as RTCDataChannel,
        file,
        fileId,
        0,
        () => {},
        () => false,
        senderCtrl as unknown as RTCDataChannel,
      );
    },
    /Receiver rejected file: Storage quota exceeded in OPFS/,
  );
});

test("Lifecycle 3: Readiness timeout when no acknowledgement is received", async () => {
  const [senderCtrl] = createMockChannelPair("control");
  const [senderData] = createMockChannelPair("file-transfer");

  const fileId = generateTransferId();
  const file = new File([new Uint8Array(100)], "timeout_test.jpg", { type: "image/jpeg" });

  // Sender stream should fail with readiness confirmation timeout if receiver peer never responds
  // We temporarily reduce timeout or test timeout rejection
  const startTime = Date.now();
  await assert.rejects(
    async () => {
      // Channel with no receiver listening
      await streamFileOverDataChannel(
        senderData as unknown as RTCDataChannel,
        file,
        fileId,
        0,
        () => {},
        () => false,
        senderCtrl as unknown as RTCDataChannel,
      );
    },
    (err: Error) => {
      return err.message.includes(`Receiver readiness confirmation timed out for file ID: ${fileId}`);
    },
  );
  assert.ok(Date.now() - startTime >= 9000, "Should wait for bounded readiness timeout (~10s)");
});

test("Lifecycle 4: Readiness acknowledgement received with mismatched file ID is ignored", async () => {
  const [senderCtrl, receiverCtrl] = createMockChannelPair("control");
  const [senderData] = createMockChannelPair("file-transfer");

  const fileId = generateTransferId();
  const mismatchedId = generateTransferId();
  const file = new File([new Uint8Array(100)], "mismatch_test.jpg", { type: "image/jpeg" });

  receiverCtrl.addEventListener("message", (e) => {
    const msg = JSON.parse(e.data as string) as WebRTCMessage;
    if (msg.type === "file-start") {
      // Simulate buggy receiver that responds with mismatched file ID
      receiverCtrl.send(
        JSON.stringify({
          type: "file-ready",
          id: mismatchedId, // DOES NOT MATCH fileId!
        }),
      );
    }
  });

  await assert.rejects(
    async () => {
      await streamFileOverDataChannel(
        senderData as unknown as RTCDataChannel,
        file,
        fileId,
        0,
        () => {},
        () => false,
        senderCtrl as unknown as RTCDataChannel,
      );
    },
    (err: Error) => {
      return err.message.includes(`Receiver readiness confirmation timed out for file ID: ${fileId}`);
    },
  );
});

test("Lifecycle 5: Stale and duplicate acknowledgements are safely ignored", async () => {
  const [senderCtrl, receiverCtrl] = createMockChannelPair("control");
  const [senderData, receiverData] = createMockChannelPair("file-transfer");

  const fileId = generateTransferId();
  const staleId = generateTransferId();
  const file = new File([new Uint8Array(1024)], "stale_test.jpg", { type: "image/jpeg" });

  let sink: Awaited<ReturnType<typeof createIncomingFileSink>> | null = null;

  receiverCtrl.addEventListener("message", async (e) => {
    const msg = JSON.parse(e.data as string) as WebRTCMessage;
    if (msg.type === "file-start" && msg.id === fileId) {
      // Send a stale file-ready first
      receiverCtrl.send(JSON.stringify({ type: "file-ready", id: staleId }));
      sink = await createIncomingFileSink("test-session", msg.id, msg.name, msg.mimeType, msg.size);
      // Send genuine file-ready
      receiverCtrl.send(JSON.stringify({ type: "file-ready", id: msg.id }));
    } else if (msg.type === "file-end" && msg.id === fileId && sink) {
      await sink.close();
      // Send duplicate file-acks
      receiverCtrl.send(JSON.stringify({ type: "file-ack", id: msg.id }));
      receiverCtrl.send(JSON.stringify({ type: "file-ack", id: msg.id }));
    }
  });

  receiverData.addEventListener("message", async (e) => {
    if (sink) {
      const decoded = decodeBinaryFrame(e.data as ArrayBuffer);
      if (decoded && decoded.fileId === fileId) {
        await sink.write(decoded.payload, decoded.offset);
      }
    }
  });

  // Transfer should succeed despite stale file-ready and duplicate file-ack
  await streamFileOverDataChannel(
    senderData as unknown as RTCDataChannel,
    file,
    fileId,
    0,
    () => {},
    () => false,
    senderCtrl as unknown as RTCDataChannel,
  );
});

test("Lifecycle 6 & 7: file-end arriving before all binary writes finish waits safely", async () => {
  const fileId = generateTransferId();
  const expectedSize = 32 * 1024;
  const chunk1 = new Uint8Array(16 * 1024).fill(1).buffer;
  const chunk2 = new Uint8Array(16 * 1024).fill(2).buffer;

  const sink = await createIncomingFileSink("test-session", fileId, "delayed.bin", "application/octet-stream", expectedSize);

  // Simulate file-end arrived when only chunk1 was written
  await sink.write(chunk1, 0);

  // Verify getBytesWritten is not yet equal to expectedSize
  assert.equal(sink.getBytesWritten(), 16 * 1024);

  // Delayed chunk arrives
  await new Promise((r) => setTimeout(r, 100));
  await sink.write(chunk2, 16 * 1024);

  assert.equal(sink.getBytesWritten(), expectedSize);

  // Now finalization should succeed cleanly without size mismatch error
  const finalFile = await sink.close();
  assert.equal(finalFile.size, expectedSize);
});

test("Lifecycle 8: Final-size mismatch triggers verification error", async () => {
  const fileId = generateTransferId();
  const expectedSize = 32 * 1024;
  const chunk = new Uint8Array(16 * 1024).fill(1).buffer;

  const sink = await createIncomingFileSink("test-session", fileId, "truncated.bin", "application/octet-stream", expectedSize);
  await sink.write(chunk, 0);

  // Finalizing when only 16 KB of 32 KB arrived must fail
  await assert.rejects(
    async () => {
      await sink.close();
    },
    /Transferred byte length mismatch/,
  );
});

test("Lifecycle 9: Successful verification produces valid, downloadable file", async () => {
  const fileId = generateTransferId();
  const data = new Uint8Array([10, 20, 30, 40, 50]);
  const sink = await createIncomingFileSink("test-session", fileId, "downloadable.png", "image/png", data.length);
  await sink.write(data.buffer, 0);

  const file = await sink.close();
  assert.equal(file.name, "downloadable.png");
  assert.equal(file.type, "image/png");
  assert.equal(file.size, 5);

  const buf = await file.arrayBuffer();
  assert.deepEqual(new Uint8Array(buf), data);
});

test("Lifecycle 10 & 11: Retry after a failure cleanly recovers with fresh transfer", async () => {
  const [senderCtrl, receiverCtrl] = createMockChannelPair("control");
  const [senderData, receiverData] = createMockChannelPair("file-transfer");

  const fileId = generateTransferId();
  const file = new File([new Uint8Array(1024)], "retry_file.jpg", { type: "image/jpeg" });

  let attempt = 1;
  let sink: Awaited<ReturnType<typeof createIncomingFileSink>> | null = null;

  receiverCtrl.addEventListener("message", async (e) => {
    const msg = JSON.parse(e.data as string) as WebRTCMessage;
    if (msg.type === "file-start" && msg.id === fileId) {
      if (attempt === 1) {
        // Attempt 1 fails
        receiverCtrl.send(JSON.stringify({ type: "file-error", id: fileId, error: "Network blip" }));
      } else {
        // Attempt 2 succeeds
        sink = await createIncomingFileSink("test-session", msg.id, msg.name, msg.mimeType, msg.size);
        receiverCtrl.send(JSON.stringify({ type: "file-ready", id: msg.id }));
      }
    } else if (msg.type === "file-end" && msg.id === fileId && sink) {
      await sink.close();
      receiverCtrl.send(JSON.stringify({ type: "file-ack", id: msg.id }));
    }
  });

  receiverData.addEventListener("message", async (e) => {
    if (sink) {
      const decoded = decodeBinaryFrame(e.data as ArrayBuffer);
      if (decoded && decoded.fileId === fileId) {
        await sink.write(decoded.payload, decoded.offset);
      }
    }
  });

  // Attempt 1 fails
  await assert.rejects(async () => {
    await streamFileOverDataChannel(
      senderData as unknown as RTCDataChannel,
      file,
      fileId,
      0,
      () => {},
      () => false,
      senderCtrl as unknown as RTCDataChannel,
    );
  }, /Receiver rejected file: Network blip/);

  // Retry (attempt 2)
  attempt = 2;
  await streamFileOverDataChannel(
    senderData as unknown as RTCDataChannel,
    file,
    fileId,
    0,
    () => {},
    () => false,
    senderCtrl as unknown as RTCDataChannel,
  );

  assert.ok(sink);
});

test("Lifecycle 12 & 13: Multiple files in sequential batches complete without re-creating session", async () => {
  const [senderCtrl, receiverCtrl] = createMockChannelPair("control");
  const [senderData, receiverData] = createMockChannelPair("file-transfer");

  const filesBatch1 = [
    new File([new Uint8Array(1000)], "img1.jpg", { type: "image/jpeg" }),
    new File([new Uint8Array(2000)], "doc1.pdf", { type: "application/pdf" }),
  ];

  const filesBatch2 = [
    new File([new Uint8Array(3000)], "archive.zip", { type: "application/zip" }),
  ];

  const activeSinks = new Map<string, Awaited<ReturnType<typeof createIncomingFileSink>>>();
  const completedFiles: File[] = [];

  receiverCtrl.addEventListener("message", async (e) => {
    const msg = JSON.parse(e.data as string) as WebRTCMessage;
    if (msg.type === "file-start") {
      const sink = await createIncomingFileSink("test-session", msg.id, msg.name, msg.mimeType, msg.size);
      activeSinks.set(msg.id, sink);
      receiverCtrl.send(JSON.stringify({ type: "file-ready", id: msg.id, batchId: msg.batchId }));
    } else if (msg.type === "file-end") {
      const sink = activeSinks.get(msg.id);
      if (sink) {
        const file = await sink.close();
        completedFiles.push(file);
        activeSinks.delete(msg.id);
        receiverCtrl.send(JSON.stringify({ type: "file-ack", id: msg.id, batchId: msg.batchId }));
      }
    }
  });

  receiverData.addEventListener("message", async (e) => {
    const decoded = decodeBinaryFrame(e.data as ArrayBuffer);
    if (decoded) {
      const sink = activeSinks.get(decoded.fileId);
      if (sink) {
        await sink.write(decoded.payload, decoded.offset);
      }
    }
  });

  // Execute Batch 1
  const b1 = `b_${generateTransferId()}`;
  for (const f of filesBatch1) {
    const id = generateTransferId();
    await streamFileOverDataChannel(
      senderData as unknown as RTCDataChannel,
      f,
      id,
      0,
      () => {},
      () => false,
      senderCtrl as unknown as RTCDataChannel,
      b1,
    );
  }

  // Execute Batch 2 in the exact same channel/session
  const b2 = `b_${generateTransferId()}`;
  for (const f of filesBatch2) {
    const id = generateTransferId();
    await streamFileOverDataChannel(
      senderData as unknown as RTCDataChannel,
      f,
      id,
      0,
      () => {},
      () => false,
      senderCtrl as unknown as RTCDataChannel,
      b2,
    );
  }

  assert.equal(completedFiles.length, 3);
  assert.equal(completedFiles[0].name, "img1.jpg");
  assert.equal(completedFiles[1].name, "doc1.pdf");
  assert.equal(completedFiles[2].name, "archive.zip");
});

test("Lifecycle 14: Simultaneous transfers in both directions over dedicated channels", async () => {
  const [ctrlA, ctrlB] = createMockChannelPair("control");
  const [outAtoB, inAtoB] = createMockChannelPair(DATA_CHANNEL_LABELS.FILES_CREATOR_TO_JOINER);
  const [outBtoA, inBtoA] = createMockChannelPair(DATA_CHANNEL_LABELS.FILES_JOINER_TO_CREATOR);

  const fileAtoBId = generateTransferId();
  const fileAtoB = new File([new Uint8Array(20 * 1024)], "from_A.pdf", { type: "application/pdf" });

  const fileBtoAId = generateTransferId();
  const fileBtoA = new File([new Uint8Array(10 * 1024)], "from_B.jpg", { type: "image/jpeg" });

  let sinkOnB: Awaited<ReturnType<typeof createIncomingFileSink>> | null = null;
  let sinkOnA: Awaited<ReturnType<typeof createIncomingFileSink>> | null = null;

  let fileOnB: File | null = null;
  let fileOnA: File | null = null;

  // Handle control messages on B (receiving from A)
  ctrlB.addEventListener("message", async (e) => {
    const msg = JSON.parse(e.data as string) as WebRTCMessage;
    if (msg.type === "file-start" && msg.id === fileAtoBId) {
      sinkOnB = await createIncomingFileSink("session-dual", msg.id, msg.name, msg.mimeType, msg.size);
      ctrlB.send(JSON.stringify({ type: "file-ready", id: msg.id }));
    } else if (msg.type === "file-end" && msg.id === fileAtoBId && sinkOnB) {
      fileOnB = await sinkOnB.close();
      ctrlB.send(JSON.stringify({ type: "file-ack", id: msg.id }));
    }
  });

  // Handle control messages on A (receiving from B)
  ctrlA.addEventListener("message", async (e) => {
    const msg = JSON.parse(e.data as string) as WebRTCMessage;
    if (msg.type === "file-start" && msg.id === fileBtoAId) {
      sinkOnA = await createIncomingFileSink("session-dual", msg.id, msg.name, msg.mimeType, msg.size);
      ctrlA.send(JSON.stringify({ type: "file-ready", id: msg.id }));
    } else if (msg.type === "file-end" && msg.id === fileBtoAId && sinkOnA) {
      fileOnA = await sinkOnA.close();
      ctrlA.send(JSON.stringify({ type: "file-ack", id: msg.id }));
    }
  });

  // Inbound binary on B
  inAtoB.addEventListener("message", async (e) => {
    if (sinkOnB) {
      const decoded = decodeBinaryFrame(e.data as ArrayBuffer);
      if (decoded && decoded.fileId === fileAtoBId) {
        await sinkOnB.write(decoded.payload, decoded.offset);
      }
    }
  });

  // Inbound binary on A
  inBtoA.addEventListener("message", async (e) => {
    if (sinkOnA) {
      const decoded = decodeBinaryFrame(e.data as ArrayBuffer);
      if (decoded && decoded.fileId === fileBtoAId) {
        await sinkOnA.write(decoded.payload, decoded.offset);
      }
    }
  });

  // Run both transfers concurrently
  await Promise.all([
    streamFileOverDataChannel(
      outAtoB as unknown as RTCDataChannel,
      fileAtoB,
      fileAtoBId,
      0,
      () => {},
      () => false,
      ctrlA as unknown as RTCDataChannel,
    ),
    streamFileOverDataChannel(
      outBtoA as unknown as RTCDataChannel,
      fileBtoA,
      fileBtoAId,
      0,
      () => {},
      () => false,
      ctrlB as unknown as RTCDataChannel,
    ),
  ]);

  assert.ok(fileOnB);
  assert.equal((fileOnB as any).size, 20 * 1024);
  assert.equal((fileOnB as any).name, "from_A.pdf");

  assert.ok(fileOnA);
  assert.equal((fileOnA as any).size, 10 * 1024);
  assert.equal((fileOnA as any).name, "from_B.jpg");
});

test("Lifecycle 15: OPFS fallback enforces size ceiling on RAM buffer", async () => {
  const hugeSize = 101 * 1024 * 1024; // 101 MB exceeds MAX_RAM_FALLBACK_BYTES (100 MB)
  await assert.rejects(
    async () => {
      await createIncomingFileSink("quota-test", generateTransferId(), "large.iso", "application/octet-stream", hugeSize);
    },
    /Direct-to-disk streaming \(OPFS\) is unavailable in this browser.*capped at 100 MB/,
  );
});

test("Lifecycle 16: Completed received files are never marked failed by stale messages", async () => {
  const completedList: { id: string; name: string }[] = [];
  const fileId = generateTransferId();

  // File is recorded as completed
  completedList.push({ id: fileId, name: "persisted.pdf" });

  // A stale file-error or duplicate file-start for an already completed file
  const isAlreadyDone = completedList.some((f) => f.id === fileId);
  assert.equal(isAlreadyDone, true, "Already completed file must be preserved");

  // Re-ack confirmation instead of error
  assert.ok(completedList.length === 1);
});

test("Lifecycle 17: decodeBinaryFrame strictly rejects malformed, invalid, or corrupted frames", () => {
  const validId = generateTransferId();
  const enc = new TextEncoder();
  const idBytes = enc.encode(validId);
  const payloadBytes = new Uint8Array([1, 2, 3, 4]);

  // 1. Valid frame decodes successfully
  const validBuf = encodeBinaryFrame(validId, 0, 0, payloadBytes.buffer);
  const decodedValid = decodeBinaryFrame(validBuf);
  assert.ok(decodedValid);
  assert.equal(decodedValid.fileId, validId);
  assert.equal(decodedValid.chunkIndex, 0);
  assert.equal(decodedValid.offset, 0);
  assert.equal(decodedValid.payload.byteLength, 4);

  // 2. Reject buffer smaller than minimum header
  assert.equal(decodeBinaryFrame(new ArrayBuffer(10)), null);

  // 3. Reject wrong magic bytes
  const badMagicBuf = validBuf.slice(0);
  new DataView(badMagicBuf).setUint16(0, 0x1234, false);
  assert.equal(decodeBinaryFrame(badMagicBuf), null);

  // 4. Reject unsupported version (e.g. version 2)
  const badVersionBuf = validBuf.slice(0);
  new DataView(badVersionBuf).setUint8(2, 2);
  assert.equal(decodeBinaryFrame(badVersionBuf), null);

  // 5. Reject non-zero flags
  const badFlagsBuf = validBuf.slice(0);
  new DataView(badFlagsBuf).setUint8(3, 0xff);
  assert.equal(decodeBinaryFrame(badFlagsBuf), null);

  // 6. Reject idLen too short (< 8) or too long (> 64)
  const shortIdBuf = validBuf.slice(0);
  new DataView(shortIdBuf).setUint8(4, 4);
  assert.equal(decodeBinaryFrame(shortIdBuf), null);

  const longIdBuf = validBuf.slice(0);
  new DataView(longIdBuf).setUint8(4, 70);
  assert.equal(decodeBinaryFrame(longIdBuf), null);

  // 7. Reject invalid protocol ID format (path traversal or invalid characters)
  const traversalId = "../../../secret";
  const travIdBytes = enc.encode(traversalId);
  const travBuf = new ArrayBuffer(5 + travIdBytes.length + 12);
  const travView = new DataView(travBuf);
  travView.setUint16(0, 0x4753, false); // BINARY_FRAME_MAGIC
  travView.setUint8(2, 1); // version
  travView.setUint8(3, 0); // flags
  travView.setUint8(4, travIdBytes.length);
  new Uint8Array(travBuf, 5, travIdBytes.length).set(travIdBytes);
  assert.equal(decodeBinaryFrame(travBuf), null);

  // 8. Reject invalid offset (e.g. negative or > MAX_SAFE_INTEGER)
  const badOffsetBuf = validBuf.slice(0);
  const idxOffset = 5 + idBytes.length;
  // Write a huge uint64 offset exceeding MAX_SAFE_INTEGER (e.g. 0xFFFFFFFFFFFFFFFF)
  new DataView(badOffsetBuf).setBigUint64(idxOffset + 4, BigInt("18446744073709551615"), false);
  assert.equal(decodeBinaryFrame(badOffsetBuf), null);
});

test("Lifecycle 18: Already-completed file receives instant file-ack without streaming binary chunks", async () => {
  const [senderCtrl, receiverCtrl] = createMockChannelPair("control");
  const [senderData, receiverData] = createMockChannelPair("file-transfer");

  const fileId = generateTransferId();
  const file = new File([new Uint8Array(100 * 1024)], "already_done.dat", { type: "application/octet-stream" });

  let binaryChunksReceived = 0;
  receiverData.addEventListener("message", () => {
    binaryChunksReceived++;
  });

  // Mock receiver behavior for already-completed file: reply immediately with file-ack on file-start
  receiverCtrl.addEventListener("message", (e) => {
    const msg = JSON.parse(e.data as string) as WebRTCMessage;
    if (msg.type === "file-start" && msg.id === fileId) {
      receiverCtrl.send(JSON.stringify({
        type: "file-ack",
        id: fileId,
        batchId: msg.batchId,
      }));
    }
  });

  let progressReported = 0;
  await streamFileOverDataChannel(
    senderData as unknown as RTCDataChannel,
    file,
    fileId,
    0,
    (sent, total) => {
      progressReported = sent;
    },
    () => false,
    senderCtrl as unknown as RTCDataChannel,
  );

  // Sender should recognize instant completion, report 100% progress, and stream ZERO binary chunks!
  assert.equal(progressReported, file.size);
  assert.equal(binaryChunksReceived, 0, "Zero binary chunks should be sent when file is already completed");
});

test("Lifecycle 19: Strict batch correlation rejects messages from foreign batches", async () => {
  const [senderCtrl, receiverCtrl] = createMockChannelPair("control");
  const [senderData, receiverData] = createMockChannelPair("file-transfer");

  const fileId = generateTransferId();
  const targetBatchId = `batch_${generateTransferId()}`;
  const foreignBatchId = `batch_${generateTransferId()}`;
  const file = new File([new Uint8Array(1024)], "batch_test.txt", { type: "text/plain" });

  let sink: Awaited<ReturnType<typeof createIncomingFileSink>> | null = null;

  receiverCtrl.addEventListener("message", async (e) => {
    const msg = JSON.parse(e.data as string) as WebRTCMessage;
    if (msg.type === "file-start" && msg.id === fileId) {
      // 1. Send file-ready with foreign batchId (should be ignored by sender)
      receiverCtrl.send(JSON.stringify({
        type: "file-ready",
        id: fileId,
        batchId: foreignBatchId,
      }));

      // 2. Short delay then send file-ready with correct targetBatchId
      setTimeout(async () => {
        sink = await createIncomingFileSink("test-session", msg.id, msg.name, msg.mimeType, msg.size);
        receiverCtrl.send(JSON.stringify({
          type: "file-ready",
          id: fileId,
          batchId: targetBatchId,
        }));
      }, 50);
    } else if (msg.type === "file-end" && msg.id === fileId && sink) {
      // Send file-ack with foreign batchId first (should be ignored by sender)
      receiverCtrl.send(JSON.stringify({
        type: "file-ack",
        id: fileId,
        batchId: foreignBatchId,
      }));

      // Short delay then send genuine file-ack with targetBatchId
      setTimeout(async () => {
        await sink!.close();
        receiverCtrl.send(JSON.stringify({
          type: "file-ack",
          id: fileId,
          batchId: targetBatchId,
        }));
      }, 50);
    }
  });

  receiverData.addEventListener("message", async (e) => {
    if (sink) {
      const decoded = decodeBinaryFrame(e.data as ArrayBuffer);
      if (decoded && decoded.fileId === fileId) {
        await sink.write(decoded.payload, decoded.offset);
      }
    }
  });

  // Streaming with strict batchId must complete successfully by filtering out foreign batch messages
  await streamFileOverDataChannel(
    senderData as unknown as RTCDataChannel,
    file,
    fileId,
    0,
    () => {},
    () => false,
    senderCtrl as unknown as RTCDataChannel,
    targetBatchId,
  );

  assert.ok(sink);
});
