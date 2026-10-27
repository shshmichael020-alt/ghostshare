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
  GET as handleGetSession,
} from "../app/api/signal/session/[code]/route";
import { cleanupSessionStorage } from "../lib/opfs";
import { sanitizeFileName, sanitizeMimeType } from "../lib/webrtc";
import {
  readBoundedJson,
  safeErrorResponse,
  MAX_SESSION_PAYLOAD_BYTES,
  MAX_SIGNALING_PAYLOAD_BYTES,
} from "../lib/requestBody";

test("Security Control 24: CI/CD workflow least-privilege permissions & secret scanning", () => {
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
    ciContent.includes("npm audit"),
    "CI workflow must enforce dependency audit",
  );
  assert.ok(
    ciContent.includes("Secret Scanning Guard"),
    "CI workflow must include secret scanning guard",
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

test("Security Control 25: Incremental stream rejection without Content-Length header", async () => {
  let chunksProduced = 0;
  let wasCancelled = false;

  // Stream that yields 50 chunks of 1024 bytes (50 KB total)
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      chunksProduced++;
      controller.enqueue(new Uint8Array(1024).fill(65)); // 1 KB of 'A'
    },
    cancel(reason) {
      wasCancelled = true;
    },
  });

  // Create request without Content-Length header using the raw ReadableStream
  const req = new Request("http://localhost:3000/api/signal/session", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Notice: No Content-Length header!
    },
    body: stream,
    // @ts-ignore - duplex is needed in Node fetch when body is a stream
    duplex: "half",
  });

  const result = await readBoundedJson(req, 8192); // 8 KB limit
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 413, "Must return HTTP 413");
    assert.ok(result.error.includes("exceeds maximum allowed size"));
  }

  // Chunks produced must be strictly stopped around chunk 9 (9 * 1024 = 9216 > 8192)
  // Proves stream was aborted before consuming the remaining 41 chunks!
  assert.ok(
    chunksProduced < 15,
    `Stream must be aborted early before full consumption. Chunks produced: ${chunksProduced}`,
  );
  assert.equal(wasCancelled, true, "ReadableStream.cancel() must be called upon limit breach");
});

test("Security Control 25: Exact-limit, over-limit by 1 byte, and valid requests", async () => {
  const maxBytes = 256;

  // 1. Valid request well within limit
  const validJson = JSON.stringify({ message: "hello" });
  const validReq = new Request("http://localhost:3000/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: validJson,
  });
  const validRes = await readBoundedJson<{ message: string }>(validReq, maxBytes);
  assert.equal(validRes.ok, true);
  if (validRes.ok) {
    assert.deepEqual(validRes.data, { message: "hello" });
  }

  // 2. Exact-limit payload
  // Build a JSON string whose exact UTF-8 byte length equals maxBytes (256)
  const baseJson = JSON.stringify({ pad: "" });
  const neededPadding = maxBytes - new TextEncoder().encode(baseJson).length;
  const exactPayload = JSON.stringify({ pad: "A".repeat(neededPadding) });
  assert.equal(new TextEncoder().encode(exactPayload).byteLength, maxBytes);

  const exactReq = new Request("http://localhost:3000/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: exactPayload,
  });
  const exactRes = await readBoundedJson<{ pad: string }>(exactReq, maxBytes);
  assert.equal(exactRes.ok, true, "Exact-limit payload must be accepted");
  if (exactRes.ok) {
    assert.equal(exactRes.bytesRead, maxBytes);
  }

  // 3. Over-limit by 1 byte (257 bytes)
  const overByOnePayload = JSON.stringify({ pad: "A".repeat(neededPadding + 1) });
  assert.equal(new TextEncoder().encode(overByOnePayload).byteLength, maxBytes + 1);

  const overReq = new Request("http://localhost:3000/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: overByOnePayload,
  });
  const overRes = await readBoundedJson(overReq, maxBytes);
  assert.equal(overRes.ok, false, "Over-by-1-byte payload must be rejected");
  if (!overRes.ok) {
    assert.equal(overRes.status, 413);
  }

  // 4. Content-Length header early rejection
  const headerOverReq = new Request("http://localhost:3000/test", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": "500", // Advertises 500 bytes when max is 256
    },
    body: "{}",
  });
  const headerRes = await readBoundedJson(headerOverReq, maxBytes);
  assert.equal(headerRes.ok, false);
  if (!headerRes.ok) {
    assert.equal(headerRes.status, 413, "Content-Length exceeding limit must reject with 413");
  }

  // 5. Malformed JSON returns 400
  const malformedReq = new Request("http://localhost:3000/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{ malformed: json, ",
  });
  const malformedRes = await readBoundedJson(malformedReq, maxBytes);
  assert.equal(malformedRes.ok, false);
  if (!malformedRes.ok) {
    assert.equal(malformedRes.status, 400, "Malformed JSON must return HTTP 400");
    assert.equal(malformedRes.error, "Invalid JSON format");
  }
});

test("Security Control 25: Route-level payload limits on message and session endpoints", async () => {
  // Signaling message endpoint rejects oversized payload (>64 KB)
  const oversizedSignal = "X".repeat(MAX_SIGNALING_PAYLOAD_BYTES + 1024);
  const sigReq = new Request("http://localhost:3000/api/signal/message", {
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
      data: oversizedSignal,
      token: "test_token",
    }),
  });
  const sigRes = await handlePostMessage(sigReq);
  assert.equal(sigRes.status, 413);

  // Session create endpoint rejects oversized payload (>8 KB)
  const oversizedSession = "A".repeat(MAX_SESSION_PAYLOAD_BYTES + 1024);
  const sessReq = new Request("http://localhost:3000/api/signal/session", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "http://localhost:3000",
    },
    body: JSON.stringify({ ttlSeconds: 1800, junk: oversizedSession }),
  });
  const sessRes = await handleCreateSession(sessReq);
  assert.equal(sessRes.status, 413);

  // Session join rejects oversized payload (>8 KB)
  const joinReq = new Request("http://localhost:3000/api/signal/session/12345678", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "http://localhost:3000",
    },
    body: JSON.stringify({ senderToken: oversizedSession }),
  });
  const joinRes = await handleJoinSession(joinReq, { params: Promise.resolve({ code: "12345678" }) });
  assert.equal(joinRes.status, 413);

  // Session patch rejects oversized payload (>8 KB)
  const patchReq = new Request("http://localhost:3000/api/signal/session/12345678", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Origin: "http://localhost:3000",
    },
    body: JSON.stringify({ ttlSeconds: 1800, receiverToken: oversizedSession }),
  });
  const patchRes = await handlePatchSession(patchReq, { params: Promise.resolve({ code: "12345678" }) });
  assert.equal(patchRes.status, 413);

  // Session delete rejects oversized payload (>8 KB)
  const deleteReq = new Request("http://localhost:3000/api/signal/session/12345678", {
    method: "DELETE",
    headers: {
      "Content-Type": "application/json",
      Origin: "http://localhost:3000",
    },
    body: JSON.stringify({ receiverToken: oversizedSession }),
  });
  const deleteRes = await handleDeleteSession(deleteReq, { params: Promise.resolve({ code: "12345678" }) });
  assert.equal(deleteRes.status, 413);
});

test("Security Control 3: Information disclosure prevention & safe client error response", async () => {
  // Directly test safeErrorResponse
  const sensitiveError = new Error("DB_SECRET_KEY=supersecretpassword-failed-to-connect-at-10.0.0.1:5432");
  const response = safeErrorResponse(
    "Could not create authoritative pairing session",
    503,
    "session_create",
    sensitiveError,
  );

  assert.equal(response.status, 503);
  const body = (await response.json()) as { error: string; errorId?: string; details?: unknown };

  assert.equal(body.error, "Could not create authoritative pairing session");
  assert.ok(typeof body.errorId === "string" && body.errorId.length > 0, "Response must include an errorId");
  assert.equal(body.details, undefined, "Response must NEVER contain 'details' property");

  // Verify response body does NOT leak sensitive tokens or connection strings
  const stringified = JSON.stringify(body);
  assert.ok(!stringified.includes("supersecretpassword"));
  assert.ok(!stringified.includes("10.0.0.1"));
  assert.ok(!stringified.includes("DB_SECRET_KEY"));
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

test("Security Control 23 & 31: SECURITY.md policy completeness & technical accuracy", () => {
  const secPath = path.join(process.cwd(), "SECURITY.md");
  assert.ok(fs.existsSync(secPath), "SECURITY.md must exist in repository root");

  const secContent = fs.readFileSync(secPath, "utf-8");
  assert.ok(
    secContent.includes("Threat Modeling and Trust Boundaries"),
    "SECURITY.md must define threat modeling and trust boundaries",
  );
  assert.ok(
    secContent.includes("SCTP over DTLS"),
    "SECURITY.md must accurately identify WebRTC data channels as SCTP over DTLS",
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
