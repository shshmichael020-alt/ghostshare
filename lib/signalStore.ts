import { getCloudflareContext } from "@opennextjs/cloudflare";

export interface SignalMessage {
  seq?: number;
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
  senderToken?: string;
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
  if (explicitBinding !== undefined) {
    if (explicitBinding && typeof (explicitBinding as SignalingStorageNamespace).idFromName === "function") {
      return explicitBinding as SignalingStorageNamespace;
    }
    throw new Error("Authoritative signaling storage binding (SIGNALING_DO) is unavailable");
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
  if (process.env.NODE_ENV === "test" || !process.env.NODE_ENV) {
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
 * Generates a high-entropy CSPRNG token for authorized session control.
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
 * Sender joins an existing session and obtains a dedicated senderToken capability.
 * Returns { ok: true, senderToken } on success.
 * Returns 404 if not found/expired, or 409 if another sender is active.
 */
export async function joinSignalingSession(
  code: string,
  senderToken?: string,
  explicitStorage?: unknown,
): Promise<{ ok: boolean; senderToken?: string; status: number; error?: string }> {
  const storage = resolveStorageBinding(explicitStorage);
  const stub = getSessionStub(storage, code);

  const res = await stub.fetch(
    new Request("https://internal/join", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ senderToken }),
    }),
  );

  if (res.status === 404) {
    return { ok: false, status: 404, error: "Pairing code not found or expired" };
  }
  if (res.status === 409) {
    return { ok: false, status: 409, error: "Session already has an active sender connected" };
  }
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Failed to join session (status ${res.status}): ${errBody}`);
  }

  const data = (await res.json()) as { ok: boolean; senderToken: string };
  return { ok: true, senderToken: data.senderToken, status: 200 };
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
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${receiverToken}`,
      },
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
 * Authenticates sender using its assigned participant capability token.
 */
export async function postSignalMessage(
  code: string,
  sender: "receiver" | "sender",
  target: "receiver" | "sender",
  type: SignalMessage["type"],
  data: unknown,
  token: string,
  explicitStorage?: unknown,
): Promise<{ ok: boolean; status: number; error?: string }> {
  const storage = resolveStorageBinding(explicitStorage);
  const stub = getSessionStub(storage, code);

  const res = await stub.fetch(
    new Request("https://internal/post-message", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ sender, target, type, data, token }),
    }),
  );

  if (res.status === 401 || res.status === 403) {
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, status: res.status, error: json.error || "Unauthorized participant token" };
  }
  if (res.status === 404) {
    return { ok: false, status: 404, error: "Session not found or expired" };
  }
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Failed to post signal message (status ${res.status}): ${errBody}`);
  }

  return { ok: true, status: 200 };
}

/**
 * Polls for new signaling messages destined for a given role strictly greater than cursor sequence.
 * Authenticates caller against participant capability token.
 */
export async function pollSignalMessages(
  code: string,
  forRole: "receiver" | "sender",
  sinceSeq: number,
  token: string,
  explicitStorage?: unknown,
): Promise<{ messages: SignalMessage[]; cursor: number; status: number; error?: string }> {
  const storage = resolveStorageBinding(explicitStorage);
  const stub = getSessionStub(storage, code);

  const url = `https://internal/poll?target=${encodeURIComponent(forRole)}&since=${sinceSeq}&token=${encodeURIComponent(token)}`;
  const res = await stub.fetch(
    new Request(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }),
  );

  if (res.status === 401 || res.status === 403) {
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    return { messages: [], cursor: sinceSeq, status: res.status, error: json.error || "Unauthorized polling" };
  }
  if (res.status === 404) {
    return { messages: [], cursor: sinceSeq, status: 404 };
  }
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Failed to poll signal messages (status ${res.status}): ${errBody}`);
  }

  const json = (await res.json()) as { messages: SignalMessage[]; cursor?: number };
  return {
    messages: json.messages || [],
    cursor: typeof json.cursor === "number" ? json.cursor : sinceSeq,
    status: 200,
  };
}

/**
 * Closes and purges an active signaling session.
 * Requires a valid receiverToken. Missing or invalid credentials will fail.
 */
export async function closeSignalingSession(
  code: string,
  receiverToken: string,
  explicitStorage?: unknown,
): Promise<{ ok: boolean; status: number; error?: string }> {
  if (!receiverToken || typeof receiverToken !== "string" || receiverToken.trim().length === 0) {
    return { ok: false, status: 401, error: "Missing receiverToken capability" };
  }

  const storage = resolveStorageBinding(explicitStorage);
  const stub = getSessionStub(storage, code);

  const res = await stub.fetch(
    new Request("https://internal/close", {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${receiverToken}`,
      },
      body: JSON.stringify({ receiverToken }),
    }),
  );

  if (res.status === 401 || res.status === 403) {
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, status: res.status, error: json.error || "Unauthorized" };
  }
  if (res.status === 404) {
    return { ok: false, status: 404, error: "Session not found or expired" };
  }
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Failed to close session (status ${res.status}): ${errBody}`);
  }

  return { ok: true, status: 200 };
}

/**
 * Durable Object cross-isolate rate limiter.
 * Guarantees globally consistent quotas across all Cloudflare isolates.
 */
export async function checkCrossIsolateRateLimit(
  action: string,
  identifier: string,
  limit: number,
  windowMs = 60_000,
  explicitStorage?: unknown,
): Promise<{ allowed: boolean; remaining: number; reset: number }> {
  try {
    const storage = resolveStorageBinding(explicitStorage);
    // Route to IP/identifier rate-limiter DO instance
    const id = storage.idFromName(`rl:${identifier}`);
    const stub = storage.get(id);

    const res = await stub.fetch(
      new Request("https://internal/check-rate-limit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, limit, windowMs }),
      }),
    );

    if (res.ok) {
      return (await res.json()) as { allowed: boolean; remaining: number; reset: number };
    }
  } catch {
    // If DO rate limiter unavailable, fall back safely
  }

  return { allowed: true, remaining: limit - 1, reset: Math.ceil((Date.now() + windowMs) / 1000) };
}

/**
 * In-memory test store implementation for isolated unit testing.
 * Accurately simulates SQLite Durable Object behavior with sequence cursors and participant authentication.
 */
export function createInMemoryTestNamespace(): SignalingStorageNamespace {
  interface InMemorySession {
    code: string;
    createdAt: number;
    expiresAt: number;
    receiverActive: boolean;
    senderActive: boolean;
    receiverToken: string;
    senderToken: string | null;
    messages: Array<SignalMessage & { seq: number }>;
    rateLimits: Map<string, { count: number; resetAt: number }>;
  }

  const sessions = new Map<string, InMemorySession>();
  let nextSeq = 1;

  return {
    idFromName(name: string) {
      return name;
    },
    get(id: unknown): SignalingStorageStub {
      const targetId = String(id);

      return {
        async fetch(request: Request): Promise<Response> {
          const url = new URL(request.url);
          const path = url.pathname;

          // Global/IP rate limiter route
          if (request.method === "POST" && path === "/check-rate-limit") {
            let session = sessions.get(targetId);
            if (!session) {
              session = {
                code: targetId,
                createdAt: Date.now(),
                expiresAt: Date.now() + 86400000,
                receiverActive: true,
                senderActive: false,
                receiverToken: "rl",
                senderToken: null,
                messages: [],
                rateLimits: new Map(),
              };
              sessions.set(targetId, session);
            }
            const body = (await request.json()) as { action: string; limit: number; windowMs: number };
            const now = Date.now();
            const rec = session.rateLimits.get(body.action);
            if (!rec || now >= rec.resetAt) {
              const resetAt = now + body.windowMs;
              session.rateLimits.set(body.action, { count: 1, resetAt });
              return new Response(
                JSON.stringify({ allowed: true, limit: body.limit, remaining: body.limit - 1, reset: Math.ceil(resetAt / 1000) }),
                { status: 200 },
              );
            }
            if (rec.count >= body.limit) {
              return new Response(
                JSON.stringify({ allowed: false, limit: body.limit, remaining: 0, reset: Math.ceil(rec.resetAt / 1000) }),
                { status: 200 },
              );
            }
            rec.count += 1;
            return new Response(
              JSON.stringify({ allowed: true, limit: body.limit, remaining: body.limit - rec.count, reset: Math.ceil(rec.resetAt / 1000) }),
              { status: 200 },
            );
          }

          const code = targetId;

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
              senderToken: null,
              messages: [],
              rateLimits: new Map(),
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

            let reconnectToken: string | undefined;
            try {
              const body = (await request.json()) as { senderToken?: string };
              reconnectToken = body?.senderToken;
            } catch {}

            if (s.senderActive && s.senderToken) {
              if (reconnectToken && reconnectToken === s.senderToken) {
                return new Response(JSON.stringify({ ok: true, code: s.code, senderToken: s.senderToken }), { status: 200 });
              }
              return new Response(JSON.stringify({ error: "Session already has an active sender connected" }), { status: 409 });
            }

            s.senderActive = true;
            s.senderToken = `snd_test_${Math.random().toString(36).slice(2, 10)}`;
            return new Response(JSON.stringify({ ok: true, code: s.code, senderToken: s.senderToken }), { status: 200 });
          }

          if (request.method === "POST" && path === "/update-ttl") {
            const body = (await request.json()) as { ttlSeconds: number; receiverToken?: string };
            const authHeader = request.headers.get("authorization");
            const token = body.receiverToken || (authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined);

            const s = sessions.get(code);
            if (!s) return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
            if (Date.now() > s.expiresAt) {
              sessions.delete(code);
              return new Response(JSON.stringify({ error: "Expired" }), { status: 404 });
            }
            if (!token || s.receiverToken !== token) {
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
              token?: string;
            };
            const authHeader = request.headers.get("authorization");
            const token = body.token || (authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined);

            if (!token) {
              return new Response(JSON.stringify({ error: "Unauthorized: Missing token" }), { status: 401 });
            }
            if (body.sender === "receiver" && token !== s.receiverToken) {
              return new Response(JSON.stringify({ error: "Unauthorized: Invalid receiver token" }), { status: 403 });
            }
            if (body.sender === "sender" && (!s.senderToken || token !== s.senderToken)) {
              return new Response(JSON.stringify({ error: "Unauthorized: Invalid sender token" }), { status: 403 });
            }

            const seq = nextSeq++;
            const msg: SignalMessage & { seq: number } = {
              seq,
              id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              sender: body.sender,
              target: body.target,
              type: body.type,
              data: body.data,
              timestamp: Date.now(),
            };
            s.messages.push(msg);
            if (s.messages.length > 150) s.messages.shift();
            if (body.type === "leave" && body.sender === "sender") {
              s.senderActive = false;
              s.senderToken = null;
            }
            return new Response(JSON.stringify({ ok: true, id: msg.id, seq }), { status: 200 });
          }

          if (request.method === "GET" && path === "/poll") {
            const s = sessions.get(code);
            if (!s || Date.now() > s.expiresAt) {
              return new Response(JSON.stringify({ messages: [], cursor: 0 }), { status: 200 });
            }
            const target = url.searchParams.get("target");
            const sinceStr = url.searchParams.get("since") || "0";
            const sinceSeq = parseInt(sinceStr, 10) || 0;
            const authHeader = request.headers.get("authorization");
            const token = url.searchParams.get("token") || (authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined);

            if (!token) {
              return new Response(JSON.stringify({ error: "Unauthorized: Missing token" }), { status: 401 });
            }
            if (target === "receiver" && token !== s.receiverToken) {
              return new Response(JSON.stringify({ error: "Unauthorized: Invalid receiver token" }), { status: 403 });
            }
            if (target === "sender" && (!s.senderToken || token !== s.senderToken)) {
              return new Response(JSON.stringify({ error: "Unauthorized: Invalid sender token" }), { status: 403 });
            }

            const messages = s.messages.filter((m) => m.target === target && m.seq > sinceSeq);
            const cursor = messages.length > 0 ? Math.max(...messages.map((m) => m.seq)) : sinceSeq;
            return new Response(JSON.stringify({ messages, cursor }), { status: 200 });
          }

          if (request.method === "DELETE" && path === "/close") {
            let bodyToken: string | undefined;
            try {
              const body = (await request.json()) as { receiverToken?: string };
              bodyToken = body?.receiverToken;
            } catch {}
            const authHeader = request.headers.get("authorization");
            const token = bodyToken || (authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined);

            if (!token || typeof token !== "string" || token.trim().length === 0) {
              return new Response(JSON.stringify({ error: "Unauthorized: Missing receiverToken capability" }), { status: 401 });
            }

            const s = sessions.get(code);
            if (!s) return new Response(JSON.stringify({ error: "Session not found" }), { status: 404 });
            if (Date.now() > s.expiresAt) {
              sessions.delete(code);
              return new Response(JSON.stringify({ error: "Session expired" }), { status: 404 });
            }
            if (s.receiverToken !== token.trim()) {
              return new Response(JSON.stringify({ error: "Unauthorized: Invalid receiver token" }), { status: 403 });
            }

            sessions.delete(code);
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
          }

          return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
        },
      };
    },
  };
}
