import { getCloudflareContext } from "@opennextjs/cloudflare";
import { DEFAULT_TTL_SECONDS, MAX_TRANSFER_BYTES } from "./constants";

export { EXPIRY_OPTIONS, DEFAULT_TTL_SECONDS, MAX_TTL_SECONDS, MAX_TRANSFER_BYTES, isValidTtl } from "./constants";

export type StoredFile = {
  objectKey: string;
  downloadUrl: string;
  name: string;
  size: number;
  uploadedAt: number;
};

export type Session = {
  code: string;
  createdAt: number;
  expiresAt: number;
  files: StoredFile[];
};

const SESSION_PREFIX = "session:";

async function getKv() {
  const { env } = await getCloudflareContext({ async: true });
  const kv = (env as Record<string, KVNamespace | undefined>).SESSIONS_KV;
  if (!kv) throw new Error("SESSIONS_KV binding not found - check wrangler.jsonc and your Cloudflare dashboard");
  return kv;
}

function sessionKey(code: string) {
  return `${SESSION_PREFIX}${code}`;
}

export async function getSession(code: string): Promise<Session | null> {
  const kv = await getKv();
  const data = await kv.get<Session>(sessionKey(code), "json");
  return data ?? null;
}

export function sessionUsedBytes(session: Session): number {
  return session.files.reduce((sum, f) => sum + f.size, 0);
}

// We store our own expiresAt timestamp because Workers KV doesn't expose a
// "TTL remaining" read the way Redis does - this is the source of truth the
// Receive panel's countdown is computed from.
export function remainingSecondsFromSession(session: Session): number {
  return Math.max(0, Math.round((session.expiresAt - Date.now()) / 1000));
}

export async function createSession(code: string): Promise<Session> {
  const kv = await getKv();
  const session: Session = {
    code,
    createdAt: Date.now(),
    expiresAt: Date.now() + DEFAULT_TTL_SECONDS * 1000,
    files: [],
  };
  // Cloudflare KV requires a minimum expirationTtl of 60 seconds (our
  // smallest expiry option is 30 min, so we're always well above that).
  await kv.put(sessionKey(code), JSON.stringify(session), { expirationTtl: DEFAULT_TTL_SECONDS });
  return session;
}

export type AddFileResult =
  | { ok: true; session: Session }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "over_limit"; usedBytes: number; remainingBytes: number };

export async function addFileToSession(
  code: string,
  file: StoredFile,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): Promise<AddFileResult> {
  const kv = await getKv();
  const session = await getSession(code);
  if (!session) return { ok: false, reason: "not_found" };

  const usedBytes = sessionUsedBytes(session);
  const remainingBytes = MAX_TRANSFER_BYTES - usedBytes;
  if (file.size > remainingBytes) {
    return { ok: false, reason: "over_limit", usedBytes, remainingBytes };
  }

  session.files.push(file);
  session.expiresAt = Date.now() + ttlSeconds * 1000;
  // Re-setting the TTL here (re)starts the countdown from the moment of
  // upload, so "3 hours" means 3 hours from when the file arrived.
  await kv.put(sessionKey(code), JSON.stringify(session), { expirationTtl: ttlSeconds });
  return { ok: true, session };
}
