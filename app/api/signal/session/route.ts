import { NextResponse } from "next/server";
import { generateUniqueCode } from "@/lib/codes";
import { createSignalingSession } from "@/lib/signalStore";
import { checkRateLimit, getClientIp } from "@/lib/rateLimit";

export async function POST(request: Request) {
  try {
    const ip = getClientIp(request);
    const rl = checkRateLimit("session_create", ip, 20, 60_000);
    if (!rl.success) {
      return NextResponse.json(
        { error: "Too many session creation requests. Please wait a moment." },
        { status: 429, headers: { "Retry-After": String(rl.reset) } },
      );
    }

    let ttlSeconds = 3600; // 1 hour default
    try {
      const body = (await request.json()) as { ttlSeconds?: number };
      if (body && typeof body.ttlSeconds === "number" && body.ttlSeconds > 0) {
        ttlSeconds = body.ttlSeconds;
      }
    } catch {
      // Body empty or not JSON, use default 3600
    }

    const code = await generateUniqueCode();
    const session = createSignalingSession(code, ttlSeconds);

    return NextResponse.json({
      code: session.code,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
    });
  } catch (err) {
    console.error("Session creation error:", err);
    return NextResponse.json({ error: "Could not create pairing session" }, { status: 500 });
  }
}
