import test from "node:test";
import assert from "node:assert/strict";

import {
  createSignalingSession,
  getSignalingSession,
  joinSignalingSession,
  updateSessionTtl,
  postSignalMessage,
  pollSignalMessages,
  closeSignalingSession,
  createInMemoryTestNamespace,
  SignalingStorageNamespace,
  SignalingStorageStub,
} from "../lib/signalStore";
import { isValidTtl, EXPIRY_OPTIONS } from "../lib/constants";
import { createIncomingFileSink, MAX_RAM_FALLBACK_BYTES } from "../lib/opfs";

// 1. Storage binding missing & fail-closed
test("Authoritative Store: fails closed when storage binding is missing", async () => {
  const invalidBinding = {} as unknown as SignalingStorageNamespace;
  await assert.rejects(
    async () => {
      await createSignalingSession("12345678", 3600, invalidBinding);
    },
    /Authoritative signaling storage binding/,
    "Session creation must fail closed when authoritative binding is unavailable",
  );
});

// 2. Storage write failure & fail-closed
test("Authoritative Store: fails closed when storage write fails", async () => {
  const failingStorage: SignalingStorageNamespace = {
    idFromName: (name: string) => name,
    get: (_id: unknown): SignalingStorageStub => ({
      async fetch(_request: Request): Promise<Response> {
        return new Response("Storage write disk failure", { status: 500 });
      },
    }),
  };

  await assert.rejects(
    async () => {
      await createSignalingSession("23456789", 3600, failingStorage);
    },
    /Failed to create authoritative session/,
    "Session creation must throw when storage write fails and not return a pairing code",
  );
});

// 3. Storage read failure
test("Authoritative Store: surfaces read errors when storage fails", async () => {
  const failingStorage: SignalingStorageNamespace = {
    idFromName: (name: string) => name,
    get: (_id: unknown): SignalingStorageStub => ({
      async fetch(_request: Request): Promise<Response> {
        return new Response("Storage read timeout", { status: 503 });
      },
    }),
  };

  await assert.rejects(
    async () => {
      await getSignalingSession("34567890", failingStorage);
    },
    /Failed to get session from authoritative store/,
    "Session lookup must throw when authoritative storage errors",
  );
});

// 4. Cross-isolate persistence via shared storage
test("Cross-Isolate Persistence: sessions created by Isolate A are immediately accessible to Isolate B", async () => {
  const sharedStorage = createInMemoryTestNamespace();
  const testCode = "45678901";

  // Isolate A creates session
  const { session: isolateASession } = await createSignalingSession(testCode, 3600, sharedStorage);
  assert.equal(isolateASession.code, testCode);

  // Isolate B (separate request context, separate client) queries session
  const isolateBSession = await getSignalingSession(testCode, sharedStorage);
  assert.ok(isolateBSession !== null);
  assert.equal(isolateBSession.code, testCode);
  assert.equal(isolateBSession.receiverActive, true);
  assert.equal(isolateBSession.senderActive, false);
});

// 5. Concurrent signaling messages and atomic ordering
test("Signaling Messages: concurrent messages are preserved without dropping or overwriting", async () => {
  const storage = createInMemoryTestNamespace();
  const testCode = "56789012";

  await createSignalingSession(testCode, 3600, storage);
  await joinSignalingSession(testCode, storage);

  // Post 10 concurrent signaling messages (e.g. rapid ICE candidates)
  const posts = Array.from({ length: 10 }, (_, i) =>
    postSignalMessage(testCode, "sender", "receiver", "candidate", { candidate: `cand-${i}` }, storage),
  );

  const results = await Promise.all(posts);
  assert.ok(results.every((r) => r === true));

  // Poll messages
  const received = await pollSignalMessages(testCode, "receiver", 0, storage);
  assert.equal(received.length, 10, "All 10 concurrent messages must be preserved");

  const candidates = received.map((m) => (m.data as { candidate: string }).candidate);
  for (let i = 0; i < 10; i++) {
    assert.ok(candidates.includes(`cand-${i}`), `Must contain cand-${i}`);
  }
});

// 6. Expired session joins are rejected
test("Session Expiry: expired sessions cannot be joined or polled", async () => {
  const storage = createInMemoryTestNamespace();
  const testCode = "67890123";

  // Create session with negative / zero TTL
  await createSignalingSession(testCode, -10, storage);

  const session = await getSignalingSession(testCode, storage);
  assert.equal(session, null, "Expired session must return null");

  const joinSuccess = await joinSignalingSession(testCode, storage);
  assert.equal(joinSuccess, false, "Expired session cannot be joined");

  const postSuccess = await postSignalMessage(testCode, "sender", "receiver", "ping", {}, storage);
  assert.equal(postSuccess, false, "Cannot post message to expired session");
});

// 7. Receiver token capability security
test("Security Capability: unauthorized caller cannot modify session expiry without receiver token", async () => {
  const storage = createInMemoryTestNamespace();
  const testCode = "78901234";

  const { receiverToken } = await createSignalingSession(testCode, 3600, storage);
  assert.ok(receiverToken);

  // Unauthorized modification attempt with fake token
  await assert.rejects(
    async () => {
      await updateSessionTtl(testCode, 7200, "malicious-fake-token", storage);
    },
    /Unauthorized/,
    "Session update must reject with unauthorized error when receiverToken is invalid",
  );

  // Authorized modification with genuine receiver token
  const updated = await updateSessionTtl(testCode, 7200, receiverToken, storage);
  assert.equal(updated.ok, true);
  const updatedSession = await getSignalingSession(testCode, storage);
  assert.equal(
    Math.round((updatedSession!.expiresAt - updatedSession!.createdAt) / 1000),
    7200,
    "Authorized receiver token must successfully update session TTL",
  );
});

// 8. Payload validation and TTL options
test("Validation: enforces supported TTL options and rejects malformed inputs", () => {
  // All documented EXPIRY_OPTIONS must be valid
  for (const opt of EXPIRY_OPTIONS) {
    assert.ok(isValidTtl(opt.seconds), `Duration ${opt.label} (${opt.seconds}s) must be valid`);
  }

  // Arbitrary or invalid TTLs must be rejected
  assert.equal(isValidTtl(1), false);
  assert.equal(isValidTtl(9999), false);
  assert.equal(isValidTtl(-3600), false);
  assert.equal(isValidTtl("3600"), false);
  assert.equal(isValidTtl(null), false);
  assert.equal(isValidTtl(undefined), false);
});

// 9. OPFS Fallback: Bounded RAM buffer ceiling and verification
test("OPFS Fallback: enforces size ceiling on RAM buffer and verifies expected length", async () => {
  const testCode = "89012345";

  // Exceeding MAX_RAM_FALLBACK_BYTES (100 MB) when OPFS is unavailable must throw safely
  await assert.rejects(
    async () => {
      await createIncomingFileSink(
        testCode,
        "huge-file-id",
        "huge.zip",
        "application/zip",
        MAX_RAM_FALLBACK_BYTES + 1024,
      );
    },
    /Direct-to-disk streaming \(OPFS\) is unavailable in this browser/,
    "Must reject transfers exceeding RAM ceiling when OPFS is unsupported",
  );

  // Allowed size in RAM fallback
  const sink = await createIncomingFileSink(
    testCode,
    "valid-file-id",
    "valid.txt",
    "text/plain",
    5, // 5 bytes expected
  );

  const chunk = new TextEncoder().encode("Hello").buffer;
  await sink.write(chunk);
  const file = await sink.close();
  assert.equal(file.name, "valid.txt");
  assert.equal(file.size, 5);
});

// 10. OPFS Fallback: Byte length mismatch triggers verification error
test("OPFS Fallback: incomplete or truncated file triggers verification error", async () => {
  const sink = await createIncomingFileSink(
    "90123456",
    "trunc-file-id",
    "truncated.bin",
    "application/octet-stream",
    100, // Expected 100 bytes
  );

  // Write only 10 bytes then close
  const truncatedChunk = new Uint8Array(10).buffer;
  await sink.write(truncatedChunk);

  await assert.rejects(
    async () => {
      await sink.close();
    },
    /Transferred byte length mismatch/,
    "Must throw verification error when received bytes do not match expected size",
  );
});
