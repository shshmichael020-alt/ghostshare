import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { generateUniqueCode } from "@/lib/codes";
import { createSignalingSession, checkCrossIsolateRateLimit, SignalingStorageNamespace } from "@/lib/signalStore";
import { getClientIp, isAllowedOrigin } from "@/lib/rateLimit";
import { DEFAULT_TTL_SECONDS, isValidTtl } from "@/lib/constants";
import { readBoundedJson, MAX_SESSION_PAYLOAD_BYTES, safeErrorResponse } from "@/lib/requestBody";

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

    const bodyResult = await readBoundedJson<{ ttlSeconds?: unknown }>(request, MAX_SESSION_PAYLOAD_BYTES);
    if (!bodyResult.ok) {
      return NextResponse.json({ error: bodyResult.error }, { status: bodyResult.status });
    }

    let ttlSeconds = DEFAULT_TTL_SECONDS;
    if (bodyResult.data && typeof bodyResult.data.ttlSeconds !== "undefined") {
      if (!isValidTtl(bodyResult.data.ttlSeconds)) {
        return NextResponse.json(
          { error: "Invalid ttlSeconds. Must be a supported duration option." },
          { status: 400 },
        );
      }
      ttlSeconds = bodyResult.data.ttlSeconds;
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
    return safeErrorResponse(
      "Could not create authoritative pairing session",
      503,
      "session_create",
      err,
    );
  }
}
