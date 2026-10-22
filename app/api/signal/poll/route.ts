import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
  pollSignalMessages,
  checkCrossIsolateRateLimit,
  SignalingStorageNamespace,
} from "@/lib/signalStore";
import { getClientIp } from "@/lib/rateLimit";

function extractBearer(request: Request, queryToken?: string | null): string | undefined {
  if (queryToken && typeof queryToken === "string" && queryToken.trim().length > 0) {
    return queryToken.trim();
  }
  const auth = request.headers.get("authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  return undefined;
}

export async function GET(request: Request) {
  const ip = getClientIp(request);
  let binding: SignalingStorageNamespace | undefined;
  try {
    const ctx = getCloudflareContext();
    binding = (ctx?.env as Record<string, unknown>)?.SIGNALING_DO as SignalingStorageNamespace | undefined;
  } catch {}

  const rl = await checkCrossIsolateRateLimit("signal_poll", ip, 360, 60_000, binding);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many polling requests. Throttled." },
      { status: 429, headers: { "Retry-After": String(rl.reset) } },
    );
  }

  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const role = searchParams.get("role") as "receiver" | "sender" | null;
  const sinceStr = searchParams.get("since") || searchParams.get("sinceSeq");
  const sinceSeq = sinceStr ? parseInt(sinceStr, 10) : 0;
  const token = extractBearer(request, searchParams.get("token"));

  if (!code || !/^\d{8}$/.test(code) || (role !== "receiver" && role !== "sender") || isNaN(sinceSeq) || sinceSeq < 0) {
    return NextResponse.json({ error: "Missing or invalid query parameters" }, { status: 400 });
  }

  if (!token) {
    return NextResponse.json(
      { error: "Unauthorized: Missing participant capability token" },
      { status: 401 },
    );
  }

  try {
    const result = await pollSignalMessages(code, role, sinceSeq, token, binding);
    if (result.status !== 200) {
      return NextResponse.json(
        { error: result.error || "Failed to poll signal messages" },
        { status: result.status },
      );
    }

    return NextResponse.json(
      { messages: result.messages, cursor: result.cursor },
      {
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
          "CDN-Cache-Control": "no-store",
        },
      },
    );
  } catch (err) {
    console.error("Signal poll error:", err);
    return NextResponse.json(
      { error: "Failed to poll signal messages", details: (err as Error).message },
      { status: 503 },
    );
  }
}
