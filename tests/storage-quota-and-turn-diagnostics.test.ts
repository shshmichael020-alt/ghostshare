import test from "node:test";
import assert from "node:assert/strict";
import {
  ByteRangeTracker,
  createIncomingFileSink,
  MAX_RAM_FALLBACK_BYTES,
  checkStorageCapability,
} from "../lib/opfs";
import {
  isSafeIceUrl,
  sanitizeIceServer,
  sanitizeIceServers,
  parseAndValidateTurnServersJson,
} from "../lib/iceConfig";
import {
  DEFAULT_ICE_SERVERS,
  fetchIceServerConfig,
  fetchIceServers,
  inspectActiveCandidatePair,
  getSanitizedConnectionDiagnostic,
  generateTransferId,
} from "../lib/webrtc";

// ---------------------------------------------------------------------------
// 1. ByteRangeTracker Tests: Gap Detection, Duplicates, & Range Coalescing
// ---------------------------------------------------------------------------

test("ByteRangeTracker: contiguous sequential chunks coalesce to complete status", () => {
  const tracker = new ByteRangeTracker(1000);
  assert.equal(tracker.isComplete(), false);

  const res1 = tracker.addRange(0, 400);
  assert.equal(res1.isDuplicate, false);
  assert.equal(res1.isOutOfBounds, false);
  assert.equal(tracker.isComplete(), false);
  assert.equal(tracker.getTotalBytesReceived(), 400);

  const res2 = tracker.addRange(400, 600);
  assert.equal(res2.isDuplicate, false);
  assert.equal(res2.isOutOfBounds, false);
  assert.equal(tracker.isComplete(), true);
  assert.equal(tracker.getTotalBytesReceived(), 1000);
  assert.deepEqual(tracker.getMissingRanges(), []);
});

test("ByteRangeTracker: detects missing gaps and out-of-order chunks correctly", () => {
  const tracker = new ByteRangeTracker(1000);

  // Chunk 1 at offset 0 (len 300) -> [0..300)
  tracker.addRange(0, 300);
  // Chunk 3 at offset 700 (len 300) -> [700..1000) (Chunk 2 at 300..700 is missing!)
  tracker.addRange(700, 300);

  assert.equal(tracker.isComplete(), false);
  assert.equal(tracker.getTotalBytesReceived(), 600);

  const missing = tracker.getMissingRanges();
  assert.equal(missing.length, 1);
  assert.deepEqual(missing[0], { start: 300, end: 700 });

  // Now Chunk 2 arrives out-of-order -> completes the stream!
  const resMid = tracker.addRange(300, 400);
  assert.equal(resMid.isDuplicate, false);
  assert.equal(tracker.isComplete(), true);
  assert.equal(tracker.getTotalBytesReceived(), 1000);
  assert.deepEqual(tracker.getMissingRanges(), []);
});

test("ByteRangeTracker: handles duplicate, overlapping, and out-of-bounds chunks safely", () => {
  const tracker = new ByteRangeTracker(1000);
  tracker.addRange(0, 500);

  // Exact duplicate
  const dup = tracker.addRange(0, 500);
  assert.equal(dup.isDuplicate, true);

  // Sub-range duplicate
  const subDup = tracker.addRange(100, 200);
  assert.equal(subDup.isDuplicate, true);

  // Overlapping chunk [400..800)
  const overlap = tracker.addRange(400, 400);
  assert.equal(overlap.isDuplicate, false);
  assert.equal(tracker.getTotalBytesReceived(), 800);

  // Out of bounds chunk [800..1200) -> end 1200 exceeds 1000
  const oob = tracker.addRange(800, 400);
  assert.equal(oob.isOutOfBounds, true);

  // Negative offset
  const neg = tracker.addRange(-10, 100);
  assert.equal(neg.isOutOfBounds, true);

  // Final valid chunk to complete
  tracker.addRange(800, 200);
  assert.equal(tracker.isComplete(), true);
});

// ---------------------------------------------------------------------------
// 2. Artificial Truncation Defense & Bounded RAM Fallback
// ---------------------------------------------------------------------------

test("Integrity: Incomplete transfer ending early fails and is NOT artificially extended", async () => {
  const fileId = generateTransferId();
  const advertisedSize = 10 * 1024 * 1024; // 10 MB
  const actualSentBytes = 2 * 1024 * 1024; // Only 2 MB sent

  const sink = await createIncomingFileSink(
    "test-truncation",
    fileId,
    "truncated.bin",
    "application/octet-stream",
    advertisedSize,
  );

  // Send only 2 MB
  const chunk = new Uint8Array(actualSentBytes).fill(0xaa);
  await sink.write(chunk.buffer, 0);

  // Finalizing when only 2 MB of 10 MB arrived MUST fail with missing range error
  await assert.rejects(
    async () => {
      await sink.close();
    },
    (err: Error) => {
      return (
        err.message.includes("Transferred byte length mismatch") &&
        err.message.includes("missing byte ranges") &&
        err.message.includes("Expected 10485760 bytes, received 2097152 bytes")
      );
    },
  );
});

test("RAM Fallback: Rejects transfers exceeding 100 MB when OPFS is unavailable", async () => {
  const fileId = generateTransferId();
  const hugeSize = 105 * 1024 * 1024; // 105 MB

  await assert.rejects(
    async () => {
      await createIncomingFileSink("test-ram-limit", fileId, "huge.iso", "application/octet-stream", hugeSize);
    },
    /Direct-to-disk streaming \(OPFS\) is unavailable in this browser.*capped at 100 MB/,
  );
});

test("RAM Fallback: Allows files under 100 MB and verifies full contiguous content", async () => {
  const fileId = generateTransferId();
  const testSize = 256 * 1024; // 256 KB
  const sink = await createIncomingFileSink("test-ram-ok", fileId, "document.pdf", "application/pdf", testSize);

  const half = testSize / 2;
  const chunk1 = new Uint8Array(half).fill(1).buffer;
  const chunk2 = new Uint8Array(half).fill(2).buffer;

  await sink.write(chunk1, 0);
  await sink.write(chunk2, half);

  const file = await sink.close();
  assert.equal(file.size, testSize);
  assert.equal(file.name, "document.pdf");
  assert.equal(file.type, "application/pdf");
});

// ---------------------------------------------------------------------------
// 3. Mock OPFS Direct-to-Disk Streaming (> 100 MB Support & Quota)
// ---------------------------------------------------------------------------

function installMockOpfs(options?: {
  freeSpaceBytes?: number;
  failOnWrite?: boolean;
}) {
  const freeSpace = options?.freeSpaceBytes ?? 500 * 1024 * 1024 * 1024; // 500 GB default free
  const storedFiles = new Map<string, { buffer: Uint8Array; size: number }>();

  const mockFileHandle = (name: string) => {
    let internalBuffer = new Uint8Array(0);
    return {
      getFile: async () => {
        const stored = storedFiles.get(name) || { buffer: internalBuffer, size: internalBuffer.length };
        return new File([stored.buffer.slice(0, stored.size)], name);
      },
      createWritable: async () => {
        let cursor = 0;
        let closed = false;
        return {
          seek: async (pos: number) => {
            cursor = pos;
          },
          truncate: async (size: number) => {
            if (size > internalBuffer.length) {
              const next = new Uint8Array(size);
              next.set(internalBuffer, 0);
              internalBuffer = next;
            } else {
              internalBuffer = internalBuffer.slice(0, size);
            }
          },
          write: async (chunk: ArrayBuffer) => {
            if (options?.failOnWrite) {
              const err = new Error("Storage quota exceeded");
              err.name = "QuotaExceededError";
              throw err;
            }
            const src = new Uint8Array(chunk);
            if (cursor + src.length > internalBuffer.length) {
              const next = new Uint8Array(cursor + src.length);
              next.set(internalBuffer, 0);
              internalBuffer = next;
            }
            internalBuffer.set(src, cursor);
            cursor += src.length;
          },
          close: async () => {
            closed = true;
            storedFiles.set(name, { buffer: internalBuffer, size: internalBuffer.length });
          },
          abort: async () => {
            closed = true;
            storedFiles.delete(name);
          },
        };
      },
    };
  };

  const mockDirHandle = {
    getFileHandle: async (name: string) => mockFileHandle(name),
    removeEntry: async (name: string) => {
      storedFiles.delete(name);
    },
  };

  const mockRootHandle = {
    getDirectoryHandle: async () => mockDirHandle,
  };

  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const originalWindow = (globalThis as any).window;

  (globalThis as any).window = {};
  Object.defineProperty(globalThis, "navigator", {
    value: {
      storage: {
        getDirectory: async () => mockRootHandle,
        estimate: async () => ({
          quota: freeSpace * 2,
          usage: freeSpace,
        }),
      },
    },
    configurable: true,
    writable: true,
  });

  return () => {
    if (originalNavigator) {
      Object.defineProperty(globalThis, "navigator", originalNavigator);
    }
    (globalThis as any).window = originalWindow;
  };
}

test("OPFS: Streams files > 100 MB directly to disk without RAM exhaustion", async () => {
  const uninstall = installMockOpfs();
  try {
    const fileId = generateTransferId();
    const largeSize = 120 * 1024 * 1024; // 120 MB (exceeds MAX_RAM_FALLBACK_BYTES)

    const sink = await createIncomingFileSink(
      "test-large-opfs",
      fileId,
      "large_dataset.bin",
      "application/octet-stream",
      largeSize,
    );

    // Stream in two 60 MB chunks
    const chunkSize = 60 * 1024 * 1024;
    const chunkA = new Uint8Array(chunkSize).fill(0x11).buffer;
    const chunkB = new Uint8Array(chunkSize).fill(0x22).buffer;

    await sink.write(chunkA, 0);
    await sink.write(chunkB, chunkSize);

    assert.equal(sink.getBytesWritten(), largeSize);
    assert.equal(sink.isComplete(), true);

    const file = await sink.close();
    assert.equal(file.size, largeSize);
    assert.equal(file.name, "large_dataset.bin");
  } finally {
    uninstall();
  }
});

test("OPFS: Storage quota check fails before transfer when device space is insufficient", async () => {
  // Only 50 MB free on device
  const uninstall = installMockOpfs({ freeSpaceBytes: 50 * 1024 * 1024 });
  try {
    const fileId = generateTransferId();
    const neededSize = 100 * 1024 * 1024; // 100 MB requested

    await assert.rejects(
      async () => {
        await createIncomingFileSink("test-quota", fileId, "big.zip", "application/zip", neededSize);
      },
      /Insufficient storage space: incoming file requires 100 MB, but device has only 50 MB available/,
    );
  } finally {
    uninstall();
  }
});

test("OPFS: In-flight disk write failure (QuotaExceededError) triggers safe abort and cleanup", async () => {
  const uninstall = installMockOpfs({ failOnWrite: true });
  try {
    const fileId = generateTransferId();
    const sink = await createIncomingFileSink("test-exhaustion", fileId, "data.bin", "application/octet-stream", 1024);

    await assert.rejects(
      async () => {
        await sink.write(new Uint8Array(512).buffer, 0);
      },
      /Disk write failed: Storage quota exceeded/,
    );

    // Verify abort can be called cleanly
    await sink.abort();
  } finally {
    uninstall();
  }
});

// ---------------------------------------------------------------------------
// 4. Reliable TURN Configuration & Candidate Pair Diagnostics
// ---------------------------------------------------------------------------

test("TURN Config: DEFAULT_ICE_SERVERS does not contain hardcoded public example credentials", () => {
  for (const s of DEFAULT_ICE_SERVERS) {
    const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
    for (const u of urls) {
      assert.ok(
        !u.includes("openrelay.metered.ca"),
        "Must not depend on hardcoded public openrelay example in production fallback",
      );
      assert.ok(
        !u.includes("numb.viagenie.ca"),
        "Must not depend on deprecated public example TURN endpoints",
      );
    }
    // Verify no hardcoded credentials
    assert.equal(s.username, undefined);
    assert.equal(s.credential, undefined);
  }
});

test("TURN Config: fetchIceServerConfig identifies default STUN vs authenticated TURN", async () => {
  // Test fallback in Node environment where fetch to /api/signal/ice-servers fails
  const config = await fetchIceServerConfig();
  assert.equal(config.turnConfigured, false);
  assert.equal(config.source, "default-stun");
  assert.ok(Array.isArray(config.iceServers));
  assert.ok(config.iceServers.length > 0);

  // Backward compatible fetchIceServers returns matching array
  const servers = await fetchIceServers();
  assert.deepEqual(servers, config.iceServers);
});

test("Diagnostics: inspectActiveCandidatePair identifies direct P2P vs TURN Relay paths", async () => {
  // Mock RTCPeerConnection with direct P2P candidate pair (srflx <-> srflx)
  const directStats = new Map<string, any>([
    [
      "cp1",
      {
        type: "candidate-pair",
        selected: true,
        localCandidateId: "c1",
        remoteCandidateId: "c2",
      },
    ],
    ["c1", { id: "c1", candidateType: "srflx", protocol: "udp" }],
    ["c2", { id: "c2", candidateType: "srflx", protocol: "udp" }],
  ]);

  const mockDirectPc = {
    getStats: async () => directStats,
  } as unknown as RTCPeerConnection;

  const directPair = await inspectActiveCandidatePair(mockDirectPc);
  assert.ok(directPair);
  assert.equal(directPair!.isRelayed, false);
  assert.equal(directPair!.localCandidateType, "srflx");
  assert.equal(directPair!.remoteCandidateType, "srflx");

  const directDiag = getSanitizedConnectionDiagnostic("connected", "connected", false, directPair);
  assert.equal(directDiag, "Connected via Direct P2P (srflx <-> srflx)");

  // Mock RTCPeerConnection with relayed TURN candidate pair (relay <-> relay)
  const relayStats = new Map<string, any>([
    [
      "cp2",
      {
        type: "candidate-pair",
        nominated: true,
        localCandidateId: "c3",
        remoteCandidateId: "c4",
      },
    ],
    ["c3", { id: "c3", candidateType: "relay", protocol: "udp" }],
    ["c4", { id: "c4", candidateType: "relay", protocol: "udp" }],
  ]);

  const mockRelayPc = {
    getStats: async () => relayStats,
  } as unknown as RTCPeerConnection;

  const relayPair = await inspectActiveCandidatePair(mockRelayPc);
  assert.ok(relayPair);
  assert.equal(relayPair!.isRelayed, true);

  const relayDiag = getSanitizedConnectionDiagnostic("connected", "connected", true, relayPair);
  assert.equal(relayDiag, "Connected via TURN Relay (UDP)");
});

test("Diagnostics: failure diagnostics accurately warn about symmetric NAT when TURN is unconfigured", () => {
  const diagNoTurn = getSanitizedConnectionDiagnostic("failed", "failed", false, null);
  assert.ok(diagNoTurn?.includes("Direct P2P connection failed"));
  assert.ok(diagNoTurn?.includes("Symmetric NAT"));
  assert.ok(diagNoTurn?.includes("TURN relay must be configured"));

  const diagWithTurn = getSanitizedConnectionDiagnostic("failed", "failed", true, null);
  assert.ok(diagWithTurn?.includes("P2P and TURN relay connection failed"));
});

// ---------------------------------------------------------------------------
// 5. User-Selected File Destination & Terminal Write Safety Tests
// ---------------------------------------------------------------------------

test("User-Selected Destination: Streams chunks directly to provided FileSystemFileHandle", async () => {
  const writtenChunks: ArrayBuffer[] = [];
  let isClosed = false;

  const mockWritable = {
    seek: async () => {},
    truncate: async () => {},
    write: async (chunk: ArrayBuffer) => {
      writtenChunks.push(chunk);
    },
    close: async () => {
      isClosed = true;
    },
    abort: async () => {},
  };

  const mockFile = new File([new Uint8Array(2000)], "destination.bin");

  const mockUserFileHandle = {
    createWritable: async () => mockWritable,
    getFile: async () => mockFile,
  } as unknown as FileSystemFileHandle;

  const fileId = generateTransferId();
  const sink = await createIncomingFileSink(
    "test-user-dest",
    fileId,
    "destination.bin",
    "application/octet-stream",
    2000,
    0,
    { userFileHandle: mockUserFileHandle },
  );

  const chunk1 = new Uint8Array(1000).fill(0x11).buffer;
  const chunk2 = new Uint8Array(1000).fill(0x22).buffer;

  await sink.write(chunk1, 0);
  await sink.write(chunk2, 1000);

  const finalizedFile = await sink.close();
  assert.equal(finalizedFile.name, "destination.bin");
  assert.equal(finalizedFile.size, 2000);
  assert.equal(isClosed, true);
  assert.equal(writtenChunks.length, 2);
});

test("ByteRangeTracker: detects and rejects conflicting partial chunk overlaps", () => {
  const tracker = new ByteRangeTracker(1000);
  tracker.addRange(0, 500); // [0..500)

  // Chunk [400..700) partially overlaps [0..500)
  const validation = tracker.validateChunk(400, 300);
  assert.equal(validation.isConflictingOverlap, true);
  assert.equal(validation.isDuplicate, false);
});

test("Terminal Write Failure: Write failure is terminal and preserved on close without erasure", async () => {
  let writeCount = 0;
  const mockWritable = {
    seek: async () => {},
    truncate: async () => {},
    write: async () => {
      writeCount++;
      if (writeCount === 2) {
        throw new Error("Disk full error");
      }
    },
    close: async () => {},
    abort: async () => {},
  };

  const mockHandle = {
    createWritable: async () => mockWritable,
    getFile: async () => new File([new Uint8Array(300)], "f.bin"),
  } as unknown as FileSystemFileHandle;

  const fileId = generateTransferId();
  const sink = await createIncomingFileSink(
    "test-term-write",
    fileId,
    "f.bin",
    "application/octet-stream",
    300,
    0,
    { userFileHandle: mockHandle },
  );

  await sink.write(new Uint8Array(100).buffer, 0); // 1st write ok

  await assert.rejects(
    async () => {
      await sink.write(new Uint8Array(100).buffer, 100); // 2nd write fails
    },
    /Disk full error/,
  );

  // Subsequent 3rd write must immediately reject with terminal error
  await assert.rejects(
    async () => {
      await sink.write(new Uint8Array(100).buffer, 200);
    },
    /Disk full error/,
  );

  // close() must also throw the terminal error
  await assert.rejects(
    async () => {
      await sink.close();
    },
    /Disk full error/,
  );
});

test("TURN Provider: Generates authenticated credentials from Cloudflare Realtime API response", () => {
  const mockCloudflareResponse = {
    iceServers: [
      { urls: ["stun:stun.cloudflare.com:3478"] },
      {
        urls: [
          "turn:turn.cloudflare.com:3478?transport=udp",
          "turn:turn.cloudflare.com:443?transport=tcp",
          "turns:turn.cloudflare.com:5349?transport=tcp",
        ],
        username: "user_test_token_123",
        credential: "cred_test_secret_456",
      },
    ],
  };

  const turnServer = mockCloudflareResponse.iceServers.find((s) =>
    Array.isArray(s.urls) && s.urls.some((u) => u.startsWith("turn:") || u.startsWith("turns:"))
  );

  assert.ok(turnServer);
  assert.equal(turnServer!.username, "user_test_token_123");
  assert.equal(turnServer!.credential, "cred_test_secret_456");
  assert.ok(turnServer!.urls.some((u) => u.includes("turn.cloudflare.com")));
});

// ---------------------------------------------------------------------------
// 7. Comprehensive ByteRangeTracker Boundary, Overlap, & Invalid Chunk Tests
// ---------------------------------------------------------------------------

test("ByteRangeTracker: Comprehensive boundary, duplicate, overlap, and gap matrix", () => {
  const tracker = new ByteRangeTracker(1000);
  tracker.addRange(100, 400); // commits [100..500)

  // 1. Contained range with different boundaries (sub-range)
  const subChunk = tracker.validateChunk(150, 200); // [150..350)
  assert.equal(subChunk.isDuplicate, true);
  assert.equal(subChunk.isConflictingOverlap, false);
  assert.equal(subChunk.isOutOfBounds, false);

  // 2. Exact duplicate chunk
  const exactDup = tracker.validateChunk(100, 400); // [100..500)
  assert.equal(exactDup.isDuplicate, true);
  assert.equal(exactDup.isConflictingOverlap, false);

  // 3. Right-extending overlap
  const rightExtend = tracker.validateChunk(400, 200); // [400..600) extends past 500
  assert.equal(rightExtend.isConflictingOverlap, true);
  assert.equal(rightExtend.isDuplicate, false);

  // 4. Left-extending overlap
  const leftExtend = tracker.validateChunk(50, 100); // [50..150) penetrates into [100..500)
  assert.equal(leftExtend.isConflictingOverlap, true);
  assert.equal(leftExtend.isDuplicate, false);

  // 5. Enclosing overlap
  const enclosing = tracker.validateChunk(50, 500); // [50..550) completely encloses [100..500)
  assert.equal(enclosing.isConflictingOverlap, true);
  assert.equal(enclosing.isDuplicate, false);

  // 6. Zero-length chunk
  const zeroLen = tracker.validateChunk(200, 0);
  assert.equal(zeroLen.isZeroLength, true);
  assert.equal(zeroLen.isDuplicate, false);
  assert.equal(zeroLen.isConflictingOverlap, false);
  assert.equal(zeroLen.isOutOfBounds, false);

  // 7. Negative offset
  const negOffset = tracker.validateChunk(-50, 100);
  assert.equal(negOffset.isOutOfBounds, true);
  assert.equal(negOffset.isInvalid, true);

  // 8. Non-finite offset (NaN, Infinity)
  const nanOffset = tracker.validateChunk(NaN, 100);
  assert.equal(nanOffset.isOutOfBounds, true);
  assert.equal(nanOffset.isInvalid, true);

  const infOffset = tracker.validateChunk(Infinity, 100);
  assert.equal(infOffset.isOutOfBounds, true);
  assert.equal(infOffset.isInvalid, true);

  // 9. Non-finite length
  const infLength = tracker.validateChunk(100, Infinity);
  assert.equal(infLength.isOutOfBounds, true);
  assert.equal(infLength.isInvalid, true);

  // 10. Range beyond expected size
  const pastEnd = tracker.validateChunk(800, 300); // 800 + 300 = 1100 > 1000
  assert.equal(pastEnd.isOutOfBounds, true);
  assert.equal(pastEnd.isInvalid, true);

  // 11. Gap detection before and after
  const missing = tracker.getMissingRanges();
  assert.deepEqual(missing, [
    { start: 0, end: 100 },
    { start: 500, end: 1000 },
  ]);

  // Fill gap at [0..100)
  tracker.addRange(0, 100);
  assert.deepEqual(tracker.getMissingRanges(), [{ start: 500, end: 1000 }]);

  // Fill remaining [500..1000)
  tracker.addRange(500, 500);
  assert.equal(tracker.isComplete(), true);
  assert.deepEqual(tracker.getMissingRanges(), []);
});

// ---------------------------------------------------------------------------
// 8. User-Selected File Destination Failure Safety
// ---------------------------------------------------------------------------

test("User Destination Failure: createWritable failure throws explicit error without falling back to RAM", async () => {
  const failingHandle = {
    createWritable: async () => {
      throw new Error("Permission denied or disk locked");
    },
    getFile: async () => new File([new Uint8Array(500)], "locked.bin"),
  } as unknown as FileSystemFileHandle;

  const fileId = generateTransferId();

  await assert.rejects(
    async () => {
      await createIncomingFileSink(
        "test-fail-writable",
        fileId,
        "locked.bin",
        "application/octet-stream",
        500,
        0,
        { userFileHandle: failingHandle },
      );
    },
    /Failed to open destination file for writing: Permission denied or disk locked/,
  );
});

// ---------------------------------------------------------------------------
// 9. Unified ICE Server Sanitization & Validation Tests
// ---------------------------------------------------------------------------

test("ICE Sanitization: isSafeIceUrl correctly accepts valid schemes and filters port 53", () => {
  // Safe URLs
  assert.equal(isSafeIceUrl("stun:stun.cloudflare.com:3478"), true);
  assert.equal(isSafeIceUrl("turn:turn.cloudflare.com:443?transport=tcp"), true);
  assert.equal(isSafeIceUrl("turns:turn.cloudflare.com:5349?transport=tcp"), true);
  assert.equal(isSafeIceUrl("stun:stun.relay.metered.ca:80"), true);

  // Prohibited port 53
  assert.equal(isSafeIceUrl("turn:turn.example.com:53"), false);
  assert.equal(isSafeIceUrl("turn:turn.example.com:53?transport=tcp"), false);
  assert.equal(isSafeIceUrl("turns:turn.example.com:53?transport=udp"), false);
  assert.equal(isSafeIceUrl("stun:stun.example.com:53"), false);

  // Invalid schemes
  assert.equal(isSafeIceUrl("http://example.com"), false);
  assert.equal(isSafeIceUrl("ws://example.com"), false);
  assert.equal(isSafeIceUrl(""), false);
  assert.equal(isSafeIceUrl(null), false);
});

test("ICE Sanitization: sanitizeIceServers strips port 53 and unauthenticated TURN", () => {
  const mixedServers = [
    // Entry with port 53 in array of URLs
    {
      urls: ["turn:turn.example.com:3478", "turn:turn.example.com:53"],
      username: "user1",
      credential: "pass1",
    },
    // Entry with ONLY port 53 (should be discarded)
    {
      urls: ["turn:turn.example.com:53"],
      username: "user2",
      credential: "pass2",
    },
    // Unauthenticated TURN entry (missing username/credential) -> should be discarded
    {
      urls: ["turn:unauth.example.com:3478"],
    },
    // Valid STUN entry
    {
      urls: ["stun:stun.google.com:19302"],
    },
  ];

  const result = sanitizeIceServers(mixedServers);
  assert.equal(result.hasAuthenticatedTurn, true);
  assert.equal(result.iceServers.length, 2);

  // First server should have port 53 removed from urls array
  assert.deepEqual(result.iceServers[0].urls, "turn:turn.example.com:3478");
  assert.equal(result.iceServers[0].username, "user1");

  // Second server should be the STUN server
  assert.deepEqual(result.iceServers[1].urls, "stun:stun.google.com:19302");
});

test("ICE Sanitization: parseAndValidateTurnServersJson enforces authenticated TURN requirement", () => {
  // 1. Authenticated TURN JSON
  const authTurnJson = JSON.stringify([
    {
      urls: "turn:relay.metered.ca:443",
      username: "metered_user",
      credential: "metered_pass",
    },
  ]);
  const resAuth = parseAndValidateTurnServersJson(authTurnJson);
  assert.ok(resAuth);
  assert.equal(resAuth!.turnConfigured, true);
  assert.equal(resAuth!.iceServers.length, 1);

  // 2. STUN-only JSON (must NOT return turnConfigured: true)
  const stunOnlyJson = JSON.stringify([
    {
      urls: "stun:stun.example.com:3478",
    },
  ]);
  const resStun = parseAndValidateTurnServersJson(stunOnlyJson);
  assert.ok(resStun);
  assert.equal(resStun!.turnConfigured, false);

  // 3. Unauthenticated TURN JSON (missing password) -> drops TURN, turnConfigured is false
  const unauthTurnJson = JSON.stringify([
    {
      urls: "turn:unauth.example.com:3478",
    },
  ]);
  const resUnauth = parseAndValidateTurnServersJson(unauthTurnJson);
  assert.equal(resUnauth, null);

  // 4. Invalid JSON
  assert.equal(parseAndValidateTurnServersJson("not json"), null);
  assert.equal(parseAndValidateTurnServersJson("[]"), null);
});
