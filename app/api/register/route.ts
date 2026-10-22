import { NextResponse } from "next/server";
import { addFileToSession } from "@/lib/kv";
import { isValidTtl, DEFAULT_TTL_SECONDS } from "@/lib/constants";
import { verifyR2Object } from "@/lib/r2";
import { checkRateLimit, getClientIp } from "@/lib/rateLimit";

export async function POST(request: Request) {
  try {
    const ip = getClientIp(request);
    const rl = checkRateLimit("register_file", ip, 40, 60_000);
    if (!rl.success) {
      return NextResponse.json(
        { error: "Too many registration requests. Please wait a moment." },
        { status: 429, headers: { "Retry-After": String(rl.reset) } },
      );
    }

    const { code, objectKey, downloadUrl, name, size, expirySeconds } = (await request.json()) as {
      code?: string;
      objectKey?: string;
      downloadUrl?: string;
      name?: string;
      size?: number;
      expirySeconds?: number;
    };

    if (!code || !/^\d{8}$/.test(code)) {
      return NextResponse.json({ error: "Invalid session code" }, { status: 400 });
    }
    if (!objectKey || !downloadUrl || !name || typeof size !== "number" || size <= 0) {
      return NextResponse.json({ error: "All file metadata fields are required" }, { status: 400 });
    }

    // Ensure objectKey strictly belongs to this session code prefix to prevent cross-session association
    if (!objectKey.startsWith(`${code}/`)) {
      return NextResponse.json({ error: "Unauthorized object key for this session" }, { status: 403 });
    }

    // Verify object actually exists in R2 storage
    const verification = await verifyR2Object(objectKey);
    // In production with R2 credentials configured, verify existence:
    if (!verification.exists && process.env.NODE_ENV === "production") {
      return NextResponse.json({ error: "Object upload could not be verified in storage" }, { status: 400 });
    }

    const verifiedSize = verification.size ?? size;
    const ttl = isValidTtl(expirySeconds) ? expirySeconds : DEFAULT_TTL_SECONDS;

    const result = await addFileToSession(
      code,
      {
        objectKey,
        downloadUrl,
        name: name.slice(0, 255),
        size: verifiedSize,
        uploadedAt: Date.now(),
      },
      ttl,
    );

    if (!result.ok) {
      if (result.reason === "not_found") {
        return NextResponse.json({ error: "Session not found" }, { status: 404 });
      }
      if (result.reason === "expired") {
        return NextResponse.json({ error: "Session has expired" }, { status: 410 });
      }
      if (result.reason === "duplicate") {
        return NextResponse.json({ error: "File already registered in session" }, { status: 409 });
      }
      return NextResponse.json(
        {
          error: "This transfer's 250 MB limit would be exceeded",
          usedBytes: result.usedBytes,
          remainingBytes: result.remainingBytes,
        },
        { status: 413 },
      );
    }

    return NextResponse.json({
      ok: true,
      expiresAt: result.session.expiresAt,
      filesCount: result.session.files.length,
    });
  } catch (error) {
    console.error("Register file error:", error);
    return NextResponse.json({ error: (error as Error).message || "Internal server error" }, { status: 500 });
  }
}
