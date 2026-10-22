import { NextResponse } from "next/server";
import { createSession } from "@/lib/kv";
import { generateUniqueCode } from "@/lib/codes";

export async function POST() {
  try {
    const code = await generateUniqueCode();
    const session = await createSession(code);
    return NextResponse.json({ code: session.code, createdAt: session.createdAt });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Could not create session" }, { status: 500 });
  }
}
