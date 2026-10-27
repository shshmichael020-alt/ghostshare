import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { generateUniqueCode } from "@/lib/codes";
import { createSignalingSession, checkCrossIsolateRateLimit, SignalingStorageNamespace } from "@/lib/signalStore";
import { getClientIp, isAllowedOrigin } from "@/lib/rateLimit";
import { DEFAULT_TTL_SECONDS, isValidTtl } from "@/lib/constants";

const MAX_SESSION_PAYLOAD_BYTES = 8192; // 8 KB max payload size for session operations

export async function POST(request: Request) {
  try {
    const origin = request.headers.get("origin");
    if (!isAllowedOrigin(origin, request.url)) {
      return NextResponse.json({ error: "Forbidden: Untrusted cross-origin request" }, { status: 403 });
    }

    let binding: SignalingStorageNamespace | undefined;
    try {
      const ctx = getCloudflareContext();
      binding = (ctx?.env as Record<string, unknown>)?.SIGNALING_DO as SignalingStorageNamespace | undefined;
    } catch {}

    const ip = getClientIp(request);
    const rl = await checkCrossIsolateRateLimit("session_create", ip, 40, 60_000, binding);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: "Too many session creation requests. Please wait a moment." },
        { status: 429, headers: { "Retry-After": String(rl.reset) } },
      );
    }

    const bodyText = await request.text();
    if (bodyText.length > MAX_SESSION_PAYLOAD_BYTES) {
      return NextResponse.json({ error: "Payload exceeds maximum allowed session payload size" }, { status: 413 });
    }

    let ttlSeconds = DEFAULT_TTL_SECONDS;
    if (bodyText.trim().length > 0) {
      try {
        const body = JSON.parse(bodyText) as { ttlSeconds?: unknown };
        if (body && typeof body.ttlSeconds !== "undefined") {
          if (!isValidTtl(body.ttlSeconds)) {
            return NextResponse.json(
              { error: "Invalid ttlSeconds. Must be a supported duration option." },
              { status: 400 },
            );
          }
          ttlSeconds = body.ttlSeconds;
        }
      } catch {
        return NextResponse.json({ error: "Invalid JSON format" }, { status: 400 });
      }
    }

    const code = await generateUniqueCode(binding);
    const { session, receiverToken } = await createSignalingSession(code, ttlSeconds, binding);

    return NextResponse.json(
      {
        code: session.code,
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
        receiverToken,
      },
      {
        status: 200,
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
          "CDN-Cache-Control": "no-store",
        },
      },
    );
  } catch (err) {
    console.error("Session creation error:", err);
    return NextResponse.json(
      { error: "Could not create authoritative pairing session", details: (err as Error).message },
      { status: 503 },
    );
  }
}
