import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
  postSignalMessage,
  checkCrossIsolateRateLimit,
  SignalingStorageNamespace,
  SignalMessage,
} from "@/lib/signalStore";
import { getClientIp, isAllowedOrigin } from "@/lib/rateLimit";
import { readBoundedJson, MAX_SIGNALING_PAYLOAD_BYTES, safeErrorResponse } from "@/lib/requestBody";

const ALLOWED_TYPES = new Set<SignalMessage["type"]>([
  "offer",
  "answer",
  "candidate",
  "candidate-batch",
  "ping",
  "leave",
]);

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
    const origin = request.headers.get("origin");
    if (!isAllowedOrigin(origin, request.url)) {
      return NextResponse.json({ error: "Forbidden: Untrusted cross-origin request" }, { status: 403 });
    }

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

    const bodyResult = await readBoundedJson<{
      code?: unknown;
      sender?: unknown;
      target?: unknown;
      type?: unknown;
      data?: unknown;
      token?: unknown;
    }>(request, MAX_SIGNALING_PAYLOAD_BYTES);

    if (!bodyResult.ok) {
      return NextResponse.json({ error: bodyResult.error }, { status: bodyResult.status });
    }
    if (!bodyResult.data) {
      return NextResponse.json({ error: "Malformed signal message parameters" }, { status: 400 });
    }

    const { code, sender, target, type, data } = bodyResult.data;
    const token = extractBearer(request, typeof bodyResult.data.token === "string" ? bodyResult.data.token : undefined);

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
    return safeErrorResponse("Failed to queue signal message", 503, "signal_post", err);
  }
}
