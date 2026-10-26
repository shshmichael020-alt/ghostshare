/**
 * Constant-time string comparison to prevent timing side-channel attacks on capability tokens.
 */
export function timingSafeEqualStr(a: string | null | undefined, b: string | null | undefined): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const enc = new TextEncoder();
  const bufA = enc.encode(a);
  const bufB = enc.encode(b);

  if (bufA.byteLength !== bufB.byteLength) {
    let dummy = 0;
    for (let i = 0; i < bufA.byteLength; i++) {
      dummy |= bufA[i] ^ bufA[i];
    }
    if (dummy !== 0) return false;
    return false;
  }

  let mismatch = 0;
  for (let i = 0; i < bufA.byteLength; i++) {
    mismatch |= bufA[i] ^ bufB[i];
  }
  return mismatch === 0;
}
