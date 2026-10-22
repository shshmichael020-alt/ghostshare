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
  checkCrossIsolateRateLimit,
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

// 5. Concurrent signaling messages and monotonic sequence ordering
test("Signaling Messages: concurrent messages receive strictly monotonic sequences and cursor polling returns all", async () => {
  const storage = createInMemoryTestNamespace();
  const testCode = "56789012";

  const { receiverToken } = await createSignalingSession(testCode, 3600, storage);
  const joinRes = await joinSignalingSession(testCode, undefined, storage);
  assert.equal(joinRes.ok, true);
  const senderToken = joinRes.senderToken!;

  // Post 10 concurrent signaling messages from sender
  const posts = Array.from({ length: 10 }, (_, i) =>
    postSignalMessage(testCode, "sender", "receiver", "candidate", { candidate: `cand-${i}` }, senderToken, storage),
  );

  const results = await Promise.all(posts);
  assert.ok(results.every((r) => r.ok === true));

  // Poll messages using receiverToken
  const pollRes = await pollSignalMessages(testCode, "receiver", 0, receiverToken, storage);
  assert.equal(pollRes.messages.length, 10, "All 10 concurrent messages must be preserved");

  // Verify sequences are strictly increasing
  for (let i = 1; i < pollRes.messages.length; i++) {
    const prevSeq = pollRes.messages[i - 1].seq!;
    const currSeq = pollRes.messages[i].seq!;
    assert.ok(currSeq > prevSeq, `Sequence ${currSeq} must be strictly greater than ${prevSeq}`);
  }

  // Polling with cursor returns zero new messages
  const pollAgain = await pollSignalMessages(testCode, "receiver", pollRes.cursor, receiverToken, storage);
  assert.equal(pollAgain.messages.length, 0, "No duplicate messages on subsequent cursor poll");
});

// 6. Expired session joins are rejected
test("Session Expiry: expired sessions cannot be joined or polled", async () => {
  const storage = createInMemoryTestNamespace();
  const testCode = "67890123";

  // Create session with negative / zero TTL
  await createSignalingSession(testCode, -10, storage);

  const session = await getSignalingSession(testCode, storage);
  assert.equal(session, null, "Expired session must return null");

  const joinSuccess = await joinSignalingSession(testCode, undefined, storage);
  assert.equal(joinSuccess.ok, false, "Expired session cannot be joined");

  const postSuccess = await postSignalMessage(testCode, "sender", "receiver", "ping", {}, "dummy-token", storage);
  assert.equal(postSuccess.ok, false, "Cannot post message to expired session");
});

// 7. Receiver token capability security for TTL
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

// 8. Session Deletion Security: unauthorized deletion, invalid token, genuine token, failed close
test("Session Deletion Security: DELETE requires valid receiver token and fails safely", async () => {
  const storage = createInMemoryTestNamespace();
  const testCode = "89012345";

  const { receiverToken } = await createSignalingSession(testCode, 3600, storage);

  // 1. DELETE without token fails (401) and session remains active
  const noTokenRes = await closeSignalingSession(testCode, "", storage);
  assert.equal(noTokenRes.ok, false);
  assert.equal(noTokenRes.status, 401);
  const stillActive1 = await getSignalingSession(testCode, storage);
  assert.ok(stillActive1 !== null, "Session must not be deleted without token");

  // 2. DELETE with invalid token fails (403) and session remains active
  const badTokenRes = await closeSignalingSession(testCode, "invalid-token-1234", storage);
  assert.equal(badTokenRes.ok, false);
  assert.equal(badTokenRes.status, 403);
  const stillActive2 = await getSignalingSession(testCode, storage);
  assert.ok(stillActive2 !== null, "Session must not be deleted with invalid token");

  // 3. DELETE with correct receiverToken succeeds (200)
  const goodCloseRes = await closeSignalingSession(testCode, receiverToken, storage);
  assert.equal(goodCloseRes.ok, true);
  assert.equal(goodCloseRes.status, 200);
  const closedSession = await getSignalingSession(testCode, storage);
  assert.equal(closedSession, null, "Session must be purged after valid deletion");

  // 4. Repeated DELETE on closed session returns 404 (not reported as successful)
  const repeatCloseRes = await closeSignalingSession(testCode, receiverToken, storage);
  assert.equal(repeatCloseRes.ok, false);
  assert.equal(repeatCloseRes.status, 404);
});

// 9. Participant Authentication: prevents spoofing, competing senders, and unauthorized polling
test("Participant Authentication: validates tokens, blocks role spoofing, and rejects competing senders", async () => {
  const storage = createInMemoryTestNamespace();
  const testCode = "90123456";

  const { receiverToken } = await createSignalingSession(testCode, 3600, storage);
  const joinRes1 = await joinSignalingSession(testCode, undefined, storage);
  assert.equal(joinRes1.ok, true);
  const senderToken1 = joinRes1.senderToken!;

  // 1. Competing sender attempting to join active session is rejected (409)
  const joinRes2 = await joinSignalingSession(testCode, undefined, storage);
  assert.equal(joinRes2.ok, false);
  assert.equal(joinRes2.status, 409);

  // 2. Reconnecting sender with original token is accepted (200)
  const reconnectRes = await joinSignalingSession(testCode, senderToken1, storage);
  assert.equal(reconnectRes.ok, true);
  assert.equal(reconnectRes.senderToken, senderToken1);

  // 3. Attempting to post message with no token is rejected (401)
  const noTokenMsg = await postSignalMessage(testCode, "sender", "receiver", "ping", {}, "", storage);
  assert.equal(noTokenMsg.ok, false);
  assert.equal(noTokenMsg.status, 401);

  // 4. Attempting to spoof receiver role using senderToken is rejected (403)
  const spoofMsg = await postSignalMessage(testCode, "receiver", "sender", "answer", {}, senderToken1, storage);
  assert.equal(spoofMsg.ok, false);
  assert.equal(spoofMsg.status, 403);

  // 5. Attempting to poll receiver messages using senderToken is rejected (403)
  const spoofPoll = await pollSignalMessages(testCode, "receiver", 0, senderToken1, storage);
  assert.equal(spoofPoll.status, 403);
  assert.equal(spoofPoll.messages.length, 0);

  // 6. Legitimate message with genuine senderToken succeeds (200)
  const legitMsg = await postSignalMessage(testCode, "sender", "receiver", "offer", { sdp: "offer" }, senderToken1, storage);
  assert.equal(legitMsg.ok, true);

  // 7. Legitimate poll with genuine receiverToken succeeds (200)
  const legitPoll = await pollSignalMessages(testCode, "receiver", 0, receiverToken, storage);
  assert.equal(legitPoll.status, 200);
  assert.equal(legitPoll.messages.length, 1);
});

// 10. Cross-isolate rate limiter using Durable Object
test("Cross-Isolate Rate Limiter: enforces quotas and resets across isolates", async () => {
  const storage = createInMemoryTestNamespace();
  const testIp = "203.0.113.195";

  // Perform 3 allowed requests with limit of 3
  for (let i = 1; i <= 3; i++) {
    const res = await checkCrossIsolateRateLimit("test_action", testIp, 3, 1000, storage);
    assert.equal(res.allowed, true, `Request ${i} should be allowed`);
  }

  // 4th request must be throttled
  const blocked = await checkCrossIsolateRateLimit("test_action", testIp, 3, 1000, storage);
  assert.equal(blocked.allowed, false, "4th request must be throttled");
  assert.equal(blocked.remaining, 0);
});

// 11. Payload validation and TTL options
test("Validation: enforces supported TTL options and rejects malformed inputs", () => {
  for (const opt of EXPIRY_OPTIONS) {
    assert.ok(isValidTtl(opt.seconds), `Duration ${opt.label} (${opt.seconds}s) must be valid`);
  }

  assert.equal(isValidTtl(1), false);
  assert.equal(isValidTtl(9999), false);
  assert.equal(isValidTtl(-3600), false);
  assert.equal(isValidTtl("3600"), false);
  assert.equal(isValidTtl(null), false);
  assert.equal(isValidTtl(undefined), false);
});

// 12. OPFS Fallback: Bounded RAM buffer ceiling and verification
test("OPFS Fallback: enforces size ceiling on RAM buffer and verifies expected length", async () => {
  const testCode = "91234567";

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

  const sink = await createIncomingFileSink(
    testCode,
    "valid-file-id",
    "valid.txt",
    "text/plain",
    5,
  );

  const chunk = new TextEncoder().encode("Hello").buffer;
  await sink.write(chunk);
  const file = await sink.close();
  assert.equal(file.name, "valid.txt");
  assert.equal(file.size, 5);
});

// 13. OPFS Fallback: Byte length mismatch triggers verification error
test("OPFS Fallback: incomplete or truncated file triggers verification error", async () => {
  const sink = await createIncomingFileSink(
    "92345678",
    "trunc-file-id",
    "truncated.bin",
    "application/octet-stream",
    100,
  );

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
