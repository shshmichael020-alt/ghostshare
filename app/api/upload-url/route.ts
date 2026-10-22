import { NextResponse } from "next/server";
import { getSession, sessionUsedBytes } from "@/lib/kv";
import { isValidTtl, DEFAULT_TTL_SECONDS, MAX_TRANSFER_BYTES } from "@/lib/constants";
import { buildObjectKey, createPresignedPut, createPresignedGet } from "@/lib/r2";

export async function POST(request: Request) {
  const { code, name, size, expirySeconds } = (await request.json()) as {
    code?: string;
    name?: string;
    size?: number;
    expirySeconds?: number;
  };

  if (!code || !/^\d{8}$/.test(code)) {
    return NextResponse.json({ error: "Invalid code" }, { status: 400 });
  }
  if (!name || typeof size !== "number" || size <= 0) {
    return NextResponse.json({ error: "Missing file info" }, { status: 400 });
  }

  const session = await getSession(code);
  if (!session) {
    return NextResponse.json({ error: "This code has expired or doesn't exist" }, { status: 404 });
  }

  const remaining = MAX_TRANSFER_BYTES - sessionUsedBytes(session);
  if (size > remaining) {
    return NextResponse.json(
      { error: "This transfer's 250 MB limit would be exceeded", remainingBytes: Math.max(0, remaining) },
      { status: 413 },
    );
  }

  const ttl = isValidTtl(expirySeconds) ? expirySeconds : DEFAULT_TTL_SECONDS;
  const objectKey = buildObjectKey(code, name);

  try {
    const [uploadUrl, downloadUrl] = await Promise.all([
      createPresignedPut(objectKey, 3600), // an hour is plenty of time to finish the upload itself
      createPresignedGet(objectKey, name, ttl), // valid for as long as the sender chose the file to live
    ]);

    return NextResponse.json({ uploadUrl, downloadUrl, objectKey });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
