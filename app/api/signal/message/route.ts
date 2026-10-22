import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { postSignalMessage } from "@/lib/signalStore";

export async function POST(request: Request) {
  try {
    try {
      const ctx = getCloudflareContext();
      const kv = (ctx?.env as Record<string, unknown>)?.SESSIONS_KV as KVNamespace | undefined;
      if (kv) {
        (globalThis as unknown as Record<string, unknown>).__SESSIONS_KV__ = kv;
      }
    } catch {}

    const { code, sender, target, type, data } = (await request.json()) as {
      code?: string;
      sender?: "receiver" | "sender";
      target?: "receiver" | "sender";
      type?: "offer" | "answer" | "candidate" | "candidate-batch" | "ping" | "leave";
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
    return NextResponse.json({ error: "Failed to queue signal message", details: (err as Error).message || String(err) }, { status: 500 });
  }
}
