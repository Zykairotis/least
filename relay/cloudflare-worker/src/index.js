const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "cdn-loop"
]);

const ALLOWED_PATHS = [
  /^\/$/,
  /^\/healthz$/,
  /^\/setup$/,
  /^\/mcp(?:-grok)?$/,
  /^\/oauth(?:\/|$)/,
  /^\/\.well-known\/oauth-[a-z0-9-]+(?:\/.*)?$/
];

function pathAllowed(pathname) {
  return ALLOWED_PATHS.some((re) => re.test(pathname));
}

function bearer(request) {
  const header = request.headers.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || "";
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extra }
  });
}

function filterHeaders(headers) {
  const out = {};
  for (const [key, value] of headers) {
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/least/status" && request.method === "GET") {
      const id = env.RELAY.idFromName("default");
      const stub = env.RELAY.get(id);
      return stub.fetch(new Request(new URL("/__status", request.url), request));
    }
    if (!pathAllowed(url.pathname) && url.pathname !== "/agent") {
      return json({ ok: false, error: "not found" }, 404);
    }
    const id = env.RELAY.idFromName("default");
    return env.RELAY.get(id).fetch(request);
  }
};

export class LeastRelay {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.pending = new Map();
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/agent") {
      return this.acceptAgent(request);
    }
    if (url.pathname === "/__status") {
      const sockets = this.ctx.getWebSockets();
      return json({
        ok: true,
        name: "Least Relay",
        agentConnected: sockets.length > 0
      });
    }
    if (url.pathname === "/healthz" && this.ctx.getWebSockets().length === 0) {
      return json(
        {
          ok: false,
          name: "Least Relay",
          error: "Least agent is offline. Run least start --tunnel workers-relay on the Arch host."
        },
        503
      );
    }
    return this.proxyHttp(request);
  }

  acceptAgent(request) {
    if ((request.headers.get("upgrade") || "").toLowerCase() !== "websocket") {
      return json({ ok: false, error: "expected websocket" }, 426);
    }
    const token = bearer(request) || new URL(request.url).searchParams.get("relay_token") || "";
    if (!this.env.RELAY_TOKEN || token !== this.env.RELAY_TOKEN) {
      return json({ ok: false, error: "unauthorized" }, 401);
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    for (const existing of this.ctx.getWebSockets()) {
      try {
        existing.close(1012, "replaced");
      } catch {
        /* ignore */
      }
    }
    this.ctx.acceptWebSocket(server);
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}')
    );
    return new Response(null, { status: 101, webSocket: client });
  }

  async proxyHttp(request) {
    const sockets = this.ctx.getWebSockets();
    if (!sockets.length) {
      return json(
        {
          ok: false,
          error: "Least agent is offline. Start Least with --tunnel workers-relay."
        },
        503
      );
    }
    const id = crypto.randomUUID();
    const url = new URL(request.url);
    let bodyB64 = null;
    if (request.method !== "GET" && request.method !== "HEAD") {
      const buf = new Uint8Array(await request.arrayBuffer());
      if (buf.byteLength) bodyB64 = bytesToB64(buf);
    }
    const pending = {
      chunks: [],
      done: false,
      error: null,
      writer: null,
      resolveHead: null,
      rejectHead: null
    };
    const headPromise = new Promise((resolve, reject) => {
      pending.resolveHead = resolve;
      pending.rejectHead = reject;
    });
    this.pending.set(id, pending);
    const timeout = setTimeout(() => {
      const err = new Error("relay upstream timeout");
      pending.rejectHead?.(err);
      this.fail(id, err.message);
    }, 300_000);

    try {
      sockets[0].send(
        JSON.stringify({
          t: "http",
          id,
          method: request.method,
          path: `${url.pathname}${url.search}`,
          headers: filterHeaders(request.headers),
          bodyB64
        })
      );
      const head = await headPromise;
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      pending.writer = writer;
      await this.flush(id);
      if (pending.done) {
        try {
          await writer.close();
        } catch {
          /* ignore */
        }
      }
      return new Response(readable, {
        status: head.status,
        headers: head.headers
      });
    } catch (error) {
      return json(
        { ok: false, error: error instanceof Error ? error.message : String(error) },
        502
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async flush(id) {
    const pending = this.pending.get(id);
    if (!pending?.writer) return;
    while (pending.chunks.length) {
      const chunkB64 = pending.chunks.shift();
      await pending.writer.write(b64ToBytes(chunkB64));
    }
    if (pending.done) {
      try {
        await pending.writer.close();
      } catch {
        /* ignore */
      }
      this.pending.delete(id);
    }
    if (pending.error) {
      try {
        await pending.writer.abort(pending.error);
      } catch {
        /* ignore */
      }
      this.pending.delete(id);
    }
  }

  fail(id, message) {
    const pending = this.pending.get(id);
    if (!pending) return;
    pending.error = message;
    pending.done = true;
    pending.rejectHead?.(new Error(message));
    void this.flush(id);
  }

  async webSocketMessage(_ws, raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return;
    }
    if (!msg || msg.t === "ping" || msg.t === "hello") return;
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    if (msg.t === "head") {
      pending.resolveHead?.({
        status: Number(msg.status) || 502,
        headers: msg.headers && typeof msg.headers === "object" ? msg.headers : {}
      });
      pending.resolveHead = null;
      return;
    }
    if (msg.t === "data" && typeof msg.chunkB64 === "string") {
      pending.chunks.push(msg.chunkB64);
      await this.flush(msg.id);
      return;
    }
    if (msg.t === "end") {
      pending.done = true;
      await this.flush(msg.id);
      return;
    }
    if (msg.t === "err") {
      this.fail(msg.id, msg.message || "upstream error");
    }
  }

  webSocketClose() {
    for (const [id] of this.pending) {
      this.fail(id, "agent disconnected");
    }
  }
}

function bytesToB64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function b64ToBytes(b64) {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}
