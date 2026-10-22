import { NextResponse } from "next/server";
import { createSession } from "@/lib/kv";
import { generateUniqueCode } from "@/lib/codes";
import { checkRateLimit, getClientIp } from "@/lib/rateLimit";

export async function POST(request: Request) {
  try {
    const ip = getClientIp(request);
    const rl = checkRateLimit("session_create", ip, 15, 60_000);
    if (!rl.success) {
      return NextResponse.json(
        { error: "Too many session creation requests. Please wait a moment." },
        { status: 429, headers: { "Retry-After": String(rl.reset) } },
      );
    }

    const code = await generateUniqueCode();
    const session = await createSession(code);

    return NextResponse.json({
      code: session.code,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
    });
  } catch (err) {
    console.error("Session creation error:", err);
    return NextResponse.json({ error: "Could not create session" }, { status: 500 });
  }
}
