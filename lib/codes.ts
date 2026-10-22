import { getSession } from "./kv";

function randomCode(): string {
  // 8-digit numeric code, zero-padded (00000000 - 99999999)
  const n = Math.floor(Math.random() * 100_000_000);
  return n.toString().padStart(8, "0");
}

export async function generateUniqueCode(): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = randomCode();
    const existing = await getSession(code);
    if (!existing) return code;
  }
  // astronomically unlikely, but don't loop forever
  throw new Error("Could not generate a unique code, try again");
}
