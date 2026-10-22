import test from "node:test";
import assert from "node:assert/strict";

import {
  createSignalingSession,
  getSignalingSession,
  joinSignalingSession,
  postSignalMessage,
  pollSignalMessages,
  closeSignalingSession,
} from "../lib/signalStore";
import {
  DEFAULT_ICE_SERVERS,
  CHUNK_SIZE,
  MAX_BUFFERED_AMOUNT,
  WebRTCMessage,
} from "../lib/webrtc";

test("WebRTC Constants: CHUNK_SIZE and backpressure thresholds adhere to safe SCTP limits", () => {
  assert.equal(CHUNK_SIZE, 32 * 1024, "Chunk size must be 32 KB for safe SCTP MTU traversal");
  assert.equal(MAX_BUFFERED_AMOUNT, 256 * 1024, "High water mark must be 256 KB");
  assert.ok(DEFAULT_ICE_SERVERS.length >= 2, "Must configure multiple public STUN servers");
  assert.ok(
    DEFAULT_ICE_SERVERS.some((s) => typeof s.urls === "string" && s.urls.includes("stun")),
    "ICE servers must include STUN protocol endpoints",
  );
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
});

test("Signaling Store: session lifecycle, joining, posting, and role-filtered polling", () => {
  const testCode = "99887766";
  closeSignalingSession(testCode);

  // 1. Create session
  const session = createSignalingSession(testCode);
  assert.equal(session.code, testCode);
  assert.equal(session.receiverActive, true);
  assert.equal(session.senderActive, false);
  assert.ok(session.expiresAt > Date.now());

  // 2. Fetch active session
  const fetched = getSignalingSession(testCode);
  assert.ok(fetched !== null);
  assert.equal(fetched.code, testCode);

  // 3. Sender joins
  const joined = joinSignalingSession(testCode);
  assert.equal(joined, true);
  assert.equal(getSignalingSession(testCode)?.senderActive, true);

  // 4. Post signaling message from Sender to Receiver (e.g. SDP offer)
  const posted = postSignalMessage(testCode, "sender", "receiver", "offer", {
    type: "offer",
    sdp: "v=0\r\no=...",
  });
  assert.equal(posted, true);

  // 5. Receiver polls and receives the offer
  const receiverMsgs = pollSignalMessages(testCode, "receiver", 0);
  assert.equal(receiverMsgs.length, 1);
  assert.equal(receiverMsgs[0].type, "offer");
  assert.equal(receiverMsgs[0].sender, "sender");
  assert.equal(receiverMsgs[0].target, "receiver");

  // 6. Sender polls for messages targeted to sender (should be empty so far)
  const senderMsgs = pollSignalMessages(testCode, "sender", 0);
  assert.equal(senderMsgs.length, 0);

  // 7. Receiver posts answer back to sender
  postSignalMessage(testCode, "receiver", "sender", "answer", {
    type: "answer",
    sdp: "v=0\r\no=...",
  });
  const senderMsgsAfterAnswer = pollSignalMessages(testCode, "sender", 0);
  assert.equal(senderMsgsAfterAnswer.length, 1);
  assert.equal(senderMsgsAfterAnswer[0].type, "answer");

  // 8. Polling with timestamp filters out older messages
  const since = receiverMsgs[0].timestamp;
  const noNewMsgs = pollSignalMessages(testCode, "receiver", since);
  assert.equal(noNewMsgs.length, 0);

  // 9. Close session
  closeSignalingSession(testCode);
  assert.equal(getSignalingSession(testCode), null);
});
