import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
  postSignalMessage,
  checkCrossIsolateRateLimit,
  SignalingStorageNamespace,
  SignalMessage,
} from "@/lib/signalStore";
import { getClientIp } from "@/lib/rateLimit";

const ALLOWED_TYPES = new Set<SignalMessage["type"]>([
  "offer",
  "answer",
  "candidate",
  "candidate-batch",
  "ping",
  "leave",
]);

const MAX_PAYLOAD_BYTES = 64 * 1024; // 64 KB max payload size for signaling JSON

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

export async function POST(request: Request) {
  try {
    let binding: SignalingStorageNamespace | undefined;
    try {
      const ctx = getCloudflareContext();
      binding = (ctx?.env as Record<string, unknown>)?.SIGNALING_DO as SignalingStorageNamespace | undefined;
    } catch {}

    const ip = getClientIp(request);
    const rl = await checkCrossIsolateRateLimit("signal_post", ip, 240, 60_000, binding);
    if (!rl.allowed) {
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
      token?: unknown;
    };
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      return NextResponse.json({ error: "Invalid JSON format" }, { status: 400 });
    }

    const { code, sender, target, type, data } = parsed;
    const token = extractBearer(request, typeof parsed.token === "string" ? parsed.token : undefined);

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

    if (!token) {
      return NextResponse.json(
        { error: "Unauthorized: Missing participant capability token" },
        { status: 401 },
      );
    }

    const result = await postSignalMessage(
      code,
      sender as "receiver" | "sender",
      target as "receiver" | "sender",
      type as SignalMessage["type"],
      data,
      token,
      binding,
    );

    if (!result.ok) {
      return NextResponse.json({ error: result.error || "Failed to post message" }, { status: result.status });
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
