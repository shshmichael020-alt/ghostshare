import test from "node:test";
import assert from "node:assert/strict";

import {
  sessionUsedBytes,
  remainingSecondsFromSession,
  type Session,
  type StoredFile,
} from "../lib/kv";
import { MAX_TRANSFER_BYTES } from "../lib/constants";

test("Session KV: sessionUsedBytes accurately sums multi-file batch sizes", () => {
  const emptySession: Session = {
    code: "11223344",
    createdAt: Date.now(),
    expiresAt: Date.now() + 3600_000,
    files: [],
  };
  assert.equal(sessionUsedBytes(emptySession), 0);

  const file1: StoredFile = {
    objectKey: "11223344/file1.png",
    downloadUrl: "https://r2.example.com/1",
    name: "file1.png",
    size: 15 * 1024 * 1024, // 15 MB
    uploadedAt: Date.now(),
  };

  const file2: StoredFile = {
    objectKey: "11223344/file2.zip",
    downloadUrl: "https://r2.example.com/2",
    name: "file2.zip",
    size: 85 * 1024 * 1024, // 85 MB
    uploadedAt: Date.now(),
  };

  const sessionWithFiles: Session = {
    ...emptySession,
    files: [file1, file2],
  };

  const used = sessionUsedBytes(sessionWithFiles);
  assert.equal(used, 100 * 1024 * 1024);
  assert.equal(MAX_TRANSFER_BYTES - used, 150 * 1024 * 1024);
});

test("Session KV: remainingSecondsFromSession clamps gracefully and handles expiry", () => {
  const now = Date.now();

  const futureSession: Session = {
    code: "55667788",
    createdAt: now,
    expiresAt: now + 3600 * 1000,
    files: [],
  };

  const rem = remainingSecondsFromSession(futureSession);
  assert.ok(rem >= 3598 && rem <= 3600);

  const expiredSession: Session = {
    code: "55667788",
    createdAt: now - 7200 * 1000,
    expiresAt: now - 3600 * 1000,
    files: [],
  };

  const expiredRem = remainingSecondsFromSession(expiredSession);
  assert.equal(expiredRem, 0, "Expired session remaining seconds must clamp to 0");
});
