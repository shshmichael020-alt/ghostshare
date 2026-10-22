interface RateLimitRecord {
  count: number;
  resetAt: number;
}

// In-memory sliding window cache per Worker isolate
const rateLimitMap = new Map<string, RateLimitRecord>();

// Periodic cleanup of expired rate limit entries
function cleanupExpired() {
  const now = Date.now();
  for (const [key, record] of rateLimitMap.entries()) {
    if (now >= record.resetAt) {
      rateLimitMap.delete(key);
    }
  }
}

/**
 * Extracts client IP from Cloudflare or standard proxy headers.
 */
export function getClientIp(request: Request): string {
  const cfIp = request.headers.get("cf-connecting-ip");
  if (cfIp) return cfIp.trim();

  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }

  const realIp = request.headers.get("x-real-ip");
  if (realIp) return realIp.trim();

  return "127.0.0.1";
}

/**
 * Checks and increments rate limit for an action and identifier.
 * @param action - Action namespace (e.g. "create_session", "check_code")
 * @param identifier - Unique client identifier (IP address)
 * @param limit - Maximum allowed requests in window
 * @param windowMs - Time window in milliseconds (default: 60,000ms = 1 min)
 */
export function checkRateLimit(
  action: string,
  identifier: string,
  limit: number,
  windowMs = 60_000,
): { success: boolean; limit: number; remaining: number; reset: number } {
  // Occasional cleanup when map grows
  if (rateLimitMap.size > 1000) {
    cleanupExpired();
  }

  const key = `${action}:${identifier}`;
  const now = Date.now();
  const record = rateLimitMap.get(key);

  if (!record || now >= record.resetAt) {
    // New window
    const resetAt = now + windowMs;
    rateLimitMap.set(key, { count: 1, resetAt });
    return {
      success: true,
      limit,
      remaining: limit - 1,
      reset: Math.ceil(resetAt / 1000),
    };
  }

  if (record.count >= limit) {
    return {
      success: false,
      limit,
      remaining: 0,
      reset: Math.ceil(record.resetAt / 1000),
    };
  }

  record.count += 1;
  return {
    success: true,
    limit,
    remaining: limit - record.count,
    reset: Math.ceil(record.resetAt / 1000),
  };
}
