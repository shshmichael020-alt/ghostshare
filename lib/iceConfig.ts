/**
 * Unified ICE Server Configuration and Sanitization
 *
 * Enforces a single validation policy across Cloudflare Worker edge handlers,
 * Next.js API routes, and client WebRTC initialization.
 */

export const DEFAULT_STUN_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.cloudflare.com:3478" },
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" },
  { urls: "stun:global.stun.twilio.com:3478" },
  { urls: "stun:stun.relay.metered.ca:80" },
];

/**
 * Validates that an ICE server URL starts with an accepted scheme (stun, turn, turns)
 * and does not attempt to connect to prohibited ports (e.g., port 53, blocked by browsers).
 */
export function isSafeIceUrl(url: unknown): boolean {
  if (typeof url !== "string") return false;
  const trimmed = url.trim();
  if (
    !trimmed.startsWith("stun:") &&
    !trimmed.startsWith("turn:") &&
    !trimmed.startsWith("turns:")
  ) {
    return false;
  }
  // Reject port 53 (DNS port blocked by all modern browser engines)
  if (/:53(\/|$|\?)/.test(trimmed) || trimmed.endsWith(":53")) {
    return false;
  }
  return true;
}

/**
 * Validates and sanitizes a single RTCIceServer candidate object.
 *
 * Rules:
 * - urls must contain at least one valid, safe ICE URL.
 * - If URLs contain turn: or turns:, the entry MUST have a non-empty string username and credential.
 *   Unauthenticated TURN entries are dropped or downgraded to STUN (if STUN URLs exist).
 * - Port 53 URLs are strictly filtered out even when provided inside URL arrays.
 */
export function sanitizeIceServer(entry: unknown): RTCIceServer | null {
  if (!entry || typeof entry !== "object") return null;
  const raw = entry as Record<string, unknown>;

  let rawUrls: string[] = [];
  if (typeof raw.urls === "string") {
    rawUrls = [raw.urls];
  } else if (Array.isArray(raw.urls)) {
    rawUrls = raw.urls.filter((u): u is string => typeof u === "string");
  } else {
    return null;
  }

  const safeUrls = rawUrls.map((u) => u.trim()).filter(isSafeIceUrl);
  if (safeUrls.length === 0) return null;

  const hasTurn = safeUrls.some(
    (u) => u.startsWith("turn:") || u.startsWith("turns:"),
  );
  const username =
    typeof raw.username === "string" ? raw.username.trim() : "";
  const credential =
    typeof raw.credential === "string" ? raw.credential.trim() : "";

  if (hasTurn) {
    // Authenticated TURN requires non-empty username and credential
    if (!username || !credential) {
      // Discard unauthenticated TURN URLs; keep only STUN URLs if any exist
      const stunOnlyUrls = safeUrls.filter((u) => u.startsWith("stun:"));
      if (stunOnlyUrls.length === 0) return null;
      return { urls: stunOnlyUrls.length === 1 ? stunOnlyUrls[0] : stunOnlyUrls };
    }
    return {
      urls: safeUrls.length === 1 ? safeUrls[0] : safeUrls,
      username,
      credential,
    };
  }

  return {
    urls: safeUrls.length === 1 ? safeUrls[0] : safeUrls,
  };
}

/**
 * Sanitizes an array of ICE servers and determines if usable authenticated TURN is present.
 */
export function sanitizeIceServers(servers: unknown[]): {
  iceServers: RTCIceServer[];
  hasAuthenticatedTurn: boolean;
} {
  const valid: RTCIceServer[] = [];
  let hasAuthenticatedTurn = false;

  for (const item of servers) {
    const sanitized = sanitizeIceServer(item);
    if (sanitized) {
      valid.push(sanitized);
      if (sanitized.username && sanitized.credential) {
        const urls = Array.isArray(sanitized.urls)
          ? sanitized.urls
          : [sanitized.urls];
        if (urls.some((u) => u.startsWith("turn:") || u.startsWith("turns:"))) {
          hasAuthenticatedTurn = true;
        }
      }
    }
  }

  return {
    iceServers: valid,
    hasAuthenticatedTurn,
  };
}

/**
 * Parses and sanitizes a TURN_SERVERS_JSON string.
 * Returns null if the string cannot be parsed as a valid, non-empty array of ICE servers.
 */
export function parseAndValidateTurnServersJson(rawJson: string): {
  iceServers: RTCIceServer[];
  turnConfigured: boolean;
} | null {
  try {
    const cleanJson = rawJson.trim().replace(/^\uFEFF/, "");
    const parsed = JSON.parse(cleanJson);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return null;
    }
    const { iceServers, hasAuthenticatedTurn } = sanitizeIceServers(parsed);
    if (iceServers.length === 0) {
      return null;
    }
    return {
      iceServers,
      turnConfigured: hasAuthenticatedTurn,
    };
  } catch {
    return null;
  }
}
