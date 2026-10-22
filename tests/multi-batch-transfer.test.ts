import test from "node:test";
import assert from "node:assert/strict";

import {
  WebRTCMessage,
  TransferManifestFile,
} from "../lib/webrtc";
import { createIncomingFileSink } from "../lib/opfs";

interface MockStagedItem {
  id: string;
  name: string;
  size: number;
  type: string;
  status: "idle" | "requesting" | "uploading" | "done" | "error";
  progress: number;
  error?: string;
}

interface MockReceivedItem {
  id: string;
  name: string;
  size: number;
  receivedAt: number;
  data: Uint8Array;
}

/**
 * Simulates the sender-side multi-batch transfer state machine as implemented in SendPanel.tsx.
 */
class MockSenderStateMachine {
  stagedFiles: MockStagedItem[] = [];
  transferPhase: "idle" | "awaiting-approval" | "transferring" | "done" = "idle";
  currentBatchId: string | null = null;
  outgoingMessages: WebRTCMessage[] = [];

  stageFiles(files: { name: string; size: number; type?: string }[]) {
    for (const f of files) {
      const id = `file_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      this.stagedFiles.push({
        id,
        name: f.name,
        size: f.size,
        type: f.type || "application/octet-stream",
        status: "idle",
        progress: 0,
      });
    }
    // As in SendPanel: if transferPhase is "done", adding new files resets phase to "idle"
    if (this.transferPhase === "done") {
      this.transferPhase = "idle";
    }
  }

  canInitiateTransfer(): boolean {
    const idleCount = this.stagedFiles.filter((f) => f.status === "idle").length;
    const isBusy = this.transferPhase === "awaiting-approval" || this.transferPhase === "transferring";
    return idleCount > 0 && !isBusy;
  }

  triggerTransferRequest(): { batchId: string; manifest: TransferManifestFile[] } {
    if (!this.canInitiateTransfer()) {
      throw new Error("Cannot initiate transfer: no idle files or transfer in progress");
    }

    const pending = this.stagedFiles.filter((f) => f.status === "idle");
    const batchId = `batch_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    this.currentBatchId = batchId;
    this.transferPhase = "awaiting-approval";

    const pendingIds = new Set(pending.map((f) => f.id));
    this.stagedFiles = this.stagedFiles.map((f) =>
      pendingIds.has(f.id) ? { ...f, status: "requesting" } : f,
    );

    const manifest: TransferManifestFile[] = pending.map((f) => ({
      id: f.id,
      name: f.name,
      size: f.size,
      type: f.type,
    }));

    const msg: WebRTCMessage = {
      type: "transfer-request",
      batchId,
      files: manifest,
    };
    this.outgoingMessages.push(msg);
    return { batchId, manifest };
  }

  handlePeerMessage(msg: WebRTCMessage) {
    if (msg.type === "transfer-accept") {
      if (msg.batchId && this.currentBatchId && msg.batchId !== this.currentBatchId) {
        return; // Ignore mismatched batch
      }
      this.transferPhase = "transferring";
    } else if (msg.type === "transfer-decline") {
      if (msg.batchId && this.currentBatchId && msg.batchId !== this.currentBatchId) {
        return; // Ignore mismatched batch
      }
      this.transferPhase = "idle";
      this.stagedFiles = this.stagedFiles.map((f) =>
        f.status === "requesting" ? { ...f, status: "idle" } : f,
      );
      this.currentBatchId = null;
    }
  }

  simulateStreamCompletion() {
    if (this.transferPhase !== "transferring") {
      throw new Error("Cannot complete stream: not in transferring phase");
    }
    // Mark requesting files as done
    this.stagedFiles = this.stagedFiles.map((f) =>
      f.status === "requesting" ? { ...f, status: "done", progress: 100 } : f,
    );

    const completedBatchId = this.currentBatchId;
    this.outgoingMessages.push({
      type: "transfer-complete",
      batchId: completedBatchId ?? undefined,
    });

    const hasRemainingIdle = this.stagedFiles.some((f) => f.status === "idle");
    this.transferPhase = hasRemainingIdle ? "idle" : "done";
    this.currentBatchId = null;
  }
}

/**
 * Simulates the receiver-side multi-batch transfer state machine as implemented in ReceivePanel.tsx.
 */
class MockReceiverStateMachine {
  pendingApproval: { batchId?: string; files: TransferManifestFile[] } | null = null;
  receivedFiles: MockReceivedItem[] = [];
  activeReceiving: { id: string; name: string; size: number } | null = null;
  outgoingMessages: WebRTCMessage[] = [];

  handlePeerMessage(msg: WebRTCMessage) {
    if (msg.type === "transfer-request") {
      this.pendingApproval = {
        batchId: msg.batchId,
        files: msg.files,
      };
    } else if (msg.type === "file-start") {
      this.activeReceiving = {
        id: msg.id,
        name: msg.name,
        size: msg.size,
      };
      this.outgoingMessages.push({ type: "file-ready", id: msg.id });
    } else if (msg.type === "file-end") {
      if (this.activeReceiving && this.activeReceiving.id === msg.id) {
        const item: MockReceivedItem = {
          id: this.activeReceiving.id,
          name: this.activeReceiving.name,
          size: this.activeReceiving.size,
          receivedAt: Date.now(),
          data: new Uint8Array(this.activeReceiving.size),
        };
        // Preserves existing files, appends/replaces this specific file id
        this.receivedFiles = [...this.receivedFiles.filter((f) => f.id !== item.id), item];
        this.activeReceiving = null;
        this.outgoingMessages.push({ type: "file-ack", id: msg.id });
      }
    } else if (msg.type === "transfer-complete") {
      this.activeReceiving = null;
      this.pendingApproval = null;
    }
  }

  acceptTransfer() {
    if (!this.pendingApproval) return;
    const batchId = this.pendingApproval.batchId;
    this.outgoingMessages.push({
      type: "transfer-accept",
      batchId,
    });
    this.pendingApproval = null;
  }

  declineTransfer(reason = "Declined by recipient") {
    if (!this.pendingApproval) return;
    const batchId = this.pendingApproval.batchId;
    this.outgoingMessages.push({
      type: "transfer-decline",
      batchId,
      reason,
    });
    this.pendingApproval = null;
  }
}

test("Scenario A: Single file per batch across repeated sequential transfers", () => {
  const sender = new MockSenderStateMachine();
  const receiver = new MockReceiverStateMachine();

  // Batch 1: Stage 1 file
  sender.stageFiles([{ name: "alpha.txt", size: 100 }]);
  assert.equal(sender.stagedFiles.length, 1);
  assert.equal(sender.canInitiateTransfer(), true);

  // Trigger Batch 1
  const b1 = sender.triggerTransferRequest();
  assert.equal(b1.manifest.length, 1);
  assert.equal(b1.manifest[0].name, "alpha.txt");
  assert.ok(b1.batchId);

  // Deliver to receiver
  const req1 = sender.outgoingMessages.pop()!;
  receiver.handlePeerMessage(req1);
  assert.ok(receiver.pendingApproval);
  assert.equal(receiver.pendingApproval?.files.length, 1);
  assert.equal(receiver.pendingApproval?.batchId, b1.batchId);

  // Receiver accepts
  receiver.acceptTransfer();
  const acc1 = receiver.outgoingMessages.pop()!;
  sender.handlePeerMessage(acc1);
  assert.equal(sender.transferPhase, "transferring");

  // Stream file 1
  receiver.handlePeerMessage({
    type: "file-start",
    id: b1.manifest[0].id,
    name: "alpha.txt",
    size: 100,
    mimeType: "text/plain",
  });
  receiver.handlePeerMessage({ type: "file-end", id: b1.manifest[0].id });
  sender.simulateStreamCompletion();

  const comp1 = sender.outgoingMessages.pop()!;
  receiver.handlePeerMessage(comp1);

  assert.equal(sender.transferPhase, "done");
  assert.equal(receiver.receivedFiles.length, 1);
  assert.equal(receiver.receivedFiles[0].name, "alpha.txt");

  // Batch 2: Stage another single file
  sender.stageFiles([{ name: "beta.jpg", size: 500 }]);
  // Ensure transferPhase resets to idle and transfer is enabled
  assert.equal(sender.transferPhase, "idle");
  assert.equal(sender.canInitiateTransfer(), true);

  // Trigger Batch 2: Manifest MUST only contain the NEW file, not alpha.txt
  const b2 = sender.triggerTransferRequest();
  assert.equal(b2.manifest.length, 1);
  assert.equal(b2.manifest[0].name, "beta.jpg");
  assert.notEqual(b2.batchId, b1.batchId);

  // Receiver gets Batch 2 approval
  const req2 = sender.outgoingMessages.pop()!;
  receiver.handlePeerMessage(req2);
  assert.ok(receiver.pendingApproval);
  assert.equal(receiver.pendingApproval?.files.length, 1);
  assert.equal(receiver.pendingApproval?.files[0].name, "beta.jpg");

  // Receiver accepts Batch 2
  receiver.acceptTransfer();
  const acc2 = receiver.outgoingMessages.pop()!;
  sender.handlePeerMessage(acc2);
  assert.equal(sender.transferPhase, "transferring");

  // Stream file 2
  receiver.handlePeerMessage({
    type: "file-start",
    id: b2.manifest[0].id,
    name: "beta.jpg",
    size: 500,
    mimeType: "image/jpeg",
  });
  receiver.handlePeerMessage({ type: "file-end", id: b2.manifest[0].id });
  sender.simulateStreamCompletion();

  const comp2 = sender.outgoingMessages.pop()!;
  receiver.handlePeerMessage(comp2);

  // Verify: Receiver has retained BOTH files across batches
  assert.equal(receiver.receivedFiles.length, 2);
  assert.equal(receiver.receivedFiles[0].name, "alpha.txt");
  assert.equal(receiver.receivedFiles[1].name, "beta.jpg");
  assert.equal(sender.transferPhase, "done");
});

test("Scenario B: Multiple files per batch with full verification", () => {
  const sender = new MockSenderStateMachine();
  const receiver = new MockReceiverStateMachine();

  // Batch 1: 3 files
  sender.stageFiles([
    { name: "f1.pdf", size: 1000 },
    { name: "f2.pdf", size: 2000 },
    { name: "f3.pdf", size: 3000 },
  ]);
  const b1 = sender.triggerTransferRequest();
  assert.equal(b1.manifest.length, 3);

  receiver.handlePeerMessage(sender.outgoingMessages.pop()!);
  receiver.acceptTransfer();
  sender.handlePeerMessage(receiver.outgoingMessages.pop()!);

  for (const f of b1.manifest) {
    receiver.handlePeerMessage({
      type: "file-start",
      id: f.id,
      name: f.name,
      size: f.size,
      mimeType: "application/pdf",
    });
    receiver.handlePeerMessage({ type: "file-end", id: f.id });
  }
  sender.simulateStreamCompletion();
  receiver.handlePeerMessage(sender.outgoingMessages.pop()!);

  assert.equal(receiver.receivedFiles.length, 3);

  // Batch 2: 2 files
  sender.stageFiles([
    { name: "f4.png", size: 4000 },
    { name: "f5.png", size: 5000 },
  ]);
  const b2 = sender.triggerTransferRequest();
  assert.equal(b2.manifest.length, 2);
  assert.deepEqual(
    b2.manifest.map((m) => m.name),
    ["f4.png", "f5.png"],
  );

  receiver.handlePeerMessage(sender.outgoingMessages.pop()!);
  receiver.acceptTransfer();
  sender.handlePeerMessage(receiver.outgoingMessages.pop()!);

  for (const f of b2.manifest) {
    receiver.handlePeerMessage({
      type: "file-start",
      id: f.id,
      name: f.name,
      size: f.size,
      mimeType: "image/png",
    });
    receiver.handlePeerMessage({ type: "file-end", id: f.id });
  }
  sender.simulateStreamCompletion();
  receiver.handlePeerMessage(sender.outgoingMessages.pop()!);

  assert.equal(receiver.receivedFiles.length, 5);
});

test("Scenario C: Repeated sequential batches (3+ batches in one active session)", () => {
  const sender = new MockSenderStateMachine();
  const receiver = new MockReceiverStateMachine();

  for (let batchNum = 1; batchNum <= 4; batchNum++) {
    const filename = `document_batch_${batchNum}.txt`;
    sender.stageFiles([{ name: filename, size: 256 * batchNum }]);

    assert.equal(sender.canInitiateTransfer(), true);
    const b = sender.triggerTransferRequest();
    assert.equal(b.manifest.length, 1);
    assert.equal(b.manifest[0].name, filename);

    receiver.handlePeerMessage(sender.outgoingMessages.pop()!);
    assert.ok(receiver.pendingApproval);
    assert.equal(receiver.pendingApproval.batchId, b.batchId);

    receiver.acceptTransfer();
    sender.handlePeerMessage(receiver.outgoingMessages.pop()!);
    assert.equal(sender.transferPhase, "transferring");

    receiver.handlePeerMessage({
      type: "file-start",
      id: b.manifest[0].id,
      name: filename,
      size: 256 * batchNum,
      mimeType: "text/plain",
    });
    receiver.handlePeerMessage({ type: "file-end", id: b.manifest[0].id });
    sender.simulateStreamCompletion();
    receiver.handlePeerMessage(sender.outgoingMessages.pop()!);

    assert.equal(receiver.receivedFiles.length, batchNum);
    assert.equal(sender.transferPhase, "done");
  }

  assert.equal(receiver.receivedFiles.length, 4);
});

test("Scenario D: Receiver declines batch; sender recovers and successfully retries", () => {
  const sender = new MockSenderStateMachine();
  const receiver = new MockReceiverStateMachine();

  sender.stageFiles([{ name: "sensitive.docx", size: 8192 }]);
  const b1 = sender.triggerTransferRequest();
  assert.equal(sender.transferPhase, "awaiting-approval");

  receiver.handlePeerMessage(sender.outgoingMessages.pop()!);
  assert.ok(receiver.pendingApproval);

  // Receiver declines
  receiver.declineTransfer("Not ready for transfer");
  const declineMsg = receiver.outgoingMessages.pop()!;
  assert.equal(declineMsg.type, "transfer-decline");

  sender.handlePeerMessage(declineMsg);
  // Sender should return to idle phase and restore requesting files to idle
  assert.equal(sender.transferPhase, "idle");
  assert.equal(sender.stagedFiles[0].status, "idle");
  assert.equal(sender.canInitiateTransfer(), true);

  // Sender can retry the transfer
  const b1Retry = sender.triggerTransferRequest();
  assert.notEqual(b1Retry.batchId, b1.batchId);
  assert.equal(b1Retry.manifest.length, 1);

  receiver.handlePeerMessage(sender.outgoingMessages.pop()!);
  receiver.acceptTransfer();
  sender.handlePeerMessage(receiver.outgoingMessages.pop()!);
  assert.equal(sender.transferPhase, "transferring");

  receiver.handlePeerMessage({
    type: "file-start",
    id: b1Retry.manifest[0].id,
    name: "sensitive.docx",
    size: 8192,
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
  receiver.handlePeerMessage({ type: "file-end", id: b1Retry.manifest[0].id });
  sender.simulateStreamCompletion();
  receiver.handlePeerMessage(sender.outgoingMessages.pop()!);

  assert.equal(receiver.receivedFiles.length, 1);
  assert.equal(receiver.receivedFiles[0].name, "sensitive.docx");
});

test("Scenario E: Duplicate filenames across batches persist with unique identifiers", async () => {
  const sender = new MockSenderStateMachine();
  const receiver = new MockReceiverStateMachine();

  // Batch 1: report.pdf (100 bytes)
  sender.stageFiles([{ name: "report.pdf", size: 100 }]);
  const b1 = sender.triggerTransferRequest();
  receiver.handlePeerMessage(sender.outgoingMessages.pop()!);
  receiver.acceptTransfer();
  sender.handlePeerMessage(receiver.outgoingMessages.pop()!);

  receiver.handlePeerMessage({
    type: "file-start",
    id: b1.manifest[0].id,
    name: "report.pdf",
    size: 100,
    mimeType: "application/pdf",
  });
  receiver.handlePeerMessage({ type: "file-end", id: b1.manifest[0].id });
  sender.simulateStreamCompletion();
  receiver.handlePeerMessage(sender.outgoingMessages.pop()!);

  // Batch 2: identical filename "report.pdf" with different size (200 bytes)
  sender.stageFiles([{ name: "report.pdf", size: 200 }]);
  const b2 = sender.triggerTransferRequest();
  receiver.handlePeerMessage(sender.outgoingMessages.pop()!);
  receiver.acceptTransfer();
  sender.handlePeerMessage(receiver.outgoingMessages.pop()!);

  receiver.handlePeerMessage({
    type: "file-start",
    id: b2.manifest[0].id,
    name: "report.pdf",
    size: 200,
    mimeType: "application/pdf",
  });
  receiver.handlePeerMessage({ type: "file-end", id: b2.manifest[0].id });
  sender.simulateStreamCompletion();
  receiver.handlePeerMessage(sender.outgoingMessages.pop()!);

  // Verify: both files are preserved in receivedFiles list with distinct IDs and sizes
  assert.equal(receiver.receivedFiles.length, 2);
  assert.equal(receiver.receivedFiles[0].name, "report.pdf");
  assert.equal(receiver.receivedFiles[0].size, 100);
  assert.equal(receiver.receivedFiles[1].name, "report.pdf");
  assert.equal(receiver.receivedFiles[1].size, 200);
  assert.notEqual(receiver.receivedFiles[0].id, receiver.receivedFiles[1].id);

  // Verify storage sink isolation for duplicate names
  const sink1 = await createIncomingFileSink("session-1", b1.manifest[0].id, "report.pdf", "application/pdf", 100);
  await sink1.write(new Uint8Array(100).buffer);
  const file1 = await sink1.close();
  assert.equal(file1.size, 100);

  const sink2 = await createIncomingFileSink("session-1", b2.manifest[0].id, "report.pdf", "application/pdf", 200);
  await sink2.write(new Uint8Array(200).buffer);
  const file2 = await sink2.close();
  assert.equal(file2.size, 200);
});

test("Scenario F: Staging new files while active transfer is in progress does not alter in-flight batch", () => {
  const sender = new MockSenderStateMachine();
  const receiver = new MockReceiverStateMachine();

  // Batch 1 staged
  sender.stageFiles([{ name: "first.txt", size: 50 }]);
  const b1 = sender.triggerTransferRequest();
  receiver.handlePeerMessage(sender.outgoingMessages.pop()!);
  receiver.acceptTransfer();
  sender.handlePeerMessage(receiver.outgoingMessages.pop()!);
  assert.equal(sender.transferPhase, "transferring");

  // User adds another file while transferring
  sender.stageFiles([{ name: "second.txt", size: 75 }]);
  // The transfer phase MUST remain 'transferring', not prematurely reset to idle
  assert.equal(sender.transferPhase, "transferring");
  // Total staged items is 2, but only the first is 'requesting', the second is 'idle'
  const requestingItems = sender.stagedFiles.filter((f) => f.status === "requesting");
  const idleItems = sender.stagedFiles.filter((f) => f.status === "idle");
  assert.equal(requestingItems.length, 1);
  assert.equal(idleItems.length, 1);
  assert.equal(idleItems[0].name, "second.txt");

  // Stream batch 1 completes
  sender.simulateStreamCompletion();
  // Because 'second.txt' was already idle in the queue, sender immediately transitions to 'idle'
  assert.equal(sender.transferPhase, "idle");
  assert.equal(sender.canInitiateTransfer(), true);

  // Now initiate batch 2
  const b2 = sender.triggerTransferRequest();
  assert.equal(b2.manifest.length, 1);
  assert.equal(b2.manifest[0].name, "second.txt");
});
