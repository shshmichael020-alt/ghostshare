import test from "node:test";
import assert from "node:assert/strict";

import { generateSecureCode } from "../lib/codes";
import {
  MAX_TRANSFER_BYTES,
  DEFAULT_TTL_SECONDS,
  EXPIRY_OPTIONS,
  isValidTtl,
} from "../lib/constants";
import { formatSize, formatCountdown } from "../lib/format";
import { checkRateLimit } from "../lib/rateLimit";

test("Pairing Code: generates valid 8-digit cryptographically secure codes", () => {
  const codes = new Set<string>();
  const total = 500;

  for (let i = 0; i < total; i++) {
    const code = generateSecureCode();
    assert.equal(typeof code, "string");
    assert.equal(code.length, 8, `Code "${code}" must be exactly 8 digits`);
    assert.match(code, /^\d{8}$/, `Code "${code}" must contain only numeric digits`);
    codes.add(code);
  }

  // With 100M possible codes, 500 random draws should have high uniqueness (> 490)
  assert.ok(codes.size >= total * 0.98, "High entropy and collision resistance");
});

test("Constants & Expiry: validates TTL options and 250 MB quota cap", () => {
  assert.equal(MAX_TRANSFER_BYTES, 250 * 1024 * 1024, "Combined transfer limit must be 250 MB");
  assert.equal(DEFAULT_TTL_SECONDS, 3600, "Default TTL must be 1 hour");

  // Check valid expiry seconds
  for (const opt of EXPIRY_OPTIONS) {
    assert.ok(isValidTtl(opt.seconds), `${opt.seconds} must be valid TTL`);
  }

  // Check invalid values
  assert.ok(!isValidTtl(0));
  assert.ok(!isValidTtl(-100));
  assert.ok(!isValidTtl(3601));
  assert.ok(!isValidTtl("1 hour"));
  assert.ok(!isValidTtl(null));
});

test("Format Helpers: correctly formats byte sizes and countdown tickers", () => {
  // Byte sizes
  assert.equal(formatSize(512), "512 B");
  assert.equal(formatSize(1024), "1.0 KB");
  assert.equal(formatSize(1024 * 1024), "1.0 MB");
  assert.equal(formatSize(250 * 1024 * 1024), "250.0 MB");

  // Countdown formatting
  assert.equal(formatCountdown(0), "0:00");
  assert.equal(formatCountdown(5), "0:05");
  assert.equal(formatCountdown(65), "1:05");
  assert.equal(formatCountdown(3599), "59:59");
  assert.equal(formatCountdown(3600), "1:00:00");
  assert.equal(formatCountdown(7265), "2:01:05");
});

test("Rate Limiter: enforces request quotas per IP and resets after window", () => {
  const testIp = "192.168.1.100";
  const action = "test_rate_limit";
  const limit = 5;
  const windowMs = 500;

  // Perform 5 allowed requests
  for (let i = 1; i <= limit; i++) {
    const res = checkRateLimit(action, testIp, limit, windowMs);
    assert.equal(res.success, true, `Request ${i} should succeed`);
    assert.equal(res.remaining, limit - i);
  }

  // 6th request must be rejected
  const rejected = checkRateLimit(action, testIp, limit, windowMs);
  assert.equal(rejected.success, false, "6th request must be blocked by rate limiter");
  assert.equal(rejected.remaining, 0);

  // Different IP should still be allowed
  const diffIpRes = checkRateLimit(action, "10.0.0.1", limit, windowMs);
  assert.equal(diffIpRes.success, true, "Different client IP must have independent rate limit quota");
});
