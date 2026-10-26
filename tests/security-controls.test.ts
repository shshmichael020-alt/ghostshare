import test from "node:test";
import assert from "node:assert/strict";
import { timingSafeEqualStr } from "../lib/crypto";
import { getClientIp, isValidIp, isAllowedOrigin, checkRateLimit } from "../lib/rateLimit";
import { sanitizeFileName, sanitizeMimeType, sanitizeFileId, sanitizeChatText } from "../lib/webrtc";
import {
  createSignalingSession,
  joinSignalingSession,
  postSignalMessage,
  pollSignalMessages,
  updateSessionTtl,
  closeSignalingSession,
} from "../lib/signalStore";
import nextConfig from "../next.config";

// ---------------------------------------------------------------------------
// Control 1: Authentication & Constant-Time Token Comparison
// ---------------------------------------------------------------------------
test("Security Control 1: Constant-time token verification prevents timing side-channels", () => {
  const secret = "a".repeat(48);
  const identical = "a".repeat(48);
  const diffSingleChar = "a".repeat(47) + "b";
  const diffLengthShorter = "a".repeat(47);
  const diffLengthLonger = "a".repeat(49);

  assert.equal(timingSafeEqualStr(secret, identical), true, "Identical tokens must match");
  assert.equal(timingSafeEqualStr(secret, diffSingleChar), false, "Single character difference must fail");
  assert.equal(timingSafeEqualStr(secret, diffLengthShorter), false, "Shorter token must fail");
  assert.equal(timingSafeEqualStr(secret, diffLengthLonger), false, "Longer token must fail");
  assert.equal(timingSafeEqualStr(secret, ""), false, "Empty string token must fail");
  assert.equal(timingSafeEqualStr(secret, null as unknown as string), false, "Null token must fail");
  assert.equal(timingSafeEqualStr(secret, undefined as unknown as string), false, "Undefined token must fail");
});

// ---------------------------------------------------------------------------
// Control 3: IDOR, BOLA, and Role Spoofing Protection
// ---------------------------------------------------------------------------
test("Security Control 3: Cross-Session IDOR Isolation and Role Spoofing Defense", async () => {
  const codeA = "11112222";
  const codeB = "33334444";

  // Create two distinct sessions
  const sessionA = await createSignalingSession(codeA, 3600);
  const sessionB = await createSignalingSession(codeB, 3600);

  const joinA = await joinSignalingSession(codeA);
  assert.equal(joinA.ok, true);
  const senderTokenA = joinA.senderToken!;

  const joinB = await joinSignalingSession(codeB);
  assert.equal(joinB.ok, true);
  const senderTokenB = joinB.senderToken!;

  // 1. Session A receiver cannot update TTL of Session B
  await assert.rejects(
    async () => {
      await updateSessionTtl(codeB, 7200, sessionA.receiverToken);
    },
    /Unauthorized/,
    "Session A receiver token must not authorize TTL update on Session B",
  );

  // 2. Session A receiver cannot close Session B
  const closeRes = await closeSignalingSession(codeB, sessionA.receiverToken);
  assert.equal(closeRes.status, 403, "Session A token must fail when closing Session B");

  // 3. Sender in Session A cannot spoof Receiver role
  const spoofSenderAsReceiver = await postSignalMessage(
    codeA,
    "receiver", // claiming to be receiver
    "sender",
    "offer",
    { sdp: "dummy" },
    senderTokenA, // presenting sender token
  );
  assert.equal(spoofSenderAsReceiver.ok, false);
  assert.equal(spoofSenderAsReceiver.status, 403, "Sender token cannot post messages as receiver");

  // 4. Receiver in Session A cannot spoof Sender role
  const spoofReceiverAsSender = await postSignalMessage(
    codeA,
    "sender", // claiming to be sender
    "receiver",
    "answer",
    { sdp: "dummy" },
    sessionA.receiverToken, // presenting receiver token
  );
  assert.equal(spoofReceiverAsSender.ok, false);
  assert.equal(spoofReceiverAsSender.status, 403, "Receiver token cannot post messages as sender");

  // 5. Cross-session signal posting: Sender B cannot post to Session A
  const crossSessionPost = await postSignalMessage(
    codeA,
    "sender",
    "receiver",
    "answer",
    { sdp: "dummy" },
    senderTokenB, // Token from Session B
  );
  assert.equal(crossSessionPost.ok, false);
  assert.equal(crossSessionPost.status, 403, "Token from Session B must not post to Session A");

  // 6. Cross-session polling: Receiver B cannot poll messages from Session A
  const crossSessionPoll = await pollSignalMessages(codeA, "receiver", 0, sessionB.receiverToken);
  assert.equal(crossSessionPoll.status, 403, "Receiver B cannot poll Session A messages");

  // 7. Missing token fails with 401
  const unauthPoll = await pollSignalMessages(codeA, "receiver", 0, "");
  assert.equal(unauthPoll.status, 401, "Missing token must be rejected with 401");
});

// ---------------------------------------------------------------------------
// Control 4: Rate Limiting & Trusted IP Extraction
// ---------------------------------------------------------------------------
test("Security Control 4: Trusted IP Extraction and Rate Limit Enforcement", () => {
  // Cloudflare CF-Connecting-IP is trusted as primary
  const reqWithCf = new Request("https://example.com/api", {
    headers: {
      "cf-connecting-ip": "203.0.113.195",
      "x-forwarded-for": "10.0.0.1, 10.0.0.2",
    },
  });
  assert.equal(getClientIp(reqWithCf), "203.0.113.195");

  // Malformed / injection IP in X-Forwarded-For is rejected
  const reqWithSqlInjectionIp = new Request("https://example.com/api", {
    headers: {
      "x-forwarded-for": "1.1.1.1'; DROP TABLE rate_limits; --",
    },
  });
  assert.equal(getClientIp(reqWithSqlInjectionIp), "127.0.0.1", "Malformed IP must fallback to default safe IP");

  // Valid IPv4 and IPv6 validation
  assert.equal(isValidIp("192.168.1.1"), true);
  assert.equal(isValidIp("2001:0db8:85a3:0000:0000:8a2e:0370:7334"), true);
  assert.equal(isValidIp("invalid-string"), false);
  assert.equal(isValidIp("999.999.999.999"), false);

  // Rate limiter quotas and resets
  const action = "test_quota_" + Date.now();
  const testIp = "198.51.100.1";
  const limit = 3;

  const r1 = checkRateLimit(action, testIp, limit, 5000);
  assert.equal(r1.success, true);
  assert.equal(r1.remaining, 2);

  const r2 = checkRateLimit(action, testIp, limit, 5000);
  assert.equal(r2.success, true);
  assert.equal(r2.remaining, 1);

  const r3 = checkRateLimit(action, testIp, limit, 5000);
  assert.equal(r3.success, true);
  assert.equal(r3.remaining, 0);

  // 4th request exhausts quota
  const r4 = checkRateLimit(action, testIp, limit, 5000);
  assert.equal(r4.success, false, "4th request exceeds limit and must fail");
  assert.equal(r4.remaining, 0);
});

// ---------------------------------------------------------------------------
// Control 5: Input Validation & File Metadata Sanitization
// ---------------------------------------------------------------------------
test("Security Control 5: Metadata sanitization defends against path traversal and injection", () => {
  // Unix Path Traversal
  assert.equal(
    sanitizeFileName("../../etc/passwd"),
    ".._.._etc_passwd",
    "Forward slashes must be converted to underscores",
  );

  // Windows Path Traversal
  assert.equal(
    sanitizeFileName("..\\..\\Windows\\System32\\cmd.exe"),
    ".._.._Windows_System32_cmd.exe",
    "Backslashes must be converted to underscores",
  );

  // Null Byte Injection
  assert.equal(
    sanitizeFileName("legit.pdf\0.exe"),
    "legit.pdf.exe",
    "Null bytes must be stripped",
  );

  // HTML / Script Injection in filename: slash in </script> is converted to underscore
  const scriptName = "<script>alert(1)</script>.png";
  assert.equal(
    sanitizeFileName(scriptName),
    "<script>alert(1)<_script>.png",
    "Slash in closing script tag converted to underscore",
  );

  // Empty or invalid filename
  assert.equal(sanitizeFileName(""), "unnamed_file");
  assert.equal(sanitizeFileName("   "), "unnamed_file");
  assert.equal(sanitizeFileName("."), "unnamed_file");
  assert.equal(sanitizeFileName(".."), "unnamed_file");

  // Excessive length truncation preserving extension
  const longName = "A".repeat(300) + ".zip";
  const sanitizedLong = sanitizeFileName(longName);
  assert.ok(sanitizedLong.length <= 255, "Sanitized filename must not exceed 255 characters");
  assert.ok(sanitizedLong.endsWith(".zip"), "File extension must be preserved during truncation");

  // MIME Type Sanitization
  assert.equal(sanitizeMimeType("image/png"), "image/png");
  assert.equal(sanitizeMimeType("application/pdf"), "application/pdf");
  assert.equal(sanitizeMimeType("video/mp4"), "video/mp4");
  assert.equal(sanitizeMimeType("text/html;script=1"), "application/octet-stream", "Malicious MIME params fallback");
  assert.equal(sanitizeMimeType("javascript:alert(1)"), "application/octet-stream", "Invalid scheme fallback");

  // File ID Sanitization
  assert.equal(sanitizeFileId("file_123-abc"), "file_123-abc");
  assert.equal(sanitizeFileId("../../evil_id"), "______evil_id", "Path traversal in ID converted to safe characters");

  // Chat Text Sanitization
  const rawChat = "Hello\x00\x08World!\nNew line allowed.";
  const cleanChat = sanitizeChatText(rawChat);
  assert.equal(cleanChat, "HelloWorld!\nNew line allowed.", "Control characters stripped");

  const longChat = "X".repeat(3000);
  assert.equal(sanitizeChatText(longChat).length, 2000, "Chat message bounded to 2000 characters");
});

// ---------------------------------------------------------------------------
// Control 7 & 18: CORS Restrictions & CSRF Origin Checks
// ---------------------------------------------------------------------------
test("Security Control 7 & 18: Allowed Origins and Cross-Site Request Forgery Defense", () => {
  const reqUrl = "https://ghostshare.shshmichael020.workers.dev/api/signal/session";

  // Same-origin request
  assert.equal(
    isAllowedOrigin("https://ghostshare.shshmichael020.workers.dev", reqUrl),
    true,
    "Same-origin must be permitted",
  );

  // Local development origin
  assert.equal(isAllowedOrigin("http://localhost:3000", reqUrl), true, "Local dev origin permitted");

  // Non-browser or server-to-server request (no Origin header)
  assert.equal(isAllowedOrigin(null, reqUrl), true, "Requests without origin header permitted");

  // Untrusted external attacker origin
  assert.equal(
    isAllowedOrigin("https://malicious-attacker.com", reqUrl),
    false,
    "Untrusted origin must be rejected",
  );
  assert.equal(
    isAllowedOrigin("https://phishing-site.org", reqUrl),
    false,
    "Phishing origin must be rejected",
  );
});

// ---------------------------------------------------------------------------
// Control 15: Security Headers Configuration
// ---------------------------------------------------------------------------
test("Security Control 15: Security Headers and Content Security Policy in Next.js config", async () => {
  assert.ok(typeof nextConfig.headers === "function", "nextConfig must define async headers()");
  const headersList = await nextConfig.headers();
  assert.ok(Array.isArray(headersList) && headersList.length > 0);

  const rootRule = headersList.find((r: { source: string }) => r.source === "/:path*");
  assert.ok(rootRule, "Root path rule /:path* must exist");

  const headersMap = new Map(rootRule.headers.map((h: { key: string; value: string }) => [h.key.toLowerCase(), h.value]));

  assert.ok(headersMap.has("content-security-policy"), "CSP must be configured");
  const csp = headersMap.get("content-security-policy")!;
  assert.ok(csp.includes("default-src 'self'"), "CSP default-src must be 'self'");
  assert.ok(csp.includes("frame-ancestors 'none'"), "CSP frame-ancestors must be 'none'");
  assert.ok(csp.includes("object-src 'none'"), "CSP object-src must be 'none'");

  assert.equal(headersMap.get("x-frame-options"), "DENY", "X-Frame-Options must be DENY");
  assert.equal(headersMap.get("x-content-type-options"), "nosniff", "X-Content-Type-Options must be nosniff");
  assert.ok(headersMap.get("strict-transport-security")?.includes("max-age="), "HSTS must declare max-age");
  assert.equal(headersMap.get("referrer-policy"), "strict-origin-when-cross-origin");
  assert.ok(headersMap.has("permissions-policy"), "Permissions-Policy must be declared");
});
