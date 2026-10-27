import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
  getSignalingSession,
  joinSignalingSession,
  updateSessionTtl,
  closeSignalingSession,
  checkCrossIsolateRateLimit,
  SignalingStorageNamespace,
} from "@/lib/signalStore";
import { getClientIp, isAllowedOrigin } from "@/lib/rateLimit";
import { isValidTtl } from "@/lib/constants";
import { readBoundedJson, MAX_SESSION_PAYLOAD_BYTES, safeErrorResponse } from "@/lib/requestBody";

function getBinding(): SignalingStorageNamespace | undefined {
  try {
    const ctx = getCloudflareContext();
    return (ctx?.env as Record<string, unknown>)?.SIGNALING_DO as SignalingStorageNamespace | undefined;
  } catch {
    return undefined;
  }
}

function extractBearer(request: Request, bodyToken?: string): string | undefined {
  if (bodyToken && typeof bodyToken === "string" && bodyToken.trim().length > 0) {
    return bodyToken.trim();
  }
  const auth = request.headers.get("authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  return undefined;
}

export async function GET(request: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;

  if (!code || !/^\d{8}$/.test(code)) {
    return NextResponse.json({ error: "Invalid 8-digit code format" }, { status: 400 });
  }

  const ip = getClientIp(request);
  const binding = getBinding();
  const rl = await checkCrossIsolateRateLimit("session_check", ip, 120, 60_000, binding);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please wait a moment." },
      { status: 429, headers: { "Retry-After": String(rl.reset) } },
    );
  }

  try {
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
    return safeErrorResponse("Failed to query authoritative session store", 503, "session_lookup", err);
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ code: string }> }) {
  const origin = request.headers.get("origin");
  if (!isAllowedOrigin(origin, request.url)) {
    return NextResponse.json({ error: "Forbidden: Untrusted cross-origin request" }, { status: 403 });
  }

  const { code } = await params;

  if (!code || !/^\d{8}$/.test(code)) {
    return NextResponse.json({ error: "Invalid 8-digit code format" }, { status: 400 });
  }

  const ip = getClientIp(request);
  const binding = getBinding();
  const rl = await checkCrossIsolateRateLimit("session_join", ip, 60, 60_000, binding);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many join attempts. Please wait a moment." },
      { status: 429, headers: { "Retry-After": String(rl.reset) } },
    );
  }

  try {
    const bodyResult = await readBoundedJson<{ senderToken?: string }>(request, MAX_SESSION_PAYLOAD_BYTES);
    if (!bodyResult.ok) {
      return NextResponse.json({ error: bodyResult.error }, { status: bodyResult.status });
    }

    const senderToken = bodyResult.data?.senderToken;
    const result = await joinSignalingSession(code, senderToken, binding);
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error || "Could not join session" },
        { status: result.status },
      );
    }

    return NextResponse.json({ ok: true, code, senderToken: result.senderToken });
  } catch (err) {
    return safeErrorResponse("Failed to join session", 503, "session_join", err);
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ code: string }> }) {
  const origin = request.headers.get("origin");
  if (!isAllowedOrigin(origin, request.url)) {
    return NextResponse.json({ error: "Forbidden: Untrusted cross-origin request" }, { status: 403 });
  }

  const { code } = await params;

  if (!code || !/^\d{8}$/.test(code)) {
    return NextResponse.json({ error: "Invalid 8-digit code format" }, { status: 400 });
  }

  try {
    const bodyResult = await readBoundedJson<{ ttlSeconds?: unknown; receiverToken?: string }>(
      request,
      MAX_SESSION_PAYLOAD_BYTES,
    );
    if (!bodyResult.ok) {
      return NextResponse.json({ error: bodyResult.error }, { status: bodyResult.status });
    }
    if (!bodyResult.data) {
      return NextResponse.json({ error: "Invalid JSON format" }, { status: 400 });
    }

    const { ttlSeconds } = bodyResult.data;
    const token = extractBearer(request, bodyResult.data.receiverToken);

    if (!isValidTtl(ttlSeconds)) {
      return NextResponse.json(
        { error: "Invalid ttlSeconds. Must match one of the predefined duration options." },
        { status: 400 },
      );
    }

    if (!token) {
      return NextResponse.json(
        { error: "Missing or invalid receiverToken capability" },
        { status: 401 },
      );
    }

    const binding = getBinding();
    const result = await updateSessionTtl(code, ttlSeconds, token, binding);
    if (!result.ok) {
      return NextResponse.json({ error: "Session not found or expired" }, { status: 404 });
    }

    return NextResponse.json({
      ok: true,
      expiresAt: result.expiresAt,
      remainingSeconds: result.remainingSeconds,
    });
  } catch (err) {
    const msg = (err as Error)?.message || "";
    if (msg.includes("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized: Invalid receiver token" }, { status: 403 });
    }
    return safeErrorResponse("Failed to update session TTL", 500, "session_patch", err);
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ code: string }> }) {
  const origin = request.headers.get("origin");
  if (!isAllowedOrigin(origin, request.url)) {
    return NextResponse.json({ error: "Forbidden: Untrusted cross-origin request" }, { status: 403 });
  }

  const { code } = await params;

  if (!code || !/^\d{8}$/.test(code)) {
    return NextResponse.json({ error: "Invalid 8-digit code format" }, { status: 400 });
  }

  try {
    const bodyResult = await readBoundedJson<{ receiverToken?: string }>(request, MAX_SESSION_PAYLOAD_BYTES);
    if (!bodyResult.ok) {
      return NextResponse.json({ error: bodyResult.error }, { status: bodyResult.status });
    }

    const token = extractBearer(request, bodyResult.data?.receiverToken);

    // Enforce required receiver capability token
    if (!token) {
      return NextResponse.json(
        { error: "Unauthorized: Missing receiverToken capability" },
        { status: 401 },
      );
    }

    const binding = getBinding();
    const res = await closeSignalingSession(code, token, binding);

    if (!res.ok) {
      return NextResponse.json(
        { error: res.error || "Failed to close session" },
        { status: res.status },
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return safeErrorResponse("Failed to close session", 500, "session_close", err);
  }
}
