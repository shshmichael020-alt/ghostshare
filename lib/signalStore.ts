import { getCloudflareContext } from "@opennextjs/cloudflare";

export interface SignalMessage {
  id: string;
  sender: "receiver" | "sender";
  target: "receiver" | "sender";
  type: "offer" | "answer" | "candidate" | "candidate-batch" | "ping" | "leave";
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
  try {
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

    if (!Array.isArray(session.messages)) {
      session.messages = [];
    }
    session.messages.push(msg);

    // Keep message history small (max 50 signaling messages per session)
    if (session.messages.length > 50) {
      session.messages.splice(0, session.messages.length - 50);
    }

    localSessions.set(code, session);

    const kv = getKvBinding();
    if (kv) {
      try {
        const remainingSec =
          typeof session.expiresAt === "number"
            ? Math.round((session.expiresAt - Date.now()) / 1000)
            : 3600;
        const ttl = Math.max(60, isNaN(remainingSec) ? 3600 : remainingSec);
        await kv.put(`session:${code}`, JSON.stringify(session), { expirationTtl: ttl });
        // Dedicated mailbox for primary offer/answer handshake messages
        if (type === "offer" || type === "answer") {
          await kv.put(`sig:${code}:${target}`, JSON.stringify(msg), { expirationTtl: ttl });
        } else if (type === "candidate" || type === "candidate-batch") {
          // Store candidates in dedicated list without overwriting offer/answer
          const existingCands = (await kv.get<SignalMessage[]>(`cands:${code}:${target}`, "json")) || [];
          existingCands.push(msg);
          if (existingCands.length > 30) existingCands.splice(0, existingCands.length - 30);
          await kv.put(`cands:${code}:${target}`, JSON.stringify(existingCands), { expirationTtl: ttl });
        }
      } catch (err) {
        console.warn("KV post message error:", err);
      }
    }

    return true;
  } catch (err) {
    console.error("Critical error in postSignalMessage:", err);
    return false;
  }
}

export async function pollSignalMessages(
  code: string,
  forRole: "receiver" | "sender",
  sinceTimestamp: number,
): Promise<SignalMessage[]> {
  try {
    const session = await getSignalingSession(code);
    const foundMessages = new Map<string, SignalMessage>();

    if (session && Array.isArray(session.messages)) {
      for (const m of session.messages) {
        if (m && m.target === forRole && m.timestamp > sinceTimestamp) {
          foundMessages.set(m.id, m);
        }
      }
    }

    // Also check target role's dedicated mailbox in KV
    const kv = getKvBinding();
    if (kv) {
      try {
        const directMsg = await kv.get<SignalMessage>(`sig:${code}:${forRole}`, "json");
        if (directMsg && directMsg.timestamp > sinceTimestamp) {
          foundMessages.set(directMsg.id, directMsg);
        }
      } catch {
        // ignored
      }

      try {
        const directCands = await kv.get<SignalMessage[]>(`cands:${code}:${forRole}`, "json");
        if (Array.isArray(directCands)) {
          for (const c of directCands) {
            if (c && c.timestamp > sinceTimestamp) {
              foundMessages.set(c.id, c);
            }
          }
        }
      } catch {
        // ignored
      }
    }

    return Array.from(foundMessages.values()).sort((a, b) => a.timestamp - b.timestamp);
  } catch (err) {
    console.error("Critical error in pollSignalMessages:", err);
    return [];
  }
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
