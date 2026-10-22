import { NextResponse } from "next/server";
import { getSignalingSession, joinSignalingSession, updateSessionTtl } from "@/lib/signalStore";
import { checkRateLimit, getClientIp } from "@/lib/rateLimit";

export async function GET(request: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;

  if (!code || !/^\d{8}$/.test(code)) {
    return NextResponse.json({ error: "Invalid 8-digit code format" }, { status: 400 });
  }

  const ip = getClientIp(request);
  const rl = checkRateLimit("session_check", ip, 80, 60_000);
  if (!rl.success) {
    return NextResponse.json(
      { error: "Too many requests. Please wait a moment." },
      { status: 429, headers: { "Retry-After": String(rl.reset) } },
    );
  }

  const session = getSignalingSession(code);
  if (!session) {
    return NextResponse.json({ error: "Pairing code not found or expired" }, { status: 404 });
  }

  return NextResponse.json({
    code: session.code,
    expiresAt: session.expiresAt,
    remainingSeconds: Math.max(0, Math.round((session.expiresAt - Date.now()) / 1000)),
    receiverActive: session.receiverActive,
    senderActive: session.senderActive,
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;

  if (!code || !/^\d{8}$/.test(code)) {
    return NextResponse.json({ error: "Invalid 8-digit code format" }, { status: 400 });
  }

  const success = joinSignalingSession(code);
  if (!success) {
    return NextResponse.json({ error: "Pairing code not found or expired" }, { status: 404 });
  }

  return NextResponse.json({ ok: true, code });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;

  if (!code || !/^\d{8}$/.test(code)) {
    return NextResponse.json({ error: "Invalid 8-digit code format" }, { status: 400 });
  }

  try {
    const { ttlSeconds } = (await request.json()) as { ttlSeconds?: number };
    if (!ttlSeconds || typeof ttlSeconds !== "number" || ttlSeconds <= 0) {
      return NextResponse.json({ error: "Invalid ttlSeconds" }, { status: 400 });
    }

    const updated = updateSessionTtl(code, ttlSeconds);
    if (!updated) {
      return NextResponse.json({ error: "Session not found or expired" }, { status: 404 });
    }

    const session = getSignalingSession(code);
    return NextResponse.json({
      ok: true,
      expiresAt: session?.expiresAt,
      remainingSeconds: session ? Math.max(0, Math.round((session.expiresAt - Date.now()) / 1000)) : 0,
    });
  } catch (err) {
    console.error("Failed to update TTL:", err);
    return NextResponse.json({ error: "Failed to update TTL" }, { status: 500 });
  }
}
