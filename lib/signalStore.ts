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

// In-memory session store (shared per runtime instance / isolate)
const sessions = new Map<string, SignalingSession>();

export const DEFAULT_SESSION_TTL_SECONDS = 3600; // 1 hour default pairing & transfer window

export function createSignalingSession(code: string, ttlSeconds: number = DEFAULT_SESSION_TTL_SECONDS): SignalingSession {
  const now = Date.now();
  const session: SignalingSession = {
    code,
    createdAt: now,
    expiresAt: now + ttlSeconds * 1000,
    receiverActive: true,
    senderActive: false,
    messages: [],
  };
  sessions.set(code, session);
  return session;
}

export function updateSessionTtl(code: string, ttlSeconds: number): boolean {
  const session = getSignalingSession(code);
  if (!session) return false;
  session.expiresAt = session.createdAt + ttlSeconds * 1000;
  return true;
}

export function getSignalingSession(code: string): SignalingSession | null {
  const session = sessions.get(code);
  if (!session) return null;

  if (Date.now() > session.expiresAt) {
    sessions.delete(code);
    return null;
  }
  return session;
}

export function joinSignalingSession(code: string): boolean {
  const session = getSignalingSession(code);
  if (!session) return false;
  session.senderActive = true;
  return true;
}

export function postSignalMessage(
  code: string,
  sender: "receiver" | "sender",
  target: "receiver" | "sender",
  type: SignalMessage["type"],
  data: unknown,
): boolean {
  const session = getSignalingSession(code);
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

  return true;
}

export function pollSignalMessages(
  code: string,
  forRole: "receiver" | "sender",
  sinceTimestamp: number,
): SignalMessage[] {
  const session = getSignalingSession(code);
  if (!session) return [];

  return session.messages.filter(
    (m) => m.target === forRole && m.timestamp > sinceTimestamp,
  );
}

export function closeSignalingSession(code: string): void {
  sessions.delete(code);
}
