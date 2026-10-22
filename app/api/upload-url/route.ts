import { NextResponse } from "next/server";
import { getSession, sessionUsedBytes, lockSessionTtl } from "@/lib/kv";
import { isValidTtl, DEFAULT_TTL_SECONDS, MAX_TRANSFER_BYTES } from "@/lib/constants";
import { buildObjectKey, createPresignedPut, createPresignedGet } from "@/lib/r2";
import { checkRateLimit, getClientIp } from "@/lib/rateLimit";

export async function POST(request: Request) {
  try {
    const ip = getClientIp(request);
    const rl = checkRateLimit("upload_url", ip, 40, 60_000);
    if (!rl.success) {
      return NextResponse.json(
        { error: "Too many upload requests. Please wait a moment." },
        { status: 429, headers: { "Retry-After": String(rl.reset) } },
      );
    }

    const { code, name, size, expirySeconds } = (await request.json()) as {
      code?: string;
      name?: string;
      size?: number;
      expirySeconds?: number;
    };

    if (!code || !/^\d{8}$/.test(code)) {
      return NextResponse.json({ error: "Invalid 8-digit session code" }, { status: 400 });
    }
    if (!name || typeof size !== "number" || size <= 0) {
      return NextResponse.json({ error: "Valid file name and positive size are required" }, { status: 400 });
    }

    const session = await getSession(code);
    if (!session) {
      return NextResponse.json({ error: "Session has expired or does not exist" }, { status: 404 });
    }

    if (Date.now() >= session.expiresAt) {
      return NextResponse.json({ error: "Session has expired" }, { status: 410 });
    }

    const used = sessionUsedBytes(session);
    const remaining = MAX_TRANSFER_BYTES - used;
    if (size > remaining) {
      return NextResponse.json(
        {
          error: "This transfer's 250 MB limit would be exceeded",
          usedBytes: used,
          remainingBytes: Math.max(0, remaining),
        },
        { status: 413 },
      );
    }

    // Determine TTL: if session is already locked, use its locked TTL; otherwise use requested or default
    const ttl = session.lockedTtl && session.ttlSeconds
      ? session.ttlSeconds
      : isValidTtl(expirySeconds)
      ? expirySeconds
      : DEFAULT_TTL_SECONDS;

    // Lock session expiry on first upload initiation
    const updatedSession = await lockSessionTtl(code, ttl);
    const effectiveExpiresAt = updatedSession?.expiresAt ?? session.expiresAt;
    const downloadSecondsRemaining = Math.max(60, Math.round((effectiveExpiresAt - Date.now()) / 1000));

    const objectKey = buildObjectKey(code, name);

    const [uploadUrl, downloadUrl] = await Promise.all([
      createPresignedPut(objectKey, 3600), // 1 hour upload window
      createPresignedGet(objectKey, name, downloadSecondsRemaining), // Scoped to exact session lifetime
    ]);

    return NextResponse.json({
      uploadUrl,
      downloadUrl,
      objectKey,
      expiresAt: effectiveExpiresAt,
    });
  } catch (error) {
    console.error("Presigned URL generation error:", error);
    return NextResponse.json({ error: (error as Error).message || "Internal server error" }, { status: 500 });
  }
}
