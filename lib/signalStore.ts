import { getCloudflareContext } from "@opennextjs/cloudflare";

export interface SignalMessage {
  id: string;
  sender: "receiver" | "sender";
  target: "receiver" | "sender";
  type: "offer" | "answer" | "candidate" | "ping" | "leave";
  data: unknown;
  timestamp: number;
}

export interface SignalingSession {
  code: string;
  createdAt: number;
  expiresAt: number;
  receiverActive: boolean;
  senderActive: boolean;
  messages: SignalMessage[];
}

// In-memory fallback and L1 cache
const localSessions = new Map<string, SignalingSession>();

export const DEFAULT_SESSION_TTL_SECONDS = 3600; // 1 hour default pairing window

function getKvBinding(): KVNamespace | null {
  try {
    const ctx = getCloudflareContext();
    return (ctx?.env as { SESSIONS_KV?: KVNamespace })?.SESSIONS_KV ?? null;
  } catch {
    return null;
  }
}

export async function createSignalingSession(
  code: string,
  ttlSeconds: number = DEFAULT_SESSION_TTL_SECONDS,
): Promise<SignalingSession> {
  const now = Date.now();
  const session: SignalingSession = {
    code,
    createdAt: now,
    expiresAt: now + ttlSeconds * 1000,
    receiverActive: true,
    senderActive: false,
    messages: [],
  };

  localSessions.set(code, session);

  const kv = getKvBinding();
  if (kv) {
    try {
      await kv.put(`session:${code}`, JSON.stringify(session), {
        expirationTtl: Math.max(60, ttlSeconds),
      });
    } catch (err) {
      console.warn("KV put session error:", err);
    }
  }

  return session;
}

export async function getSignalingSession(code: string): Promise<SignalingSession | null> {
  const kv = getKvBinding();
  if (kv) {
    try {
      const data = await kv.get<SignalingSession>(`session:${code}`, "json");
      if (data) {
        if (Date.now() > data.expiresAt) {
          await kv.delete(`session:${code}`);
          localSessions.delete(code);
          return null;
        }
        localSessions.set(code, data);
        return data;
      }
    } catch (err) {
      console.warn("KV get session error:", err);
    }
  }

  const session = localSessions.get(code);
  if (!session) return null;

  if (Date.now() > session.expiresAt) {
    localSessions.delete(code);
    return null;
  }
  return session;
}

export async function joinSignalingSession(code: string): Promise<boolean> {
  const session = await getSignalingSession(code);
  if (!session) return false;

  session.senderActive = true;
  localSessions.set(code, session);

  const kv = getKvBinding();
  if (kv) {
    try {
      const ttl = Math.max(60, Math.round((session.expiresAt - Date.now()) / 1000));
      await kv.put(`session:${code}`, JSON.stringify(session), { expirationTtl: ttl });
    } catch (err) {
      console.warn("KV join update error:", err);
    }
  }

  return true;
}

export async function updateSessionTtl(code: string, ttlSeconds: number): Promise<boolean> {
  const session = await getSignalingSession(code);
  if (!session) return false;

  session.expiresAt = session.createdAt + ttlSeconds * 1000;
  localSessions.set(code, session);

  const kv = getKvBinding();
  if (kv) {
    try {
      await kv.put(`session:${code}`, JSON.stringify(session), {
        expirationTtl: Math.max(60, ttlSeconds),
      });
    } catch (err) {
      console.warn("KV update TTL error:", err);
    }
  }

  return true;
}

export async function postSignalMessage(
  code: string,
  sender: "receiver" | "sender",
  target: "receiver" | "sender",
  type: SignalMessage["type"],
  data: unknown,
): Promise<boolean> {
  const session = await getSignalingSession(code);
  if (!session) return false;

  const msg: SignalMessage = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    sender,
    target,
    type,
    data,
    timestamp: Date.now(),
  };

  session.messages.push(msg);

  // Keep message history small (max 50 signaling messages per session)
  if (session.messages.length > 50) {
    session.messages.splice(0, session.messages.length - 50);
  }

  localSessions.set(code, session);

  const kv = getKvBinding();
  if (kv) {
    try {
      const ttl = Math.max(60, Math.round((session.expiresAt - Date.now()) / 1000));
      await kv.put(`session:${code}`, JSON.stringify(session), { expirationTtl: ttl });
    } catch (err) {
      console.warn("KV post message error:", err);
    }
  }

  return true;
}

export async function pollSignalMessages(
  code: string,
  forRole: "receiver" | "sender",
  sinceTimestamp: number,
): Promise<SignalMessage[]> {
  const session = await getSignalingSession(code);
  if (!session) return [];

  return session.messages.filter(
    (m) => m.target === forRole && m.timestamp > sinceTimestamp,
  );
}

export async function closeSignalingSession(code: string): Promise<void> {
  localSessions.delete(code);
  const kv = getKvBinding();
  if (kv) {
    try {
      await kv.delete(`session:${code}`);
    } catch {
      // ignore
    }
  }
}
