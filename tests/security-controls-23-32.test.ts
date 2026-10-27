import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { POST as handlePostMessage } from "../app/api/signal/message/route";
import { POST as handleCreateSession } from "../app/api/signal/session/route";
import {
  POST as handleJoinSession,
  PATCH as handlePatchSession,
  DELETE as handleDeleteSession,
} from "../app/api/signal/session/[code]/route";
import { cleanupSessionStorage } from "../lib/opfs";
import { sanitizeFileName, sanitizeMimeType } from "../lib/webrtc";

test("Security Control 24: CI/CD workflow least-privilege permissions", () => {
  const ciPath = path.join(process.cwd(), ".github", "workflows", "ci.yml");
  assert.ok(fs.existsSync(ciPath), "CI workflow file .github/workflows/ci.yml must exist");

  const ciContent = fs.readFileSync(ciPath, "utf-8");
  assert.ok(
    ciContent.includes("contents: read"),
    "CI workflow must enforce least-privilege permissions (contents: read)",
  );
  assert.ok(
    ciContent.includes("npm ci"),
    "CI workflow must use npm ci for reproducible clean installs",
  );
  assert.ok(
    ciContent.includes("npm test"),
    "CI workflow must execute automated test suite",
  );
  assert.ok(
    ciContent.includes("npm run cf:build"),
    "CI workflow must verify Cloudflare OpenNext production build",
  );
});

test("Security Control 25: Signaling message endpoint rejects oversized payload (>64 KB)", async () => {
  const oversizedData = "X".repeat(70 * 1024); // 70 KB payload
  const req = new Request("http://localhost:3000/api/signal/message", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "http://localhost:3000",
    },
    body: JSON.stringify({
      code: "12345678",
      sender: "sender",
      target: "receiver",
      type: "offer",
      data: oversizedData,
      token: "test_token",
    }),
  });

  const res = await handlePostMessage(req);
  assert.equal(res.status, 413, "Oversized signaling payload must be rejected with HTTP 413");
  const data = (await res.json()) as { error: string };
  assert.ok(
    data.error.includes("maximum allowed signaling size"),
    "Error message must specify signaling payload limit",
  );
});

test("Security Control 25: Session creation endpoint rejects oversized payload (>8 KB)", async () => {
  const oversizedData = "A".repeat(10 * 1024); // 10 KB payload
  const req = new Request("http://localhost:3000/api/signal/session", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "http://localhost:3000",
    },
    body: JSON.stringify({
      ttlSeconds: 600,
      junk: oversizedData,
    }),
  });

  const res = await handleCreateSession(req);
  assert.equal(res.status, 413, "Oversized session creation payload must be rejected with HTTP 413");
});

test("Security Control 25: Session join/patch/delete rejects oversized payload (>8 KB)", async () => {
  const oversizedData = "B".repeat(10 * 1024);

  // Join POST
  const joinReq = new Request("http://localhost:3000/api/signal/session/12345678", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "http://localhost:3000",
    },
    body: JSON.stringify({ senderToken: oversizedData }),
  });
  const joinRes = await handleJoinSession(joinReq, { params: Promise.resolve({ code: "12345678" }) });
  assert.equal(joinRes.status, 413, "Oversized join payload must return 413");

  // Patch PATCH
  const patchReq = new Request("http://localhost:3000/api/signal/session/12345678", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Origin: "http://localhost:3000",
    },
    body: JSON.stringify({ ttlSeconds: 600, receiverToken: oversizedData }),
  });
  const patchRes = await handlePatchSession(patchReq, { params: Promise.resolve({ code: "12345678" }) });
  assert.equal(patchRes.status, 413, "Oversized patch payload must return 413");

  // Delete DELETE
  const deleteReq = new Request("http://localhost:3000/api/signal/session/12345678", {
    method: "DELETE",
    headers: {
      "Content-Type": "application/json",
      Origin: "http://localhost:3000",
    },
    body: JSON.stringify({ receiverToken: oversizedData }),
  });
  const deleteRes = await handleDeleteSession(deleteReq, { params: Promise.resolve({ code: "12345678" }) });
  assert.equal(deleteRes.status, 413, "Oversized delete payload must return 413");
});

test("Security Control 28 & 29: Metadata sanitization and storage cleanup resilience", async () => {
  // Path traversal prevention
  const traversal = sanitizeFileName("../../../../etc/shadow");
  assert.ok(!traversal.includes("/"), "Slashes must be converted to underscores");
  assert.ok(!traversal.includes("\\"), "Backslashes must be converted to underscores");
  assert.equal(traversal, ".._.._.._.._etc_shadow");

  // MIME type fallback
  assert.equal(sanitizeMimeType("unknown/bad<script>"), "application/octet-stream");
  assert.equal(sanitizeMimeType("text/plain"), "text/plain");

  // Storage cleanup safe execution in non-browser/unsupported environments
  await assert.doesNotReject(
    async () => {
      await cleanupSessionStorage("12345678");
    },
    "cleanupSessionStorage must not throw when OPFS is unsupported or absent",
  );
});

test("Security Control 23 & 31: SECURITY.md policy completeness", () => {
  const secPath = path.join(process.cwd(), "SECURITY.md");
  assert.ok(fs.existsSync(secPath), "SECURITY.md must exist in repository root");

  const secContent = fs.readFileSync(secPath, "utf-8");
  assert.ok(
    secContent.includes("Threat Modeling and Trust Boundaries"),
    "SECURITY.md must define threat modeling and trust boundaries",
  );
  assert.ok(
    secContent.includes("API Authorization & Endpoint Audit"),
    "SECURITY.md must include full API authorization matrix",
  );
  assert.ok(
    secContent.includes("Incident Response & Secret Rotation"),
    "SECURITY.md must provide incident response and secret rotation procedures",
  );
});
