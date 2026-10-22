import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { postSignalMessage, SignalingStorageNamespace, SignalMessage } from "@/lib/signalStore";
import { checkRateLimit, getClientIp } from "@/lib/rateLimit";

const ALLOWED_TYPES = new Set<SignalMessage["type"]>([
  "offer",
  "answer",
  "candidate",
  "candidate-batch",
  "ping",
  "leave",
]);

const MAX_PAYLOAD_BYTES = 64 * 1024; // 64 KB max payload size for signaling JSON

export async function POST(request: Request) {
  try {
    let binding: SignalingStorageNamespace | undefined;
    try {
      const ctx = getCloudflareContext();
      binding = (ctx?.env as Record<string, unknown>)?.SIGNALING_DO as SignalingStorageNamespace | undefined;
    } catch {}

    const ip = getClientIp(request);
    const rl = checkRateLimit("signal_post", ip, 240, 60_000);
    if (!rl.success) {
      return NextResponse.json(
        { error: "Too many signaling messages. Throttled." },
        { status: 429, headers: { "Retry-After": String(rl.reset) } },
      );
    }

    const bodyText = await request.text();
    if (bodyText.length > MAX_PAYLOAD_BYTES) {
      return NextResponse.json({ error: "Payload exceeds maximum allowed signaling size (64 KB)" }, { status: 413 });
    }

    let parsed: {
      code?: unknown;
      sender?: unknown;
      target?: unknown;
      type?: unknown;
      data?: unknown;
    };
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      return NextResponse.json({ error: "Invalid JSON format" }, { status: 400 });
    }

    const { code, sender, target, type, data } = parsed;

    if (
      typeof code !== "string" ||
      !/^\d{8}$/.test(code) ||
      (sender !== "receiver" && sender !== "sender") ||
      (target !== "receiver" && target !== "sender") ||
      typeof type !== "string" ||
      !ALLOWED_TYPES.has(type as SignalMessage["type"])
    ) {
      return NextResponse.json({ error: "Malformed signal message parameters" }, { status: 400 });
    }

    const posted = await postSignalMessage(
      code,
      sender as "receiver" | "sender",
      target as "receiver" | "sender",
      type as SignalMessage["type"],
      data,
      binding,
    );

    if (!posted) {
      return NextResponse.json({ error: "Session not found or expired" }, { status: 404 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("Signal message error:", err);
    return NextResponse.json(
      { error: "Failed to queue signal message", details: (err as Error).message },
      { status: 503 },
    );
  }
}
