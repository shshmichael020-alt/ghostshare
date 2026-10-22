import { DurableObject } from "cloudflare:workers";

export interface SessionRecord {
  code: string;
  createdAt: number;
  expiresAt: number;
  receiverActive: boolean;
  senderActive: boolean;
  receiverToken: string;
  senderToken: string | null;
}

export interface StoredSignalMessage {
  seq: number;
  id: string;
  sender: "receiver" | "sender";
  target: "receiver" | "sender";
  type: string;
  data: unknown;
  timestamp: number;
}

function generateSecureToken(prefix = ""): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return prefix ? `${prefix}_${hex}` : hex;
}

function extractBearerToken(request: Request, bodyToken?: string): string | undefined {
  if (bodyToken && typeof bodyToken === "string" && bodyToken.trim().length > 0) {
    return bodyToken.trim();
  }
  const auth = request.headers.get("authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  return undefined;
}

export class SignalingSessionDO extends DurableObject {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.initSchema();
  }

  private initSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS session (
        code TEXT PRIMARY KEY,
        createdAt INTEGER NOT NULL,
        expiresAt INTEGER NOT NULL,
        receiverActive INTEGER NOT NULL,
        senderActive INTEGER NOT NULL,
        receiverToken TEXT NOT NULL,
        senderToken TEXT
      );
      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT UNIQUE NOT NULL,
        sender TEXT NOT NULL,
        target TEXT NOT NULL,
        type TEXT NOT NULL,
        data TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_target_seq ON messages(target, seq);

      CREATE TABLE IF NOT EXISTS rate_limits (
        action TEXT PRIMARY KEY,
        count INTEGER NOT NULL,
        resetAt INTEGER NOT NULL
      );
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (request.method === "POST" && path === "/create") {
        return await this.handleCreate(request);
      } else if (request.method === "GET" && path === "/get") {
        return await this.handleGet();
      } else if (request.method === "POST" && path === "/join") {
        return await this.handleJoin(request);
      } else if (request.method === "POST" && path === "/update-ttl") {
        return await this.handleUpdateTtl(request);
      } else if (request.method === "POST" && path === "/post-message") {
        return await this.handlePostMessage(request);
      } else if (request.method === "GET" && path === "/poll") {
        return await this.handlePoll(request, url);
      } else if (request.method === "DELETE" && path === "/close") {
        return await this.handleClose(request);
      } else if (request.method === "POST" && path === "/check-rate-limit") {
        return await this.handleCheckRateLimit(request);
      }

      return new Response(JSON.stringify({ error: "Endpoint not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      return new Response(
        JSON.stringify({ error: "Durable Object internal error", details: (err as Error).message }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }
  }

  private async handleCreate(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      code: string;
      ttlSeconds: number;
      receiverToken: string;
    };

    if (!body.code || !body.receiverToken || !body.ttlSeconds) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), { status: 400 });
    }

    const now = Date.now();
    const expiresAt = now + body.ttlSeconds * 1000;

    // Check if unexpired session already exists
    const existing = this.sql
      .exec("SELECT expiresAt FROM session WHERE code = ?", body.code)
      .toArray() as unknown as Array<{ expiresAt: number }>;

    if (existing.length > 0 && existing[0].expiresAt > now) {
      return new Response(JSON.stringify({ error: "Session code collision" }), { status: 409 });
    }

    // Upsert session
    this.sql.exec(
      `INSERT OR REPLACE INTO session (code, createdAt, expiresAt, receiverActive, senderActive, receiverToken, senderToken)
       VALUES (?, ?, ?, 1, 0, ?, NULL)`,
      body.code,
      now,
      expiresAt,
      body.receiverToken,
    );

    // Clear any previous messages
    this.sql.exec("DELETE FROM messages");

    // Schedule automatic deletion alarm
    await this.ctx.storage.setAlarm(expiresAt);

    return new Response(
      JSON.stringify({
        code: body.code,
        createdAt: now,
        expiresAt,
        receiverActive: true,
        senderActive: false,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  private async handleGet(): Promise<Response> {
    const rows = this.sql.exec("SELECT * FROM session LIMIT 1").toArray() as unknown as Array<{
      code: string;
      createdAt: number;
      expiresAt: number;
      receiverActive: number;
      senderActive: number;
    }>;

    if (rows.length === 0) {
      return new Response(JSON.stringify({ error: "Session not found" }), { status: 404 });
    }

    const s = rows[0];
    const now = Date.now();
    if (now > s.expiresAt) {
      this.clearSession();
      return new Response(JSON.stringify({ error: "Session expired" }), { status: 404 });
    }

    return new Response(
      JSON.stringify({
        code: s.code,
        createdAt: s.createdAt,
        expiresAt: s.expiresAt,
        remainingSeconds: Math.max(0, Math.round((s.expiresAt - now) / 1000)),
        receiverActive: s.receiverActive === 1,
        senderActive: s.senderActive === 1,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  private async handleJoin(request: Request): Promise<Response> {
    let reconnectToken: string | undefined;
    try {
      const body = (await request.json()) as { senderToken?: string };
      reconnectToken = body?.senderToken;
    } catch {}

    const rows = this.sql.exec("SELECT * FROM session LIMIT 1").toArray() as unknown as Array<{
      code: string;
      expiresAt: number;
      senderActive: number;
      senderToken: string | null;
    }>;

    if (rows.length === 0) {
      return new Response(JSON.stringify({ error: "Session not found" }), { status: 404 });
    }

    const s = rows[0];
    if (Date.now() > s.expiresAt) {
      this.clearSession();
      return new Response(JSON.stringify({ error: "Session expired" }), { status: 404 });
    }

    // If a sender is already active, reject competing sender claims unless presenting matching token
    if (s.senderActive === 1 && s.senderToken) {
      if (reconnectToken && reconnectToken === s.senderToken) {
        return new Response(
          JSON.stringify({ ok: true, code: s.code, senderToken: s.senderToken }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ error: "Session already has an active sender connected" }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      );
    }

    // Allocate fresh sender capability token
    const newSenderToken = generateSecureToken("snd");
    this.sql.exec(
      "UPDATE session SET senderActive = 1, senderToken = ? WHERE code = ?",
      newSenderToken,
      s.code,
    );

    return new Response(
      JSON.stringify({ ok: true, code: s.code, senderToken: newSenderToken }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  private async handleUpdateTtl(request: Request): Promise<Response> {
    const body = (await request.json()) as { ttlSeconds: number; receiverToken?: string };
    const token = extractBearerToken(request, body.receiverToken);

    if (!body.ttlSeconds || !token) {
      return new Response(JSON.stringify({ error: "Missing required parameters" }), { status: 400 });
    }

    const rows = this.sql.exec("SELECT * FROM session LIMIT 1").toArray() as unknown as Array<{
      code: string;
      createdAt: number;
      expiresAt: number;
      receiverToken: string;
    }>;

    if (rows.length === 0) {
      return new Response(JSON.stringify({ error: "Session not found" }), { status: 404 });
    }

    const s = rows[0];
    if (Date.now() > s.expiresAt) {
      this.clearSession();
      return new Response(JSON.stringify({ error: "Session expired" }), { status: 404 });
    }

    if (s.receiverToken !== token) {
      return new Response(JSON.stringify({ error: "Unauthorized: Invalid receiver token" }), { status: 403 });
    }

    const newExpiresAt = s.createdAt + body.ttlSeconds * 1000;
    this.sql.exec("UPDATE session SET expiresAt = ? WHERE code = ?", newExpiresAt, s.code);
    await this.ctx.storage.setAlarm(newExpiresAt);

    return new Response(
      JSON.stringify({
        ok: true,
        expiresAt: newExpiresAt,
        remainingSeconds: Math.max(0, Math.round((newExpiresAt - Date.now()) / 1000)),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  private async handlePostMessage(request: Request): Promise<Response> {
    const rows = this.sql.exec("SELECT * FROM session LIMIT 1").toArray() as unknown as Array<{
      expiresAt: number;
      receiverToken: string;
      senderToken: string | null;
    }>;

    if (rows.length === 0 || Date.now() > rows[0].expiresAt) {
      return new Response(JSON.stringify({ error: "Session not found or expired" }), { status: 404 });
    }

    const s = rows[0];
    const body = (await request.json()) as {
      sender: "receiver" | "sender";
      target: "receiver" | "sender";
      type: string;
      data: unknown;
      token?: string;
    };

    if (!body.sender || !body.target || !body.type) {
      return new Response(JSON.stringify({ error: "Missing signal parameters" }), { status: 400 });
    }

    const token = extractBearerToken(request, body.token);
    if (!token) {
      return new Response(
        JSON.stringify({ error: "Unauthorized: Missing participant capability token" }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    }

    // Authenticate sender role against assigned capability
    if (body.sender === "receiver") {
      if (token !== s.receiverToken) {
        return new Response(
          JSON.stringify({ error: "Unauthorized: Invalid receiver token" }),
          { status: 403, headers: { "Content-Type": "application/json" } },
        );
      }
    } else if (body.sender === "sender") {
      if (!s.senderToken || token !== s.senderToken) {
        return new Response(
          JSON.stringify({ error: "Unauthorized: Invalid sender token" }),
          { status: 403, headers: { "Content-Type": "application/json" } },
        );
      }
    } else {
      return new Response(JSON.stringify({ error: "Invalid sender role" }), { status: 400 });
    }

    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    const dataStr = JSON.stringify(body.data ?? null);

    // Monotonically increasing sequence allocation
    this.sql.exec(
      `INSERT INTO messages (id, sender, target, type, data, timestamp)
       VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      body.sender,
      body.target,
      body.type,
      dataStr,
      now,
    );

    const insertedRow = this.sql
      .exec("SELECT seq FROM messages WHERE id = ?", id)
      .toArray() as unknown as Array<{ seq: number }>;
    const seq = insertedRow.length > 0 ? insertedRow[0].seq : 0;

    // Bound message history to last 150 entries
    this.sql.exec(
      `DELETE FROM messages WHERE seq NOT IN (
         SELECT seq FROM messages ORDER BY seq DESC LIMIT 150
       )`,
    );

    return new Response(JSON.stringify({ ok: true, id, seq }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  private async handlePoll(request: Request, url: URL): Promise<Response> {
    const target = url.searchParams.get("target");
    const sinceStr = url.searchParams.get("since") || url.searchParams.get("sinceSeq");
    const sinceSeq = sinceStr ? parseInt(sinceStr, 10) : 0;
    const queryToken = url.searchParams.get("token") || undefined;
    const token = extractBearerToken(request, queryToken);

    if (!target || (target !== "receiver" && target !== "sender")) {
      return new Response(JSON.stringify({ error: "Missing or invalid target parameter" }), { status: 400 });
    }

    const rows = this.sql.exec("SELECT * FROM session LIMIT 1").toArray() as unknown as Array<{
      expiresAt: number;
      receiverToken: string;
      senderToken: string | null;
    }>;

    if (rows.length === 0 || Date.now() > rows[0].expiresAt) {
      return new Response(JSON.stringify({ messages: [], cursor: sinceSeq }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const s = rows[0];

    // Authenticate polling participant
    if (!token) {
      return new Response(
        JSON.stringify({ error: "Unauthorized: Missing participant capability token" }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    }

    if (target === "receiver") {
      if (token !== s.receiverToken) {
        return new Response(
          JSON.stringify({ error: "Unauthorized: Invalid receiver token" }),
          { status: 403, headers: { "Content-Type": "application/json" } },
        );
      }
    } else if (target === "sender") {
      if (!s.senderToken || token !== s.senderToken) {
        return new Response(
          JSON.stringify({ error: "Unauthorized: Invalid sender token" }),
          { status: 403, headers: { "Content-Type": "application/json" } },
        );
      }
    }

    // Query messages strictly greater than monotonic sequence cursor
    const messageRows = this.sql
      .exec(
        `SELECT seq, id, sender, target, type, data, timestamp
         FROM messages
         WHERE target = ? AND seq > ?
         ORDER BY seq ASC`,
        target,
        sinceSeq,
      )
      .toArray() as unknown as Array<{
        seq: number;
        id: string;
        sender: "receiver" | "sender";
        target: "receiver" | "sender";
        type: string;
        data: string;
        timestamp: number;
      }>;

    let maxSeq = sinceSeq;
    const messages = messageRows.map((r) => {
      if (r.seq > maxSeq) {
        maxSeq = r.seq;
      }
      let parsedData: unknown = null;
      try {
        parsedData = JSON.parse(r.data);
      } catch {
        parsedData = r.data;
      }
      return {
        seq: r.seq,
        id: r.id,
        sender: r.sender,
        target: r.target,
        type: r.type,
        data: parsedData,
        timestamp: r.timestamp,
      };
    });

    return new Response(JSON.stringify({ messages, cursor: maxSeq }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  private async handleClose(request: Request): Promise<Response> {
    let bodyToken: string | undefined;
    try {
      const body = (await request.json()) as { receiverToken?: string };
      bodyToken = body?.receiverToken;
    } catch {}

    const token = extractBearerToken(request, bodyToken);

    // Require non-empty valid token
    if (!token || typeof token !== "string" || token.trim().length === 0) {
      return new Response(
        JSON.stringify({ error: "Unauthorized: Missing receiverToken capability" }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    }

    const rows = this.sql.exec("SELECT receiverToken, expiresAt FROM session LIMIT 1").toArray() as unknown as Array<{
      receiverToken: string;
      expiresAt: number;
    }>;

    if (rows.length === 0) {
      return new Response(
        JSON.stringify({ error: "Session not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      );
    }

    if (Date.now() > rows[0].expiresAt) {
      this.clearSession();
      return new Response(
        JSON.stringify({ error: "Session expired" }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      );
    }

    if (rows[0].receiverToken !== token.trim()) {
      return new Response(
        JSON.stringify({ error: "Unauthorized: Invalid receiver token" }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      );
    }

    this.clearSession();
    return new Response(
      JSON.stringify({ ok: true }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  private async handleCheckRateLimit(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      action: string;
      limit: number;
      windowMs: number;
    };

    const { action, limit, windowMs } = body;
    const now = Date.now();

    const rows = this.sql
      .exec("SELECT count, resetAt FROM rate_limits WHERE action = ?", action)
      .toArray() as unknown as Array<{ count: number; resetAt: number }>;

    if (rows.length === 0 || now >= rows[0].resetAt) {
      const resetAt = now + windowMs;
      this.sql.exec(
        "INSERT OR REPLACE INTO rate_limits (action, count, resetAt) VALUES (?, 1, ?)",
        action,
        resetAt,
      );
      return new Response(
        JSON.stringify({ allowed: true, limit, remaining: limit - 1, reset: Math.ceil(resetAt / 1000) }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    const current = rows[0];
    if (current.count >= limit) {
      return new Response(
        JSON.stringify({ allowed: false, limit, remaining: 0, reset: Math.ceil(current.resetAt / 1000) }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    const newCount = current.count + 1;
    this.sql.exec("UPDATE rate_limits SET count = ? WHERE action = ?", newCount, action);

    return new Response(
      JSON.stringify({
        allowed: true,
        limit,
        remaining: limit - newCount,
        reset: Math.ceil(current.resetAt / 1000),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  async alarm(): Promise<void> {
    this.clearSession();
  }

  private clearSession(): void {
    this.sql.exec("DELETE FROM session");
    this.sql.exec("DELETE FROM messages");
    this.sql.exec("DELETE FROM rate_limits");
  }
}
