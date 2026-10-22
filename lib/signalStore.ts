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
  remainingSeconds?: number;
  receiverActive: boolean;
  senderActive: boolean;
  receiverToken?: string;
}

export interface SignalingStorageStub {
  fetch(request: Request): Promise<Response>;
}

export interface SignalingStorageNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): SignalingStorageStub;
}

export const DEFAULT_SESSION_TTL_SECONDS = 3600; // 1 hour default pairing window

// Optional test adapter for Node unit tests
let testStorageNamespace: SignalingStorageNamespace | null = null;

export function setTestStorageNamespace(ns: SignalingStorageNamespace | null): void {
  testStorageNamespace = ns;
}

/**
 * Resolves the authoritative storage binding from the current request context.
 * In production, this resolves the SQLite-backed Durable Object namespace.
 * Fails closed if the binding is absent.
 */
export function resolveStorageBinding(explicitBinding?: unknown): SignalingStorageNamespace {
  if (explicitBinding && typeof (explicitBinding as SignalingStorageNamespace).idFromName === "function") {
    return explicitBinding as SignalingStorageNamespace;
  }

  if (testStorageNamespace) {
    return testStorageNamespace;
  }

  try {
    const ctx = getCloudflareContext();
    const binding = (ctx?.env as Record<string, unknown>)?.SIGNALING_DO as SignalingStorageNamespace | undefined;
    if (binding && typeof binding.idFromName === "function") {
      return binding;
    }
  } catch {}

  const g = globalThis as unknown as Record<string, unknown>;
  const globalBinding = (g.SIGNALING_DO || (g.__env__ as Record<string, unknown> | undefined)?.SIGNALING_DO) as
    | SignalingStorageNamespace
    | undefined;
  if (globalBinding && typeof globalBinding.idFromName === "function") {
    return globalBinding;
  }

  // Fallback for Node test runner when no test adapter was registered yet
  if (process.env.NODE_ENV === "test") {
    const inMemoryTestStore = createInMemoryTestNamespace();
    testStorageNamespace = inMemoryTestStore;
    return inMemoryTestStore;
  }

  throw new Error("Authoritative signaling storage binding (SIGNALING_DO) is unavailable");
}

function getSessionStub(storage: SignalingStorageNamespace, code: string): SignalingStorageStub {
  const id = storage.idFromName(code);
  return storage.get(id);
}

/**
 * Generates a high-entropy CSPRNG receiver token for authorized session control.
 */
export function generateReceiverToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Creates an authoritative signaling session.
 * Fails closed: if the storage write fails, throws an error.
 */
export async function createSignalingSession(
  code: string,
  ttlSeconds: number = DEFAULT_SESSION_TTL_SECONDS,
  explicitStorage?: unknown,
): Promise<{ session: SignalingSession; receiverToken: string }> {
  const storage = resolveStorageBinding(explicitStorage);
  const stub = getSessionStub(storage, code);
  const receiverToken = generateReceiverToken();

  const res = await stub.fetch(
    new Request("https://internal/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, ttlSeconds, receiverToken }),
    }),
  );

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Failed to create authoritative session (status ${res.status}): ${errBody}`);
  }

  const session = (await res.json()) as SignalingSession;
  return { session, receiverToken };
}

/**
 * Retrieves an active signaling session.
 * Returns null if not found or expired.
 * Throws if the authoritative store is unreachable.
 */
export async function getSignalingSession(
  code: string,
  explicitStorage?: unknown,
): Promise<SignalingSession | null> {
  const storage = resolveStorageBinding(explicitStorage);
  const stub = getSessionStub(storage, code);

  const res = await stub.fetch(new Request("https://internal/get", { method: "GET" }));
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Failed to get session from authoritative store (status ${res.status}): ${errBody}`);
  }

  return (await res.json()) as SignalingSession;
}

/**
 * Sender joins an existing session.
 * Returns true if successfully joined, false if session not found or expired.
 */
export async function joinSignalingSession(code: string, explicitStorage?: unknown): Promise<boolean> {
  const storage = resolveStorageBinding(explicitStorage);
  const stub = getSessionStub(storage, code);

  const res = await stub.fetch(new Request("https://internal/join", { method: "POST" }));
  if (res.status === 404) {
    return false;
  }
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Failed to join session (status ${res.status}): ${errBody}`);
  }

  return true;
}

/**
 * Updates the session TTL. Requires valid receiverToken.
 * Throws 403 on invalid token or if authoritative store write fails.
 */
export async function updateSessionTtl(
  code: string,
  ttlSeconds: number,
  receiverToken: string,
  explicitStorage?: unknown,
): Promise<{ ok: boolean; expiresAt?: number; remainingSeconds?: number }> {
  const storage = resolveStorageBinding(explicitStorage);
  const stub = getSessionStub(storage, code);

  const res = await stub.fetch(
    new Request("https://internal/update-ttl", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ttlSeconds, receiverToken }),
    }),
  );

  if (res.status === 404) {
    return { ok: false };
  }
  if (res.status === 403) {
    throw new Error("Unauthorized: Invalid receiver token");
  }
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Failed to update session TTL (status ${res.status}): ${errBody}`);
  }

  return (await res.json()) as { ok: boolean; expiresAt: number; remainingSeconds: number };
}

/**
 * Posts a signaling message to the session's authoritative queue.
 * Throws if the message could not be persisted.
 */
export async function postSignalMessage(
  code: string,
  sender: "receiver" | "sender",
  target: "receiver" | "sender",
  type: SignalMessage["type"],
  data: unknown,
  explicitStorage?: unknown,
): Promise<boolean> {
  const storage = resolveStorageBinding(explicitStorage);
  const stub = getSessionStub(storage, code);

  const res = await stub.fetch(
    new Request("https://internal/post-message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender, target, type, data }),
    }),
  );

  if (res.status === 404) {
    return false;
  }
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Failed to post signal message (status ${res.status}): ${errBody}`);
  }

  return true;
}

/**
 * Polls for new signaling messages destined for a given role since a timestamp.
 */
export async function pollSignalMessages(
  code: string,
  forRole: "receiver" | "sender",
  sinceTimestamp: number,
  explicitStorage?: unknown,
): Promise<SignalMessage[]> {
  const storage = resolveStorageBinding(explicitStorage);
  const stub = getSessionStub(storage, code);

  const url = `https://internal/poll?target=${encodeURIComponent(forRole)}&since=${sinceTimestamp}`;
  const res = await stub.fetch(new Request(url, { method: "GET" }));

  if (res.status === 404) {
    return [];
  }
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Failed to poll signal messages (status ${res.status}): ${errBody}`);
  }

  const json = (await res.json()) as { messages: SignalMessage[] };
  return json.messages || [];
}

/**
 * Closes and purges an active signaling session.
 */
export async function closeSignalingSession(
  code: string,
  receiverToken?: string,
  explicitStorage?: unknown,
): Promise<boolean> {
  try {
    const storage = resolveStorageBinding(explicitStorage);
    const stub = getSessionStub(storage, code);

    const res = await stub.fetch(
      new Request("https://internal/close", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ receiverToken }),
      }),
    );
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * In-memory test store implementation for isolated unit testing.
 * Simulates SQLite Durable Object behavior without workerd.
 */
export function createInMemoryTestNamespace(): SignalingStorageNamespace {
  interface InMemorySession {
    code: string;
    createdAt: number;
    expiresAt: number;
    receiverActive: boolean;
    senderActive: boolean;
    receiverToken: string;
    messages: SignalMessage[];
  }

  const sessions = new Map<string, InMemorySession>();

  return {
    idFromName(name: string) {
      return name;
    },
    get(id: unknown): SignalingStorageStub {
      const code = String(id);

      return {
        async fetch(request: Request): Promise<Response> {
          const url = new URL(request.url);
          const path = url.pathname;

          if (request.method === "POST" && path === "/create") {
            const body = (await request.json()) as {
              code: string;
              ttlSeconds: number;
              receiverToken: string;
            };
            const now = Date.now();
            const existing = sessions.get(body.code);
            if (existing && existing.expiresAt > now) {
              return new Response(JSON.stringify({ error: "Session code collision" }), { status: 409 });
            }
            const session: InMemorySession = {
              code: body.code,
              createdAt: now,
              expiresAt: now + body.ttlSeconds * 1000,
              receiverActive: true,
              senderActive: false,
              receiverToken: body.receiverToken,
              messages: [],
            };
            sessions.set(body.code, session);
            return new Response(JSON.stringify(session), { status: 200 });
          }

          if (request.method === "GET" && path === "/get") {
            const s = sessions.get(code);
            if (!s) return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
            if (Date.now() > s.expiresAt) {
              sessions.delete(code);
              return new Response(JSON.stringify({ error: "Expired" }), { status: 404 });
            }
            return new Response(
              JSON.stringify({
                code: s.code,
                createdAt: s.createdAt,
                expiresAt: s.expiresAt,
                remainingSeconds: Math.max(0, Math.round((s.expiresAt - Date.now()) / 1000)),
                receiverActive: s.receiverActive,
                senderActive: s.senderActive,
              }),
              { status: 200 },
            );
          }

          if (request.method === "POST" && path === "/join") {
            const s = sessions.get(code);
            if (!s) return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
            if (Date.now() > s.expiresAt) {
              sessions.delete(code);
              return new Response(JSON.stringify({ error: "Expired" }), { status: 404 });
            }
            s.senderActive = true;
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
          }

          if (request.method === "POST" && path === "/update-ttl") {
            const body = (await request.json()) as { ttlSeconds: number; receiverToken: string };
            const s = sessions.get(code);
            if (!s) return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
            if (Date.now() > s.expiresAt) {
              sessions.delete(code);
              return new Response(JSON.stringify({ error: "Expired" }), { status: 404 });
            }
            if (s.receiverToken !== body.receiverToken) {
              return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 403 });
            }
            s.expiresAt = s.createdAt + body.ttlSeconds * 1000;
            return new Response(
              JSON.stringify({
                ok: true,
                expiresAt: s.expiresAt,
                remainingSeconds: Math.max(0, Math.round((s.expiresAt - Date.now()) / 1000)),
              }),
              { status: 200 },
            );
          }

          if (request.method === "POST" && path === "/post-message") {
            const s = sessions.get(code);
            if (!s || Date.now() > s.expiresAt) {
              return new Response(JSON.stringify({ error: "Not found or expired" }), { status: 404 });
            }
            const body = (await request.json()) as {
              sender: "receiver" | "sender";
              target: "receiver" | "sender";
              type: SignalMessage["type"];
              data: unknown;
            };
            const msg: SignalMessage = {
              id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              sender: body.sender,
              target: body.target,
              type: body.type,
              data: body.data,
              timestamp: Date.now(),
            };
            s.messages.push(msg);
            if (s.messages.length > 100) s.messages.shift();
            return new Response(JSON.stringify({ ok: true, id: msg.id }), { status: 200 });
          }

          if (request.method === "GET" && path === "/poll") {
            const s = sessions.get(code);
            if (!s || Date.now() > s.expiresAt) {
              return new Response(JSON.stringify({ messages: [] }), { status: 200 });
            }
            const target = url.searchParams.get("target");
            const sinceStr = url.searchParams.get("since");
            const since = sinceStr ? parseInt(sinceStr, 10) : 0;
            const messages = s.messages.filter((m) => m.target === target && m.timestamp > since);
            return new Response(JSON.stringify({ messages }), { status: 200 });
          }

          if (request.method === "DELETE" && path === "/close") {
            sessions.delete(code);
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
          }

          return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
        },
      };
    },
  };
}
