import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { pollSignalMessages } from "@/lib/signalStore";

export async function GET(request: Request) {
  try {
    const ctx = getCloudflareContext();
    const kv = (ctx?.env as Record<string, unknown>)?.SESSIONS_KV as KVNamespace | undefined;
    if (kv) {
      (globalThis as unknown as Record<string, unknown>).__SESSIONS_KV__ = kv;
    }
  } catch {}

  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const role = searchParams.get("role") as "receiver" | "sender" | null;
  const sinceStr = searchParams.get("since");
  const since = sinceStr ? parseInt(sinceStr, 10) : 0;

  if (!code || !role || (role !== "receiver" && role !== "sender")) {
    return NextResponse.json({ error: "Missing or invalid query parameters" }, { status: 400 });
  }

  const messages = await pollSignalMessages(code, role, since);
  return NextResponse.json({ messages });
}
