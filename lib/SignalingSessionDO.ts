import { DurableObject } from "cloudflare:workers";

export interface SessionRecord {
  code: string;
  createdAt: number;
  expiresAt: number;
  receiverActive: boolean;
  senderActive: boolean;
  receiverToken: string;
}

export interface StoredSignalMessage {
  id: string;
  sender: "receiver" | "sender";
  target: "receiver" | "sender";
  type: string;
  data: unknown;
  timestamp: number;
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
        receiverToken TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        sender TEXT NOT NULL,
        target TEXT NOT NULL,
        type TEXT NOT NULL,
        data TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_target_ts ON messages(target, timestamp);
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
        return await this.handleJoin();
      } else if (request.method === "POST" && path === "/update-ttl") {
        return await this.handleUpdateTtl(request);
      } else if (request.method === "POST" && path === "/post-message") {
        return await this.handlePostMessage(request);
      } else if (request.method === "GET" && path === "/poll") {
        return await this.handlePoll(url);
      } else if (request.method === "DELETE" && path === "/close") {
        return await this.handleClose(request);
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
      `INSERT OR REPLACE INTO session (code, createdAt, expiresAt, receiverActive, senderActive, receiverToken)
       VALUES (?, ?, ?, 1, 0, ?)`,
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
      receiverToken: string;
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

  private async handleJoin(): Promise<Response> {
    const rows = this.sql.exec("SELECT * FROM session LIMIT 1").toArray() as unknown as Array<{
      code: string;
      expiresAt: number;
    }>;

    if (rows.length === 0) {
      return new Response(JSON.stringify({ error: "Session not found" }), { status: 404 });
    }

    const s = rows[0];
    if (Date.now() > s.expiresAt) {
      this.clearSession();
      return new Response(JSON.stringify({ error: "Session expired" }), { status: 404 });
    }

    this.sql.exec("UPDATE session SET senderActive = 1 WHERE code = ?", s.code);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  private async handleUpdateTtl(request: Request): Promise<Response> {
    const body = (await request.json()) as { ttlSeconds: number; receiverToken: string };
    if (!body.ttlSeconds || !body.receiverToken) {
      return new Response(JSON.stringify({ error: "Missing parameters" }), { status: 400 });
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

    if (s.receiverToken !== body.receiverToken) {
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
    }>;

    if (rows.length === 0 || Date.now() > rows[0].expiresAt) {
      return new Response(JSON.stringify({ error: "Session not found or expired" }), { status: 404 });
    }

    const body = (await request.json()) as {
      sender: "receiver" | "sender";
      target: "receiver" | "sender";
      type: string;
      data: unknown;
    };

    if (!body.sender || !body.target || !body.type) {
      return new Response(JSON.stringify({ error: "Missing signal parameters" }), { status: 400 });
    }

    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    const dataStr = JSON.stringify(body.data ?? null);

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

    // Keep message history to 100 max to bound storage
    this.sql.exec(
      `DELETE FROM messages WHERE id NOT IN (
         SELECT id FROM messages ORDER BY timestamp DESC LIMIT 100
       )`,
    );

    return new Response(JSON.stringify({ ok: true, id }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  private async handlePoll(url: URL): Promise<Response> {
    const target = url.searchParams.get("target");
    const sinceStr = url.searchParams.get("since");
    const since = sinceStr ? parseInt(sinceStr, 10) : 0;

    if (!target) {
      return new Response(JSON.stringify({ error: "Missing target" }), { status: 400 });
    }

    const rows = this.sql.exec("SELECT expiresAt FROM session LIMIT 1").toArray() as unknown as Array<{
      expiresAt: number;
    }>;

    if (rows.length === 0 || Date.now() > rows[0].expiresAt) {
      return new Response(JSON.stringify({ messages: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    const messageRows = this.sql
      .exec(
        `SELECT id, sender, target, type, data, timestamp
         FROM messages
         WHERE target = ? AND timestamp > ?
         ORDER BY timestamp ASC`,
        target,
        since,
      )
      .toArray() as unknown as Array<{
        id: string;
        sender: "receiver" | "sender";
        target: "receiver" | "sender";
        type: string;
        data: string;
        timestamp: number;
      }>;

    const messages = messageRows.map((r) => {
      let parsedData: unknown = null;
      try {
        parsedData = JSON.parse(r.data);
      } catch {
        parsedData = r.data;
      }
      return {
        id: r.id,
        sender: r.sender,
        target: r.target,
        type: r.type,
        data: parsedData,
        timestamp: r.timestamp,
      };
    });

    return new Response(JSON.stringify({ messages }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  private async handleClose(request: Request): Promise<Response> {
    let token: string | undefined;
    try {
      const body = (await request.json()) as { receiverToken?: string };
      token = body?.receiverToken;
    } catch {}

    const rows = this.sql.exec("SELECT receiverToken FROM session LIMIT 1").toArray() as unknown as Array<{
      receiverToken: string;
    }>;

    if (rows.length > 0 && token && rows[0].receiverToken !== token) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 403 });
    }

    this.clearSession();
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  async alarm(): Promise<void> {
    this.clearSession();
  }

  private clearSession(): void {
    this.sql.exec("DELETE FROM session");
    this.sql.exec("DELETE FROM messages");
  }
}
