import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { pollSignalMessages, SignalingStorageNamespace } from "@/lib/signalStore";
import { checkRateLimit, getClientIp } from "@/lib/rateLimit";

export async function GET(request: Request) {
  const ip = getClientIp(request);
  const rl = checkRateLimit("signal_poll", ip, 360, 60_000);
  if (!rl.success) {
    return NextResponse.json(
      { error: "Too many polling requests. Throttled." },
      { status: 429, headers: { "Retry-After": String(rl.reset) } },
    );
  }

  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const role = searchParams.get("role") as "receiver" | "sender" | null;
  const sinceStr = searchParams.get("since");
  const since = sinceStr ? parseInt(sinceStr, 10) : 0;

  if (!code || !/^\d{8}$/.test(code) || (role !== "receiver" && role !== "sender") || isNaN(since) || since < 0) {
    return NextResponse.json({ error: "Missing or invalid query parameters" }, { status: 400 });
  }

  try {
    let binding: SignalingStorageNamespace | undefined;
    try {
      const ctx = getCloudflareContext();
      binding = (ctx?.env as Record<string, unknown>)?.SIGNALING_DO as SignalingStorageNamespace | undefined;
    } catch {}

    const messages = await pollSignalMessages(code, role, since, binding);
    return NextResponse.json(
      { messages },
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
