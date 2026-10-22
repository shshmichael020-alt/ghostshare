import { NextResponse } from "next/server";
import { postSignalMessage } from "@/lib/signalStore";

export async function POST(request: Request) {
  try {
    const { code, sender, target, type, data } = (await request.json()) as {
      code?: string;
      sender?: "receiver" | "sender";
      target?: "receiver" | "sender";
      type?: "offer" | "answer" | "candidate" | "ping" | "leave";
      data?: unknown;
    };

    if (!code || !sender || !target || !type) {
      return NextResponse.json({ error: "Missing required signal parameters" }, { status: 400 });
    }

    const posted = await postSignalMessage(code, sender, target, type, data);
    if (!posted) {
      return NextResponse.json({ error: "Session not found or expired" }, { status: 404 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("Signal message error:", err);
    return NextResponse.json({ error: "Failed to queue signal message" }, { status: 500 });
  }
}
