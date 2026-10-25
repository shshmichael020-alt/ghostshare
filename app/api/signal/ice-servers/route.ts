import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";

// Cached credentials to prevent hammering the Metered API on every peer connection
let cachedIceServers: RTCIceServer[] | null = null;
let cacheExpiresAt = 0;

const DEFAULT_STUN_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.cloudflare.com:3478" },
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" },
  { urls: "stun:global.stun.twilio.com:3478" },
];

export async function GET() {
  const now = Date.now();
  if (cachedIceServers && now < cacheExpiresAt) {
    return NextResponse.json({
      iceServers: cachedIceServers,
      turnConfigured: true,
      source: "cached",
    });
  }

  let env: Record<string, string | undefined> = {};
  try {
    const ctx = getCloudflareContext();
    if (ctx?.env) {
      env = ctx.env as Record<string, string | undefined>;
    }
  } catch {}

  const meteredApiKey = env.METERED_API_KEY || process.env.METERED_API_KEY;
  const meteredAppName = env.METERED_APP_NAME || process.env.METERED_APP_NAME;
  const turnServersJson = env.TURN_SERVERS_JSON || process.env.TURN_SERVERS_JSON;

  // Option 1: Custom JSON servers provided via Cloudflare Worker secret
  if (turnServersJson) {
    try {
      const parsed = JSON.parse(turnServersJson) as RTCIceServer[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        cachedIceServers = [...DEFAULT_STUN_SERVERS, ...parsed];
        cacheExpiresAt = now + 60 * 60 * 1000; // 1 hour
        return NextResponse.json({
          iceServers: cachedIceServers,
          turnConfigured: true,
          source: "custom-json",
        });
      }
    } catch (err) {
      console.warn("Failed to parse TURN_SERVERS_JSON:", err);
    }
  }

  // Option 2: Metered REST API dynamic credential fetching (official documented mechanism)
  if (meteredApiKey && meteredAppName) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3500);
      const res = await fetch(
        `https://${meteredAppName}.metered.live/api/v1/turn/credentials?apiKey=${meteredApiKey}`,
        { signal: controller.signal }
      );
      clearTimeout(timeout);

      if (res.ok) {
        const fetched = (await res.json()) as RTCIceServer[];
        if (Array.isArray(fetched) && fetched.length > 0) {
          cachedIceServers = [...DEFAULT_STUN_SERVERS, ...fetched];
          cacheExpiresAt = now + 10 * 60 * 1000; // Cache 10 minutes
          return NextResponse.json({
            iceServers: cachedIceServers,
            turnConfigured: true,
            source: "metered-api",
          });
        }
      }
    } catch (apiErr) {
      console.warn("Metered dynamic credential API fetch error:", apiErr);
    }
  }

  // Baseline: Fast Anycast STUN servers (no TURN key configured)
  return NextResponse.json({
    iceServers: DEFAULT_STUN_SERVERS,
    turnConfigured: false,
    source: "default-stun",
    note: "No external TURN API key configured in Cloudflare Worker environment. Direct Anycast STUN mode active.",
  });
}
