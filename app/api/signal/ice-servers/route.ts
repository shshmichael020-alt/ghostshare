import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
  DEFAULT_STUN_SERVERS,
  sanitizeIceServers,
  parseAndValidateTurnServersJson,
} from "@/lib/iceConfig";

// In-memory cache for dynamic ICE server credentials
let cachedIceServers: RTCIceServer[] | null = null;
let cacheExpiresAt = 0;

const NO_CACHE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate",
};

export const dynamic = "force-dynamic";

export async function GET() {
  const now = Date.now();
  if (cachedIceServers && now < cacheExpiresAt) {
    return NextResponse.json(
      {
        iceServers: cachedIceServers,
        turnConfigured: true,
        source: "cached",
      },
      { headers: NO_CACHE_HEADERS },
    );
  }

  let env: Record<string, string | undefined> = {};
  try {
    const ctx = getCloudflareContext();
    if (ctx?.env) {
      env = ctx.env as Record<string, string | undefined>;
    }
  } catch {}

  const cfTurnKeyId =
    env.CLOUDFLARE_TURN_KEY_ID ||
    process.env.CLOUDFLARE_TURN_KEY_ID ||
    env.TURN_KEY_ID ||
    process.env.TURN_KEY_ID;
  const cfTurnApiToken =
    env.CLOUDFLARE_TURN_API_TOKEN ||
    process.env.CLOUDFLARE_TURN_API_TOKEN ||
    env.TURN_KEY_API_TOKEN ||
    process.env.TURN_KEY_API_TOKEN;
  const meteredApiKey = env.METERED_API_KEY || process.env.METERED_API_KEY;
  const meteredAppName = env.METERED_APP_NAME || process.env.METERED_APP_NAME;
  const turnServersJson = env.TURN_SERVERS_JSON || process.env.TURN_SERVERS_JSON;

  // Option 1: Cloudflare Realtime TURN Service (1,000 GB / 1 TB per month free allowance)
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
        const data = (await res.json()) as { iceServers?: unknown[] };
        if (Array.isArray(data.iceServers)) {
          const { iceServers: sanitized, hasAuthenticatedTurn } =
            sanitizeIceServers(data.iceServers);

          if (hasAuthenticatedTurn && sanitized.length > 0) {
            cachedIceServers = [...DEFAULT_STUN_SERVERS, ...sanitized];
            cacheExpiresAt = now + 12 * 60 * 60 * 1000; // Cache 12 hours
            return NextResponse.json(
              {
                iceServers: cachedIceServers,
                turnConfigured: true,
                source: "cloudflare-calls-turn",
              },
              { headers: NO_CACHE_HEADERS },
            );
          }
        }
      }
    } catch {
      console.warn("Cloudflare Realtime TURN dynamic credential generation failed; evaluating fallbacks.");
    }
  }

  // Option 2: Metered REST API dynamic credential generation (documented server-side API)
  if (meteredApiKey && meteredAppName) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3500);
      const res = await fetch(
        `https://${meteredAppName}.metered.live/api/v1/turn/credentials?apiKey=${meteredApiKey}`,
        { signal: controller.signal },
      );
      clearTimeout(timeout);

      if (res.ok) {
        const fetched = (await res.json()) as unknown[];
        if (Array.isArray(fetched)) {
          const { iceServers: sanitized, hasAuthenticatedTurn } =
            sanitizeIceServers(fetched);

          if (hasAuthenticatedTurn && sanitized.length > 0) {
            cachedIceServers = [...DEFAULT_STUN_SERVERS, ...sanitized];
            cacheExpiresAt = now + 10 * 60 * 1000; // Cache 10 minutes
            return NextResponse.json(
              {
                iceServers: cachedIceServers,
                turnConfigured: true,
                source: "metered-api",
              },
              { headers: NO_CACHE_HEADERS },
            );
          }
        }
      }
    } catch {
      console.warn("Metered dynamic credential API fetch failed; evaluating fallbacks.");
    }
  }

  // Option 3: Validated static/preconfigured TURN JSON from Worker secrets
  if (turnServersJson) {
    const validated = parseAndValidateTurnServersJson(turnServersJson);
    if (validated) {
      cachedIceServers = [...DEFAULT_STUN_SERVERS, ...validated.iceServers];
      cacheExpiresAt = now + 60 * 60 * 1000; // 1 hour
      return NextResponse.json(
        {
          iceServers: cachedIceServers,
          turnConfigured: validated.turnConfigured,
          source: "custom-json",
        },
        { headers: NO_CACHE_HEADERS },
      );
    }
  }

  // Baseline: Anycast STUN servers (STUN-only fallback when no authenticated TURN is configured)
  return NextResponse.json(
    {
      iceServers: DEFAULT_STUN_SERVERS,
      turnConfigured: false,
      source: "default-stun",
      note: "No external TURN credentials configured. Direct Anycast STUN mode active.",
    },
    { headers: NO_CACHE_HEADERS },
  );
}
