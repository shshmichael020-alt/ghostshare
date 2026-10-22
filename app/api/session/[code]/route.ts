import { NextResponse } from "next/server";
import { getSession, remainingSecondsFromSession } from "@/lib/kv";
import { checkRateLimit, getClientIp } from "@/lib/rateLimit";

export async function GET(request: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;

  if (!code || !/^\d{8}$/.test(code)) {
    return NextResponse.json({ error: "Invalid 8-digit code format" }, { status: 400 });
  }

  const ip = getClientIp(request);
  const rl = checkRateLimit("session_lookup", ip, 80, 60_000);
  if (!rl.success) {
    return NextResponse.json(
      { error: "Too many requests. Please wait a moment." },
      { status: 429, headers: { "Retry-After": String(rl.reset) } },
    );
  }

  const session = await getSession(code);
  if (!session) {
    return NextResponse.json({ error: "Code not found or expired" }, { status: 404 });
  }

  const remainingSeconds = remainingSecondsFromSession(session);
  if (remainingSeconds <= 0) {
    return NextResponse.json({ error: "Code not found or expired" }, { status: 404 });
  }

  return NextResponse.json({
    ...session,
    remainingSeconds,
  });
}
