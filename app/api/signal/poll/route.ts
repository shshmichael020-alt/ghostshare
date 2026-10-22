import { NextResponse } from "next/server";
import { pollSignalMessages } from "@/lib/signalStore";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const role = searchParams.get("role") as "receiver" | "sender" | null;
  const sinceStr = searchParams.get("since");
  const since = sinceStr ? parseInt(sinceStr, 10) : 0;

  if (!code || !role || (role !== "receiver" && role !== "sender")) {
    return NextResponse.json({ error: "Missing or invalid query parameters" }, { status: 400 });
  }

  const messages = pollSignalMessages(code, role, since);
  return NextResponse.json({ messages });
}
