import { NextResponse } from "next/server";
import { addFileToSession } from "@/lib/kv";
import { isValidTtl, DEFAULT_TTL_SECONDS } from "@/lib/constants";

export async function POST(request: Request) {
  const { code, objectKey, downloadUrl, name, size, expirySeconds } = (await request.json()) as {
    code?: string;
    objectKey?: string;
    downloadUrl?: string;
    name?: string;
    size?: number;
    expirySeconds?: number;
  };

  if (!code || !objectKey || !downloadUrl || !name || typeof size !== "number") {
    return NextResponse.json({ error: "Missing fields" }, { status: 400 });
  }
  if (!/^\d{8}$/.test(code)) {
    return NextResponse.json({ error: "Invalid code" }, { status: 400 });
  }

  const ttl = isValidTtl(expirySeconds) ? expirySeconds : DEFAULT_TTL_SECONDS;

  const result = await addFileToSession(
    code,
    { objectKey, downloadUrl, name, size, uploadedAt: Date.now() },
    ttl,
  );

  if (!result.ok) {
    if (result.reason === "not_found") {
      return NextResponse.json({ error: "Session not found or expired" }, { status: 404 });
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

  return NextResponse.json({ ok: true, expiresAt: result.session.expiresAt });
}
