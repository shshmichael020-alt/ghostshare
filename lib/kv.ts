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
  lockedTtl?: boolean;
  ttlSeconds?: number;
};

const SESSION_PREFIX = "session:";

export async function getKv() {
  const { env } = await getCloudflareContext({ async: true });
  const kv = (env as Record<string, KVNamespace | undefined>).SESSIONS_KV;
  if (!kv) {
    throw new Error("SESSIONS_KV binding not found — check wrangler.jsonc and your Cloudflare dashboard");
  }
  return kv;
}

export function sessionKey(code: string) {
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
    lockedTtl: false,
    ttlSeconds: DEFAULT_TTL_SECONDS,
  };
  await kv.put(sessionKey(code), JSON.stringify(session), { expirationTtl: DEFAULT_TTL_SECONDS });
  return session;
}

/**
 * Locks the session TTL on upload initiation so countdown is fixed and options cannot be changed.
 */
export async function lockSessionTtl(code: string, ttlSeconds: number): Promise<Session | null> {
  const kv = await getKv();
  const session = await getSession(code);
  if (!session) return null;

  if (!session.lockedTtl) {
    session.lockedTtl = true;
    session.ttlSeconds = ttlSeconds;
    session.expiresAt = Date.now() + ttlSeconds * 1000;
    const ttlRemaining = Math.max(60, ttlSeconds);
    await kv.put(sessionKey(code), JSON.stringify(session), { expirationTtl: ttlRemaining });
  }

  return session;
}

export type AddFileResult =
  | { ok: true; session: Session }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "expired" }
  | { ok: false; reason: "duplicate" }
  | { ok: false; reason: "over_limit"; usedBytes: number; remainingBytes: number };

export async function addFileToSession(
  code: string,
  file: StoredFile,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): Promise<AddFileResult> {
  const kv = await getKv();
  const session = await getSession(code);
  if (!session) return { ok: false, reason: "not_found" };

  // Check if session already expired
  if (Date.now() >= session.expiresAt) {
    return { ok: false, reason: "expired" };
  }

  // Prevent duplicate file registration
  if (session.files.some((f) => f.objectKey === file.objectKey)) {
    return { ok: false, reason: "duplicate" };
  }

  const usedBytes = sessionUsedBytes(session);
  const remainingBytes = MAX_TRANSFER_BYTES - usedBytes;
  if (file.size > remainingBytes) {
    return { ok: false, reason: "over_limit", usedBytes, remainingBytes };
  }

  session.files.push(file);

  // If session TTL was not already locked, lock it with the chosen TTL
  if (!session.lockedTtl) {
    session.lockedTtl = true;
    session.ttlSeconds = ttlSeconds;
    session.expiresAt = Date.now() + ttlSeconds * 1000;
  }

  // Preserve existing expiry window - do not reset countdown on subsequent uploads
  const ttlRemaining = Math.max(60, Math.round((session.expiresAt - Date.now()) / 1000));
  await kv.put(sessionKey(code), JSON.stringify(session), { expirationTtl: ttlRemaining });

  return { ok: true, session };
}
