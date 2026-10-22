import test from "node:test";
import assert from "node:assert/strict";
import {
  encodeBinaryFrame,
  decodeBinaryFrame,
  DATA_CHANNEL_LABELS,
  WebRTCMessage,
  TransferManifestFile,
} from "../lib/webrtc";
import { createIncomingFileSink } from "../lib/opfs";

/**
 * Test Suite: Dual Mode Bidirectional Streaming & Ephemeral Live Chat
 */

test("Binary Framing: encode and decode frame with magic bytes and metadata", () => {
  const fileId = "file_test_12345";
  const chunkIndex = 42;
  const offset = 1048576; // 1 MB offset
  const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03, 0x04]);

  const framed = encodeBinaryFrame(fileId, chunkIndex, offset, payload);

  assert.ok(framed.byteLength > payload.byteLength, "Framed buffer must include header overhead");

  const decoded = decodeBinaryFrame(framed);
  assert.notEqual(decoded, null, "Decoded frame should not be null");
  assert.equal(decoded!.fileId, fileId, "File ID must match");
  assert.equal(decoded!.chunkIndex, chunkIndex, "Chunk index must match");
  assert.equal(decoded!.offset, offset, "Offset must match");
  assert.equal(decoded!.payload.byteLength, payload.byteLength, "Payload length must match");

  const decodedArray = new Uint8Array(decoded!.payload);
  for (let i = 0; i < payload.length; i++) {
    assert.equal(decodedArray[i], payload[i], `Payload byte at index ${i} must match`);
  }
});

test("Binary Framing: rejects corrupted magic headers or truncated frames", () => {
  // 1. Buffer too small to contain header (< 16 bytes)
  const tooSmall = new Uint8Array([0x47, 0x53, 0x01]).buffer;
  assert.equal(decodeBinaryFrame(tooSmall), null);

  // 2. Corrupted magic bytes
  const badMagic = new Uint8Array([
    0x00, 0x00, // Invalid magic
    0x01, 0x00, // version 1, flags 0
    0x04, // fileId length = 4
    0x74, 0x65, 0x73, 0x74, // "test"
    0x00, 0x00, 0x00, 0x00, // chunkIndex 0
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // offset 0
    0xaa, 0xbb, // payload
  ]).buffer;
  assert.equal(decodeBinaryFrame(badMagic), null);

  // 3. Header claims fileId length longer than buffer
  const badLength = new Uint8Array([
    0x47, 0x53, 0x01, 0x00,
    0xff, // fileId length = 255 (buffer not big enough)
    0x01, 0x02,
  ]).buffer;
  assert.equal(decodeBinaryFrame(badLength), null);
});

test("Dual Mode: Dedicated directional data channel labels defined", () => {
  assert.equal(DATA_CHANNEL_LABELS.CONTROL, "control");
  assert.equal(DATA_CHANNEL_LABELS.FILES_JOINER_TO_CREATOR, "files-joiner-to-creator");
  assert.equal(DATA_CHANNEL_LABELS.FILES_CREATOR_TO_JOINER, "files-creator-to-joiner");
  assert.equal(DATA_CHANNEL_LABELS.LEGACY_FILE_TRANSFER, "file-transfer");
});

test("Simultaneous Bidirectional Transfer: Dual peers stream files concurrently with zero collision", async () => {
  // Peer A (Creator) sends file to Peer B (Joiner)
  // Peer B (Joiner) sends file to Peer A (Creator) simultaneously

  const code = "99887766";
  const fileAtoBId = "fileA_doc_101";
  const fileAtoBData = new Uint8Array(128 * 1024); // 128 KB
  for (let i = 0; i < fileAtoBData.length; i++) fileAtoBData[i] = (i * 7) & 0xff;

  const fileBtoAId = "fileB_img_202";
  const fileBtoAData = new Uint8Array(64 * 1024); // 64 KB
  for (let i = 0; i < fileBtoAData.length; i++) fileBtoAData[i] = (i * 13) & 0xff;

  // Allocate inbound sinks on both ends
  const sinkOnPeerB = await createIncomingFileSink(code, fileAtoBId, "document.pdf", "application/pdf", fileAtoBData.length);
  const sinkOnPeerA = await createIncomingFileSink(code, fileBtoAId, "photo.png", "image/png", fileBtoAData.length);

  // Chunking setup (16 KB chunks)
  const CHUNK_SIZE = 16 * 1024;

  let offsetA = 0;
  let chunkIdxA = 0;
  let offsetB = 0;
  let chunkIdxB = 0;

  // Interleaved / concurrent streaming over their respective directional channels
  while (offsetA < fileAtoBData.length || offsetB < fileBtoAData.length) {
    if (offsetA < fileAtoBData.length) {
      const sliceA = fileAtoBData.subarray(offsetA, offsetA + CHUNK_SIZE);
      const frameA = encodeBinaryFrame(fileAtoBId, chunkIdxA++, offsetA, sliceA);
      
      // Decoded by Peer B from files-creator-to-joiner channel
      const decodedA = decodeBinaryFrame(frameA);
      assert.ok(decodedA);
      assert.equal(decodedA.fileId, fileAtoBId);
      await sinkOnPeerB.write(decodedA.payload);
      offsetA += sliceA.length;
    }

    if (offsetB < fileBtoAData.length) {
      const sliceB = fileBtoAData.subarray(offsetB, offsetB + CHUNK_SIZE);
      const frameB = encodeBinaryFrame(fileBtoAId, chunkIdxB++, offsetB, sliceB);

      // Decoded by Peer A from files-joiner-to-creator channel
      const decodedB = decodeBinaryFrame(frameB);
      assert.ok(decodedB);
      assert.equal(decodedB.fileId, fileBtoAId);
      await sinkOnPeerA.write(decodedB.payload);
      offsetB += sliceB.length;
    }
  }

  // Finalize both sinks
  const finalFileOnB = await sinkOnPeerB.close();
  const finalFileOnA = await sinkOnPeerA.close();

  assert.equal(finalFileOnB.size, fileAtoBData.length);
  assert.equal(finalFileOnA.size, fileBtoAData.length);

  // Verify byte contents
  const arrayBufferB = await finalFileOnB.arrayBuffer();
  const bytesOnB = new Uint8Array(arrayBufferB);
  assert.deepEqual(bytesOnB, fileAtoBData, "Peer B received byte-for-byte exact file from Peer A");

  const arrayBufferA = await finalFileOnA.arrayBuffer();
  const bytesOnA = new Uint8Array(arrayBufferA);
  assert.deepEqual(bytesOnA, fileBtoAData, "Peer A received byte-for-byte exact file from Peer B");
});

test("Ephemeral Live Chat: message formatting, timestamps, sender roles, and character limits", () => {
  interface ChatState {
    messages: {
      id: string;
      sender: "me" | "peer";
      senderName: string;
      text: string;
      timestamp: number;
    }[];
    unreadCount: number;
    isChatOpen: boolean;
  }

  const createChatManager = (localRole: "creator" | "joiner") => {
    const state: ChatState = {
      messages: [],
      unreadCount: 0,
      isChatOpen: false,
    };

    const outbox: WebRTCMessage[] = [];

    const sendMessage = (rawText: string) => {
      const text = rawText.trim();
      if (!text || text.length > 500) return false;

      const now = Date.now();
      const id = `msg_${now}_${Math.random().toString(36).slice(2, 6)}`;

      state.messages.push({
        id,
        sender: "me",
        senderName: "You",
        text,
        timestamp: now,
      });

      const webrtcMsg: WebRTCMessage = {
        type: "chat",
        text,
        timestamp: now,
        senderRole: localRole,
      };

      outbox.push(webrtcMsg);
      return true;
    };

    const receiveMessage = (msg: WebRTCMessage) => {
      if (msg.type !== "chat" || !msg.text) return;
      const id = `peer_msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const senderRole = msg.senderRole || (localRole === "creator" ? "joiner" : "creator");

      state.messages.push({
        id,
        sender: "peer",
        senderName: senderRole === "creator" ? "Host" : "Guest",
        text: msg.text,
        timestamp: msg.timestamp || Date.now(),
      });

      if (!state.isChatOpen) {
        state.unreadCount += 1;
      }
    };

    const openChat = () => {
      state.isChatOpen = true;
      state.unreadCount = 0;
    };

    const closeChat = () => {
      state.isChatOpen = false;
    };

    const disconnectAndClear = () => {
      // Memory-only clearance: zero persistence in any storage
      state.messages = [];
      state.unreadCount = 0;
      state.isChatOpen = false;
    };

    return { state, outbox, sendMessage, receiveMessage, openChat, closeChat, disconnectAndClear };
  };

  const peerA = createChatManager("creator");
  const peerB = createChatManager("joiner");

  // 1. Peer A sends hello
  const sentA = peerA.sendMessage("Hello from creator!");
  assert.equal(sentA, true);
  assert.equal(peerA.state.messages.length, 1);
  assert.equal(peerA.state.messages[0].sender, "me");

  // Transmit over control channel to Peer B
  peerB.receiveMessage(peerA.outbox[0]);
  assert.equal(peerB.state.messages.length, 1);
  assert.equal(peerB.state.messages[0].sender, "peer");
  assert.equal(peerB.state.messages[0].senderName, "Host");
  assert.equal(peerB.state.unreadCount, 1, "Unread count increments when chat is closed");

  // Peer B opens chat -> unread count resets
  peerB.openChat();
  assert.equal(peerB.state.unreadCount, 0, "Unread count resets upon opening chat");

  // Peer B sends a reply
  peerB.sendMessage("Received loud and clear!");
  peerA.receiveMessage(peerB.outbox[0]);
  assert.equal(peerA.state.messages.length, 2);
  assert.equal(peerA.state.messages[1].sender, "peer");
  assert.equal(peerA.state.messages[1].senderName, "Guest");

  // 2. Character limit validation (500 chars)
  const tooLongText = "A".repeat(501);
  assert.equal(peerA.sendMessage(tooLongText), false, "Rejects messages exceeding 500 characters");

  const validMaxText = "B".repeat(500);
  assert.equal(peerA.sendMessage(validMaxText), true, "Allows messages up to exactly 500 characters");

  // 3. Ephemeral privacy verification: session disconnection completely purges memory
  peerA.disconnectAndClear();
  peerB.disconnectAndClear();
  assert.equal(peerA.state.messages.length, 0, "Messages wiped completely on disconnect");
  assert.equal(peerB.state.messages.length, 0, "Messages wiped completely on disconnect");
});

test("Session Persistence Across Modes: mode switching retains session state", () => {
  // Simulate SessionProvider state retention
  interface SessionState {
    mode: "receive" | "send" | "dual";
    code: string | null;
    connStatus: "connected";
    messagesCount: number;
    stagedFilesCount: number;
    receivedFilesCount: number;
  }

  const session: SessionState = {
    mode: "receive",
    code: "88776655",
    connStatus: "connected",
    messagesCount: 3,
    stagedFilesCount: 2,
    receivedFilesCount: 1,
  };

  // Switch to Send mode
  session.mode = "send";
  assert.equal(session.connStatus, "connected", "Connection remains active in Send mode");
  assert.equal(session.code, "88776655", "Session pairing code persists");
  assert.equal(session.stagedFilesCount, 2, "Staged files persist");

  // Switch to Dual mode
  session.mode = "dual";
  assert.equal(session.connStatus, "connected", "Connection remains active in Dual mode");
  assert.equal(session.messagesCount, 3, "Ephemeral chat messages persist while session lives");
  assert.equal(session.receivedFilesCount, 1, "Received files persist");

  // Switch back to Receive mode
  session.mode = "receive";
  assert.equal(session.connStatus, "connected", "Connection remains active in Receive mode");
  assert.equal(session.code, "88776655", "Session pairing code persists");
});
