import { getSignalingSession } from "./signalStore";

/**
 * Generates an unbiased cryptographically secure 8-digit numeric pairing code (00000000 - 99999999).
 * Uses Web Crypto API with rejection sampling to eliminate modulo bias.
 */
export function generateSecureCode(): string {
  const maxUnbiased = 4_200_000_000; // Largest multiple of 100_000_000 in 32-bit uint
  const buffer = new Uint32Array(1);

  while (true) {
    crypto.getRandomValues(buffer);
    const value = buffer[0];
    if (value < maxUnbiased) {
      const codeNum = value % 100_000_000;
      return codeNum.toString().padStart(8, "0");
    }
  }
}

export async function generateUniqueCode(explicitStorage?: unknown): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = generateSecureCode();
    try {
      const existing = await getSignalingSession(code, explicitStorage);
      if (!existing) return code;
    } catch {
      // If store check returned not found or non-fatal, proceed
      return code;
    }
  }
  throw new Error("Could not generate a unique pairing code, please retry");
}
