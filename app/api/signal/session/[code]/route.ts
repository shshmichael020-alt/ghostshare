import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
  getSignalingSession,
  joinSignalingSession,
  updateSessionTtl,
  closeSignalingSession,
  SignalingStorageNamespace,
} from "@/lib/signalStore";
import { checkRateLimit, getClientIp } from "@/lib/rateLimit";
import { isValidTtl } from "@/lib/constants";

function getBinding(): SignalingStorageNamespace | undefined {
  try {
    const ctx = getCloudflareContext();
    return (ctx?.env as Record<string, unknown>)?.SIGNALING_DO as SignalingStorageNamespace | undefined;
  } catch {
    return undefined;
  }
}

export async function GET(request: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;

  if (!code || !/^\d{8}$/.test(code)) {
    return NextResponse.json({ error: "Invalid 8-digit code format" }, { status: 400 });
  }

  const ip = getClientIp(request);
  const rl = checkRateLimit("session_check", ip, 120, 60_000);
  if (!rl.success) {
    return NextResponse.json(
      { error: "Too many requests. Please wait a moment." },
      { status: 429, headers: { "Retry-After": String(rl.reset) } },
    );
  }

  try {
    const binding = getBinding();
    const session = await getSignalingSession(code, binding);

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
        createdAt: session.createdAt,
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
  } catch (err) {
    console.error("Session lookup error:", err);
    return NextResponse.json(
      { error: "Failed to query authoritative session store", details: (err as Error).message },
      { status: 503 },
    );
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;

  if (!code || !/^\d{8}$/.test(code)) {
    return NextResponse.json({ error: "Invalid 8-digit code format" }, { status: 400 });
  }

  const ip = getClientIp(request);
  const rl = checkRateLimit("session_join", ip, 60, 60_000);
  if (!rl.success) {
    return NextResponse.json(
      { error: "Too many join attempts. Please wait a moment." },
      { status: 429, headers: { "Retry-After": String(rl.reset) } },
    );
  }

  try {
    const binding = getBinding();
    const success = await joinSignalingSession(code, binding);
    if (!success) {
      return NextResponse.json({ error: "Pairing code not found or expired" }, { status: 404 });
    }

    return NextResponse.json({ ok: true, code });
  } catch (err) {
    console.error("Session join error:", err);
    return NextResponse.json(
      { error: "Failed to join session", details: (err as Error).message },
      { status: 503 },
    );
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;

  if (!code || !/^\d{8}$/.test(code)) {
    return NextResponse.json({ error: "Invalid 8-digit code format" }, { status: 400 });
  }

  try {
    const body = (await request.json()) as { ttlSeconds?: unknown; receiverToken?: string };
    const { ttlSeconds, receiverToken } = body;

    if (!isValidTtl(ttlSeconds)) {
      return NextResponse.json(
        { error: "Invalid ttlSeconds. Must match one of the predefined duration options." },
        { status: 400 },
      );
    }

    if (!receiverToken || typeof receiverToken !== "string") {
      return NextResponse.json(
        { error: "Missing or invalid receiverToken capability" },
        { status: 401 },
      );
    }

    const binding = getBinding();
    const result = await updateSessionTtl(code, ttlSeconds, receiverToken, binding);
    if (!result.ok) {
      return NextResponse.json({ error: "Session not found or expired" }, { status: 404 });
    }

    return NextResponse.json({
      ok: true,
      expiresAt: result.expiresAt,
      remainingSeconds: result.remainingSeconds,
    });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized: Invalid receiver token" }, { status: 403 });
    }
    console.error("Failed to update TTL:", err);
    return NextResponse.json({ error: "Failed to update TTL", details: msg }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;

  if (!code || !/^\d{8}$/.test(code)) {
    return NextResponse.json({ error: "Invalid 8-digit code format" }, { status: 400 });
  }

  try {
    let receiverToken: string | undefined;
    try {
      const body = (await request.json()) as { receiverToken?: string };
      receiverToken = body?.receiverToken;
    } catch {}

    const binding = getBinding();
    await closeSignalingSession(code, receiverToken, binding);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: "Failed to close session", details: (err as Error).message }, { status: 500 });
  }
}
