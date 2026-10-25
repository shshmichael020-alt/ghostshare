import test from "node:test";
import assert from "node:assert/strict";

import {
  createSignalingSession,
  getSignalingSession,
  joinSignalingSession,
  postSignalMessage,
  pollSignalMessages,
  closeSignalingSession,
  updateSessionTtl,
  DEFAULT_SESSION_TTL_SECONDS,
  setTestStorageNamespace,
  createInMemoryTestNamespace,
} from "../lib/signalStore";
import {
  DEFAULT_ICE_SERVERS,
  CHUNK_SIZE,
  MAX_BUFFERED_AMOUNT,
  WebRTCMessage,
  isValidIceCandidateInit,
} from "../lib/webrtc";

test("WebRTC Constants: CHUNK_SIZE and backpressure thresholds adhere to safe SCTP limits", () => {
  assert.equal(CHUNK_SIZE, 32 * 1024, "Chunk size must be 32 KB for safe SCTP MTU traversal");
  assert.equal(MAX_BUFFERED_AMOUNT, 256 * 1024, "High water mark must be 256 KB");
  assert.ok(DEFAULT_ICE_SERVERS.length >= 2, "Must configure multiple public STUN and TURN servers");
  assert.ok(
    DEFAULT_ICE_SERVERS.some((s) => typeof s.urls === "string" && s.urls.includes("stun")),
    "ICE servers must include STUN protocol endpoints",
  );
  assert.ok(
    DEFAULT_ICE_SERVERS.some((s) => Array.isArray(s.urls) && s.urls.some((u) => u.includes("turn"))),
    "ICE servers must include TURN relay endpoints for mobile CGNAT traversal",
  );
});

test("ICE Candidate Validation: filters out empty candidates, nulls, and end-of-candidate indicators", () => {
  assert.equal(isValidIceCandidateInit({ candidate: "candidate:1 1 UDP 2130706431 192.168.1.1 50000 typ host" }), true);
  assert.equal(isValidIceCandidateInit({ candidate: "" }), false, "Empty string candidate must be rejected");
  assert.equal(isValidIceCandidateInit({ candidate: "   " }), false, "Whitespace-only candidate must be rejected");
  assert.equal(isValidIceCandidateInit(null), false, "Null candidate must be rejected");
  assert.equal(isValidIceCandidateInit(undefined), false, "Undefined candidate must be rejected");
  assert.equal(isValidIceCandidateInit({}), false, "Empty candidate object must be rejected");
  assert.equal(isValidIceCandidateInit({ candidate: 12345 }), false, "Non-string candidate must be rejected");
});

test("WebRTC Protocol: serializes and parses control messages cleanly", () => {
  const requestMsg: WebRTCMessage = {
    type: "transfer-request",
    files: [
      { id: "f-1", name: "test.png", size: 1024, type: "image/png" },
      { id: "f-2", name: "doc.pdf", size: 2048, type: "application/pdf" },
    ],
  };

  const serialized = JSON.stringify(requestMsg);
  const parsed = JSON.parse(serialized) as WebRTCMessage;
  assert.equal(parsed.type, "transfer-request");
  if (parsed.type === "transfer-request") {
    assert.equal(parsed.files.length, 2);
    assert.equal(parsed.files[0].name, "test.png");
  }

  const acceptMsg: WebRTCMessage = { type: "transfer-accept" };
  assert.equal(JSON.parse(JSON.stringify(acceptMsg)).type, "transfer-accept");

  const declineMsg: WebRTCMessage = { type: "transfer-decline", reason: "Declined by recipient" };
  assert.equal(JSON.parse(JSON.stringify(declineMsg)).reason, "Declined by recipient");

  const resumeQueryMsg: WebRTCMessage = { type: "resume-query", id: "f-1" };
  assert.equal(JSON.parse(JSON.stringify(resumeQueryMsg)).type, "resume-query");

  const resumeAckMsg: WebRTCMessage = { type: "resume-ack", id: "f-1", receivedBytes: 1048576 };
  const parsedAck = JSON.parse(JSON.stringify(resumeAckMsg)) as WebRTCMessage;
  if (parsedAck.type === "resume-ack") {
    assert.equal(parsedAck.receivedBytes, 1048576);
  }
});

test("Signaling Store: session lifecycle, joining, posting, and role-filtered polling", async () => {
  setTestStorageNamespace(createInMemoryTestNamespace());
  const testCode = "99887766";

  // 1. Create session with 1-hour (3600s) default TTL and receive receiver capability token
  const { session, receiverToken } = await createSignalingSession(testCode);
  assert.equal(session.code, testCode);
  assert.equal(DEFAULT_SESSION_TTL_SECONDS, 3600, "Default TTL must be 1 hour");
  assert.equal(session.receiverActive, true);
  assert.equal(session.senderActive, false);
  assert.ok(typeof receiverToken === "string" && receiverToken.length >= 16);
  const remainingSeconds = Math.round((session.expiresAt - session.createdAt) / 1000);
  assert.equal(remainingSeconds, 3600, "Initial TTL must be 3600 seconds (1 hour)");

  // 1b. Update session TTL to 2 hours (7200s) with valid receiver token
  const updatedTtl = await updateSessionTtl(testCode, 7200, receiverToken);
  assert.equal(updatedTtl.ok, true);
  const updatedSession = await getSignalingSession(testCode);
  const updatedRemaining = Math.round((updatedSession!.expiresAt - updatedSession!.createdAt) / 1000);
  assert.equal(updatedRemaining, 7200, "Updated TTL must be 7200 seconds (2 hours)");

  // 2. Fetch active session
  const fetched = await getSignalingSession(testCode);
  assert.ok(fetched !== null);
  assert.equal(fetched.code, testCode);

  // 3. Sender joins and receives dedicated sender capability token
  const joinResult = await joinSignalingSession(testCode);
  assert.equal(joinResult.ok, true);
  const senderToken = joinResult.senderToken!;
  assert.ok(typeof senderToken === "string" && senderToken.length >= 16);
  const afterJoin = await getSignalingSession(testCode);
  assert.equal(afterJoin?.senderActive, true);

  // 4. Post signaling message from Sender to Receiver (e.g. SDP offer) authenticated by senderToken
  const postResult = await postSignalMessage(
    testCode,
    "sender",
    "receiver",
    "offer",
    {
      type: "offer",
      sdp: "v=0\r\no=...",
    },
    senderToken,
  );
  assert.equal(postResult.ok, true);

  // 5. Receiver polls and receives the offer authenticated by receiverToken
  const receiverPoll = await pollSignalMessages(testCode, "receiver", 0, receiverToken);
  assert.equal(receiverPoll.messages.length, 1);
  assert.equal(receiverPoll.messages[0].type, "offer");
  assert.equal(receiverPoll.messages[0].sender, "sender");
  assert.equal(receiverPoll.messages[0].target, "receiver");
  const offerSeq = receiverPoll.cursor;

  // 6. Sender polls for messages targeted to sender (should be empty so far)
  const senderPoll = await pollSignalMessages(testCode, "sender", 0, senderToken);
  assert.equal(senderPoll.messages.length, 0);

  // 7. Receiver posts answer back to sender authenticated by receiverToken
  const answerPost = await postSignalMessage(
    testCode,
    "receiver",
    "sender",
    "answer",
    {
      type: "answer",
      sdp: "v=0\r\no=...",
    },
    receiverToken,
  );
  assert.equal(answerPost.ok, true);

  const senderPollAfterAnswer = await pollSignalMessages(testCode, "sender", 0, senderToken);
  assert.equal(senderPollAfterAnswer.messages.length, 1);
  assert.equal(senderPollAfterAnswer.messages[0].type, "answer");

  // 8. Polling with sequence cursor filters out older messages
  const noNewMsgs = await pollSignalMessages(testCode, "receiver", offerSeq, receiverToken);
  assert.equal(noNewMsgs.messages.length, 0);

  // 9. Close session with receiverToken
  const closeRes = await closeSignalingSession(testCode, receiverToken);
  assert.equal(closeRes.ok, true);
  assert.equal(await getSignalingSession(testCode), null);
});
