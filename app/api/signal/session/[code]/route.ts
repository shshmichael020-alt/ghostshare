import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getSignalingSession, joinSignalingSession, updateSessionTtl } from "@/lib/signalStore";
import { checkRateLimit, getClientIp } from "@/lib/rateLimit";

export async function GET(request: Request, { params }: { params: Promise<{ code: string }> }) {
  try {
    const ctx = getCloudflareContext();
    const kv = (ctx?.env as Record<string, unknown>)?.SESSIONS_KV as KVNamespace | undefined;
    if (kv) {
      (globalThis as unknown as Record<string, unknown>).__SESSIONS_KV__ = kv;
    }
  } catch {}

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

  let session = await getSignalingSession(code);
  if (!session) {
    // Brief retry in case of edge cross-PoP propagation latency
    await new Promise((r) => setTimeout(r, 400));
    session = await getSignalingSession(code);
  }

  if (!session) {
    return NextResponse.json(
      { error: "Pairing code not found or expired" },
      {
        status: 404,
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
          "CDN-Cache-Control": "no-store",
        },
      },
    );
  }

  return NextResponse.json(
    {
      code: session.code,
      expiresAt: session.expiresAt,
      remainingSeconds: Math.max(0, Math.round((session.expiresAt - Date.now()) / 1000)),
      receiverActive: session.receiverActive,
      senderActive: session.senderActive,
    },
    {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        "CDN-Cache-Control": "no-store",
      },
    },
  );
}

export async function POST(request: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;

  if (!code || !/^\d{8}$/.test(code)) {
    return NextResponse.json({ error: "Invalid 8-digit code format" }, { status: 400 });
  }

  const success = await joinSignalingSession(code);
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

    const updated = await updateSessionTtl(code, ttlSeconds);
    if (!updated) {
      return NextResponse.json({ error: "Session not found or expired" }, { status: 404 });
    }

    const session = await getSignalingSession(code);
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
