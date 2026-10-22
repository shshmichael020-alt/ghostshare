import { NextResponse } from "next/server";
import { getSession, remainingSecondsFromSession } from "@/lib/kv";

export async function GET(_req: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;

  if (!/^\d{8}$/.test(code)) {
    return NextResponse.json({ error: "Invalid code format" }, { status: 400 });
  }

  const session = await getSession(code);
  if (!session) {
    return NextResponse.json({ error: "Code not found or expired" }, { status: 404 });
  }

  const remainingSeconds = remainingSecondsFromSession(session);
  if (remainingSeconds <= 0) {
    return NextResponse.json({ error: "Code not found or expired" }, { status: 404 });
  }

  return NextResponse.json({ ...session, remainingSeconds });
}
