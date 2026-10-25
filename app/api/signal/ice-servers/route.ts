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

export const dynamic = "force-dynamic";

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
  let envKeys: string[] = [];
  try {
    const ctx = getCloudflareContext();
    if (ctx?.env) {
      env = ctx.env as Record<string, string | undefined>;
      envKeys = Object.keys(ctx.env);
    }
  } catch {}

  const cfTurnKeyId = env.CLOUDFLARE_TURN_KEY_ID || process.env.CLOUDFLARE_TURN_KEY_ID;
  const cfTurnApiToken = env.CLOUDFLARE_TURN_API_TOKEN || process.env.CLOUDFLARE_TURN_API_TOKEN;
  const meteredApiKey = env.METERED_API_KEY || process.env.METERED_API_KEY;
  const meteredAppName = env.METERED_APP_NAME || process.env.METERED_APP_NAME;
  const turnServersJson = env.TURN_SERVERS_JSON || process.env.TURN_SERVERS_JSON;

  // Option 1: Cloudflare Calls Managed TURN Service (1,000 GB / 1 TB per month free)
  if (cfTurnKeyId && cfTurnApiToken) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3500);
      const res = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${cfTurnKeyId}/credentials/generate-ice-servers`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${cfTurnApiToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ttl: 86400 }),
          signal: controller.signal,
        },
      );
      clearTimeout(timeout);

      if (res.ok) {
        const data = (await res.json()) as { iceServers?: RTCIceServer[] };
        if (Array.isArray(data.iceServers) && data.iceServers.length > 0) {
          cachedIceServers = [...DEFAULT_STUN_SERVERS, ...data.iceServers];
          cacheExpiresAt = now + 12 * 60 * 60 * 1000; // Cache 12 hours
          return NextResponse.json({
            iceServers: cachedIceServers,
            turnConfigured: true,
            source: "cloudflare-calls-turn",
          });
        }
      }
    } catch (cfErr) {
      console.warn("Cloudflare Calls TURN dynamic credential error:", cfErr);
    }
  }

  let parseError: string | null = null;
  // Option 2: Custom JSON servers provided via Cloudflare Worker secret
  if (turnServersJson) {
    try {
      const cleanJson = turnServersJson.trim().replace(/^\uFEFF/, "");
      const parsed = JSON.parse(cleanJson) as RTCIceServer[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        cachedIceServers = [...DEFAULT_STUN_SERVERS, ...parsed];
        cacheExpiresAt = now + 60 * 60 * 1000; // 1 hour
        return NextResponse.json({
          iceServers: cachedIceServers,
          turnConfigured: true,
          source: "custom-json",
        });
      }
    } catch (err: unknown) {
      parseError = String(err);
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
