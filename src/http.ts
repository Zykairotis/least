#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import express from "express";
import cors from "cors";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig, type LeastConfig } from "./config.js";
import { createLeastServer, type McpAuthMode, type McpSurface, type SessionContext } from "./server.js";
import { createHttpAuthMiddleware } from "./httpAuth.js";
import { mountOpenAiRoutes } from "./openaiRoutes.js";
import { mountGrokOAuthRoutes } from "./oauthRoutes.js";
import { startDashboardServer } from "./dashboardServer.js";
import { McpSessionStore } from "./mcpSessionStore.js";

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function onboardingPage(config: LeastConfig): string {
  const localMcp = `http://${config.host}:${config.port}/mcp`;
  const allowedRoots = config.allowedRoots.map((root) => `<li>${escapeHtml(root)}</li>`).join("");
  const authLabel = config.authToken ? "Token protected" : "Disabled";
  const writeTone = config.writeMode === "workspace" ? "agent" : config.writeMode;
  const openAiLine = config.httpProtocols.includes("openai")
    ? `<li>OpenAI-compatible tool API: <code>http://${escapeHtml(config.host)}:${config.port}/v1</code> (client supplies <code>tool_calls</code>; no hosted chat model)</li>`
    : "";
  const grokLine = config.dualClient
    ? `<li>Dual-client mode: ChatGPT uses <code>/mcp?least_token=...</code> with No Auth. Grok uses <code>/mcp-grok</code> with OAuth at <code>/oauth/authorize</code> and <code>/oauth/token</code>, client id <code>${escapeHtml(config.grokOAuthClientId)}</code>, scope <code>mcp</code>, client secret blank.</li>`
    : config.grokOAuth
      ? `<li>Grok OAuth wrapper: same public HTTPS host, MCP server stays <code>/mcp</code>, OAuth uses <code>/oauth/authorize</code> and <code>/oauth/token</code> with client id <code>${escapeHtml(config.grokOAuthClientId)}</code>, scope <code>mcp</code>, client secret blank.</li>`
      : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Least Local Setup</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #07090d;
      --panel: #10141b;
      --panel-2: #151a23;
      --line: rgba(148, 163, 184, 0.18);
      --line-strong: rgba(148, 163, 184, 0.3);
      --text: #f4f7fb;
      --soft: #cbd5e1;
      --muted: #8a96a8;
      --quiet: #667085;
      --blue: #7dd3fc;
      --teal: #5eead4;
      --green: #86efac;
      --amber: #fde68a;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background:
        radial-gradient(circle at 18% 0, rgba(94, 234, 212, 0.14), transparent 28rem),
        radial-gradient(circle at 100% 10%, rgba(125, 211, 252, 0.1), transparent 26rem),
        var(--bg);
      color: var(--text);
      font: 14px/1.55 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
    }
    main {
      width: min(960px, calc(100vw - 32px));
      margin: 0 auto;
      padding: 48px 0;
    }
    .hero {
      display: grid;
      gap: 18px;
      margin-bottom: 18px;
      padding: 26px;
      border: 1px solid var(--line);
      border-radius: 14px;
      background: linear-gradient(180deg, rgba(255,255,255,0.055), rgba(255,255,255,0.018)), var(--panel);
      box-shadow: 0 24px 60px rgba(0,0,0,0.34);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 800;
      text-transform: uppercase;
    }
    .logo {
      display: inline-grid;
      place-items: center;
      width: 30px;
      height: 30px;
      border: 1px solid rgba(125, 211, 252, 0.3);
      border-radius: 9px;
      color: var(--blue);
      background: rgba(125, 211, 252, 0.08);
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }
    h1 {
      margin: 0;
      max-width: 760px;
      font-size: clamp(32px, 6vw, 56px);
      line-height: 0.98;
      letter-spacing: 0;
    }
    .lead {
      max-width: 700px;
      margin: 0;
      color: var(--soft);
      font-size: 16px;
    }
    .grid {
      display: grid;
      grid-template-columns: 1.05fr 0.95fr;
      gap: 18px;
    }
    .card {
      min-width: 0;
      padding: 18px;
      border: 1px solid var(--line);
      border-radius: 12px;
      background: rgba(16, 20, 27, 0.82);
    }
    h2 {
      margin: 0 0 12px;
      font-size: 15px;
    }
    .steps {
      display: grid;
      gap: 10px;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .steps li {
      display: grid;
      grid-template-columns: 26px minmax(0, 1fr);
      gap: 10px;
      align-items: start;
      color: var(--soft);
    }
    .num {
      display: inline-grid;
      place-items: center;
      width: 24px;
      height: 24px;
      border: 1px solid var(--line-strong);
      border-radius: 999px;
      color: var(--teal);
      font: 800 11px/1 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }
    .status {
      display: grid;
      gap: 8px;
    }
    .row {
      display: grid;
      grid-template-columns: 112px minmax(0, 1fr);
      gap: 10px;
      padding: 10px 0;
      border-bottom: 1px solid var(--line);
    }
    .row:last-child { border-bottom: 0; }
    .label {
      color: var(--quiet);
      font-size: 12px;
      font-weight: 800;
      text-transform: uppercase;
    }
    code, .mono {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      color: var(--soft);
      overflow-wrap: anywhere;
    }
    .pill {
      display: inline-flex;
      width: fit-content;
      padding: 3px 8px;
      border: 1px solid rgba(134, 239, 172, 0.28);
      border-radius: 999px;
      color: var(--green);
      background: rgba(134, 239, 172, 0.08);
      font-size: 12px;
      font-weight: 800;
    }
    .warn {
      border-color: rgba(253, 230, 138, 0.28);
      color: var(--amber);
      background: rgba(253, 230, 138, 0.08);
    }
    .roots {
      margin: 8px 0 0;
      padding-left: 18px;
      color: var(--muted);
    }
    .footer {
      margin-top: 14px;
      color: var(--quiet);
      font-size: 12px;
    }
    @media (max-width: 760px) {
      main { padding: 24px 0; }
      .grid { grid-template-columns: 1fr; }
      .hero { padding: 20px; }
      .row { grid-template-columns: 1fr; gap: 2px; }
    }
  </style>
</head>
<body>
  <main>
    <section class="hero">
      <div class="brand"><span class="logo">C</span><span>Least local bridge</span></div>
      <h1>Local server is ready.</h1>
      <p class="lead">Use the Server URL copied by the terminal in ChatGPT Developer Mode. Keep the terminal running while ChatGPT edits, searches, or runs commands in this workspace.</p>
    </section>
    <section class="grid">
      <article class="card">
        <h2>ChatGPT setup</h2>
        <ol class="steps">
          <li><span class="num">1</span><span>Open ChatGPT settings, Apps, then Create app.</span></li>
          <li><span class="num">2</span><span>Set Connection to <code>Server URL</code>.</span></li>
          <li><span class="num">3</span><span>Paste the copied Least URL into the Server URL field.</span></li>
          <li><span class="num">4</span><span>Use <code>No Authentication / None</code>. The private token is already inside the copied URL.</span></li>
          <li><span class="num">5</span><span>Start with: <code>Use Least as a coding agent. Call server_config, then open_current_workspace.</code></span></li>
        </ol>
      </article>
      <article class="card">
        <h2>Current session</h2>
        <div class="status">
          <div class="row"><span class="label">Workspace</span><span class="mono">${escapeHtml(config.defaultRoot)}</span></div>
          <div class="row"><span class="label">Local MCP</span><span class="mono">${escapeHtml(localMcp)}</span></div>
          ${openAiLine ? `<div class="row"><span class="label">OpenAI /v1</span><span class="mono">http://${escapeHtml(String(config.host))}:${config.port}/v1</span></div>` : ""}
          <div class="row"><span class="label">Write mode</span><span class="pill ${config.writeMode === "workspace" ? "" : "warn"}">${escapeHtml(writeTone)}</span></div>
          <div class="row"><span class="label">Tool mode</span><span class="pill ${config.toolMode === "standard" ? "" : "warn"}">${escapeHtml(config.toolMode)}</span></div>
          <div class="row"><span class="label">Bash mode</span><span class="pill ${config.bashMode === "safe" ? "" : "warn"}">${escapeHtml(config.bashMode)}</span></div>
          <div class="row"><span class="label">Widget domain</span><span class="mono">${escapeHtml(config.widgetDomain)}</span></div>
          <div class="row"><span class="label">Auth</span><span class="pill">${escapeHtml(authLabel)}</span></div>
        </div>
      </article>
    </section>
    ${config.dualClient ? `<section class="card" style="margin-top:18px"><h2>Dual-client setup</h2><p class="lead" style="font-size:14px;max-width:none">ChatGPT should use <code>/mcp?least_token=...</code> with Authentication set to No Auth. Grok should use <code>/mcp-grok</code> with OAuth fields at <code>/oauth/authorize</code>, <code>/oauth/token</code>, client id <code>${escapeHtml(config.grokOAuthClientId)}</code>, scope <code>mcp</code>, and a blank client secret. Both clients share the same workspace and Least token.</p></section>` : grokLine ? `<section class="card" style="margin-top:18px"><h2>Grok OAuth wrapper</h2><p class="lead" style="font-size:14px;max-width:none">Use the same public HTTPS host. The MCP server URL remains <code>/mcp</code>. If Grok asks for OAuth fields, use <code>/oauth/authorize</code>, <code>/oauth/token</code>, client id <code>${escapeHtml(config.grokOAuthClientId)}</code>, scope <code>mcp</code>, and leave client secret blank.</p></section>` : ""}
    <section class="card" style="margin-top:18px">
      <h2>Allowed roots</h2>
      <ul class="roots">${allowedRoots}</ul>
      <p class="footer">This page does not print the Least token. Use the terminal control panel to copy the full Server URL again.</p>
    </section>
  </main>
</body>
</html>`;
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.requireHttpToken && !config.authToken) {
    throw new Error(
      "LEAST_HTTP_TOKEN is required for this HTTP binding. " +
        "Set LEAST_HTTP_TOKEN, use `least start` to generate one, " +
        "or set LEAST_ALLOW_NO_HTTP_TOKEN=1 only for a trusted local-only setup."
    );
  }
  const oauthEnabled = config.dualClient || config.grokOAuth;
  if (oauthEnabled && !config.authToken) {
    throw new Error(
      "LEAST_HTTP_TOKEN is required when Grok OAuth or dual-client mode is enabled because /oauth/token returns the existing Least bearer token."
    );
  }

  const { registry } = createLeastServer(config, { surface: "chatgpt", authMode: "noauth" });
  if (process.env.LEAST_PRINT_TOOLS === "1") {
    const toolNames = registry.list().map((tool) => tool.name).join(", ");
    console.error(`[LeastTools] chatgpt/noauth: ${toolNames}`);
  }

  const app = express();
  const logRequests = process.env.LEAST_LOG_REQUESTS === "1";

  app.use((req, res, next) => {
    if (!logRequests) {
      next();
      return;
    }
    const started = Date.now();
    res.on("finish", () => {
      console.error(`[Least] ${req.method} ${req.path} -> ${res.statusCode} ${Date.now() - started}ms`);
    });
    next();
  });
  app.use(cors({ exposedHeaders: ["Mcp-Session-Id"] }));
  app.use(express.json({ limit: "20mb" }));
  app.use(express.urlencoded({ extended: false }));
  if (oauthEnabled) {
    mountGrokOAuthRoutes(app, config, config.dualClient ? { resourcePath: "/mcp-grok" } : {});
  }

  const hostAuth = createHttpAuthMiddleware(config, { surface: "chatgpt", oauthChallenge: false });

  type TransportRecord = {
    transport: StreamableHTTPServerTransport;
    createdAt: number;
    lastSeenAt: number;
  };

  type McpSurfaceMount = {
    path: string;
    surface: McpSurface;
    authMode: McpAuthMode;
    oauthChallenge: boolean;
  };

  const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function stablePart(value: unknown, fallback: string): string {
    if (typeof value !== "string" || value.trim().length === 0) return fallback;
    return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "_").slice(0, 80) || fallback;
  }

  function lockOwnerIdFromInitialize(body: unknown, surfaceConfig: McpSurfaceMount): string {
    const params = body && typeof body === "object" && "params" in body ? (body as { params?: unknown }).params : undefined;
    const clientInfo = params && typeof params === "object" && "clientInfo" in params
      ? (params as { clientInfo?: unknown }).clientInfo
      : undefined;
    const name = clientInfo && typeof clientInfo === "object" && "name" in clientInfo
      ? (clientInfo as { name?: unknown }).name
      : undefined;
    const version = clientInfo && typeof clientInfo === "object" && "version" in clientInfo
      ? (clientInfo as { version?: unknown }).version
      : undefined;
    const ownerId = [
      "http",
      surfaceConfig.path,
      surfaceConfig.surface,
      surfaceConfig.authMode,
      stablePart(name, "unknown-client"),
      stablePart(version, "unknown-version")
    ].join(":");
    if (process.env.LEAST_LOG_LOCK_OWNER === "1") {
      console.error(`[LeastLockOwner] ${ownerId}`);
    }
    return ownerId;
  }

  function mountMcpSurface(surfaceConfig: McpSurfaceMount): void {
    type LiveRecord = TransportRecord & {
      lockOwnerId: string;
      failCount: number;
    };

    const transports = new Map<string, LiveRecord>();
    const durable = config.httpSessionDurable ? new McpSessionStore(surfaceConfig.path) : null;
    let lastPrunedAt = 0;
    let recentSessionId: string | undefined;
    let recentTransport: StreamableHTTPServerTransport | undefined;

    function logSession(message: string): void {
      if (
        process.env.LEAST_LOG_REQUESTS === "1" ||
        process.env.LEAST_LOG_SESSION_RESUME === "1" ||
        process.env.LEAST_LOG_SESSION === "1"
      ) {
        console.error(`[Least] ${message}`);
      }
    }

    function closeTransport(record: TransportRecord): void {
      void record.transport.close?.().catch?.(() => undefined);
    }

    function forgetLive(sessionId: string | undefined): void {
      if (!sessionId) return;
      transports.delete(sessionId);
      if (recentSessionId === sessionId) {
        recentSessionId = undefined;
        recentTransport = undefined;
      }
    }

    function oldestTransportEntry(): [string, LiveRecord] | undefined {
      let oldest: [string, LiveRecord] | undefined;
      for (const entry of transports) {
        if (!oldest || entry[1].lastSeenAt < oldest[1].lastSeenAt) {
          oldest = entry;
        }
      }
      return oldest;
    }

    function pruneTransports(force = false): void {
      const now = Date.now();
      if (
        !force &&
        now - lastPrunedAt < Math.min(5_000, Math.max(1_000, Math.floor(config.httpSessionTtlMs / 4))) &&
        transports.size < config.maxHttpSessions
      ) {
        return;
      }
      lastPrunedAt = now;
      // Drop idle in-memory transports only. Durable metadata stays so clients can resume.
      for (const [sessionId, record] of transports) {
        if (now - record.lastSeenAt > config.httpSessionTtlMs) {
          forgetLive(sessionId);
          closeTransport(record);
        }
      }
      while (transports.size > config.maxHttpSessions) {
        const oldest = oldestTransportEntry();
        if (!oldest) break;
        forgetLive(oldest[0]);
        closeTransport(oldest[1]);
      }
      durable?.prune(config.httpSessionMetaTtlMs);
      durable?.flush();
    }

    function getLive(sessionId: string | undefined): LiveRecord | undefined {
      if (!sessionId || !sessionIdPattern.test(sessionId)) return undefined;
      pruneTransports(false);
      const record = transports.get(sessionId);
      if (!record) return undefined;
      record.lastSeenAt = Date.now();
      durable?.touch(sessionId);
      recentSessionId = sessionId;
      recentTransport = record.transport;
      return record;
    }

    /**
     * Mark a freshly created Streamable HTTP transport as already initialized so
     * tools/call and tools/list work after a silent session drop (restart, TTL, Funnel blip).
     */
    function markTransportInitialized(transport: StreamableHTTPServerTransport, sessionId: string): void {
      const web = (
        transport as unknown as {
          _webStandardTransport?: { sessionId?: string; _initialized?: boolean; _streamMapping?: Map<string, unknown> };
        }
      )._webStandardTransport;
      if (web) {
        web.sessionId = sessionId;
        web._initialized = true;
        // Clear any half-open SSE stream maps so a new GET cannot 409 after Funnel drops.
        web._streamMapping?.clear?.();
      }
    }

    function defaultLockOwner(sessionId: string): string {
      return [
        "http",
        surfaceConfig.path,
        surfaceConfig.surface,
        surfaceConfig.authMode,
        "durable",
        sessionId.slice(0, 8)
      ].join(":");
    }

    async function createBoundTransport(options: {
      sessionId: string;
      lockOwnerId: string;
      resumed: boolean;
    }): Promise<LiveRecord> {
      // Replace any poisoned live transport for this id.
      const previous = transports.get(options.sessionId);
      if (previous) {
        forgetLive(options.sessionId);
        closeTransport(previous);
      }

      const sessionRef: { current: SessionContext } = {
        current: {
          sessionId: options.sessionId,
          lockOwnerId: options.lockOwnerId,
          surface: surfaceConfig.surface
        }
      };

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => sessionRef.current.sessionId,
        // JSON responses avoid long-lived SSE for each tool call (Funnel-friendly).
        enableJsonResponse: config.httpJsonResponse,
        // Hint clients to retry SSE after brief Funnel blips.
        retryInterval: 3_000,
        onsessioninitialized: (newSessionId: string) => {
          sessionRef.current = {
            sessionId: newSessionId,
            lockOwnerId: options.lockOwnerId,
            surface: surfaceConfig.surface
          };
          const now = Date.now();
          const record: LiveRecord = {
            transport,
            createdAt: now,
            lastSeenAt: now,
            lockOwnerId: options.lockOwnerId,
            failCount: 0
          };
          pruneTransports(true);
          transports.set(newSessionId, record);
          recentSessionId = newSessionId;
          recentTransport = transport;
          durable?.upsert({
            sessionId: newSessionId,
            lockOwnerId: options.lockOwnerId,
            surfacePath: surfaceConfig.path
          });
          durable?.flush();
          pruneTransports(true);
        }
      } as any);

      // Never delete the live map on stream close — only TTL prune or explicit DELETE.
      (transport as any).onclose = () => {
        /* keep session identity alive for multi-request reuse / resume */
      };

      const { server } = createLeastServer(config, {
        surface: surfaceConfig.surface,
        authMode: surfaceConfig.authMode,
        sessionContext: { get: () => sessionRef.current }
      });
      await server.connect(transport);

      const now = Date.now();
      if (options.resumed) {
        markTransportInitialized(transport, options.sessionId);
      }

      const record: LiveRecord = {
        transport,
        createdAt: now,
        lastSeenAt: now,
        lockOwnerId: options.lockOwnerId,
        failCount: 0
      };
      // For initialize (resumed=false), onsessioninitialized will also set the map when the body is handled.
      // Still register early so concurrent requests with the same id can attach.
      transports.set(options.sessionId, record);
      recentSessionId = options.sessionId;
      recentTransport = transport;
      durable?.upsert({
        sessionId: options.sessionId,
        lockOwnerId: options.lockOwnerId,
        surfacePath: surfaceConfig.path
      });
      if (options.resumed) {
        logSession(`Resumed MCP session ${options.sessionId} on ${surfaceConfig.path}`);
      }
      return record;
    }

    async function ensureSession(options: {
      sessionId: string;
      lockOwnerId?: string;
      forceNew?: boolean;
      reason: string;
    }): Promise<LiveRecord> {
      if (!options.forceNew) {
        const live = getLive(options.sessionId);
        if (live) return live;
      }
      const durableHit = durable?.get(options.sessionId);
      const lockOwnerId =
        options.lockOwnerId || durableHit?.lockOwnerId || defaultLockOwner(options.sessionId);
      logSession(`Ensure session ${options.sessionId} (${options.reason}) on ${surfaceConfig.path}`);
      return createBoundTransport({
        sessionId: options.sessionId,
        lockOwnerId,
        resumed: true
      });
    }

    async function handleWithHeal(
      sessionId: string | undefined,
      res: express.Response,
      run: (transport: StreamableHTTPServerTransport) => Promise<void>
    ): Promise<void> {
      const firstId = sessionId && sessionIdPattern.test(sessionId) ? sessionId : undefined;
      let record =
        (firstId ? getLive(firstId) : undefined) ||
        (firstId && config.httpSessionResume
          ? await ensureSession({ sessionId: firstId, reason: "missing-live" })
          : undefined);
      if (!record) {
        throw new Error("missing transport");
      }
      try {
        await run(record.transport);
        record.failCount = 0;
        record.lastSeenAt = Date.now();
        durable?.touch(record.transport.sessionId || firstId || "");
      } catch (error) {
        // Transport often goes bad after Funnel/SSE drops — rebuild once and retry.
        if (!firstId || !config.httpSessionResume || record.failCount >= 1 || res.headersSent) {
          throw error;
        }
        record.failCount += 1;
        logSession(
          `Healing MCP session ${firstId} after transport error: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        record = await ensureSession({
          sessionId: firstId,
          lockOwnerId: record.lockOwnerId,
          forceNew: true,
          reason: "heal-retry"
        });
        await run(record.transport);
        record.failCount = 0;
      }
    }

    const pruneTimer = setInterval(pruneTransports, Math.min(config.httpSessionTtlMs, 60_000));
    pruneTimer.unref();
    // Periodic durable flush / meta prune
    const durableTimer = setInterval(() => {
      durable?.prune(config.httpSessionMetaTtlMs);
      durable?.flush();
    }, 60_000);
    durableTimer.unref();

    const routeAuth = createHttpAuthMiddleware(config, {
      surface: surfaceConfig.surface,
      oauthChallenge: surfaceConfig.oauthChallenge
    });

    app.post(surfaceConfig.path, routeAuth, async (req, res) => {
      try {
        const sessionIdHeader = req.headers["mcp-session-id"];
        const sessionId = typeof sessionIdHeader === "string" ? sessionIdHeader : undefined;

        if (isInitializeRequest(req.body)) {
          const lockOwnerId = lockOwnerIdFromInitialize(req.body, surfaceConfig);
          const preferredId =
            sessionId && sessionIdPattern.test(sessionId) ? sessionId : randomUUID();
          // Always start initialize on a clean transport for this id.
          const record = await createBoundTransport({
            sessionId: preferredId,
            lockOwnerId,
            resumed: false
          });
          await record.transport.handleRequest(req, res, req.body);
          record.lastSeenAt = Date.now();
          durable?.upsert({
            sessionId: preferredId,
            lockOwnerId,
            surfacePath: surfaceConfig.path
          });
          durable?.flush();
          return;
        }

        if (!sessionId || !sessionIdPattern.test(sessionId)) {
          res.status(400).json({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message:
                "Bad Request: missing or invalid MCP session id. Open a new chat or re-initialize the connector."
            },
            id: null
          });
          return;
        }

        if (!config.httpSessionResume && !getLive(sessionId) && !durable?.get(sessionId)) {
          res.status(400).json({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: "Bad Request: MCP session not found and resume is disabled."
            },
            id: null
          });
          return;
        }

        await handleWithHeal(sessionId, res, async (transport) => {
          await transport.handleRequest(req, res, req.body);
        });
      } catch (error) {
        console.error(error);
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
            id: null
          });
        }
      }
    });

    const handleSessionRequest = async (req: express.Request, res: express.Response) => {
      const sessionIdHeader = req.headers["mcp-session-id"];
      const sessionId = typeof sessionIdHeader === "string" ? sessionIdHeader : undefined;

      if (!sessionId || !sessionIdPattern.test(sessionId)) {
        res.status(400).send("Invalid or missing MCP session id");
        return;
      }

      if (req.method === "DELETE") {
        const live = getLive(sessionId);
        if (live) {
          try {
            await live.transport.handleRequest(req, res);
          } catch {
            if (!res.headersSent) res.status(200).end();
          }
          forgetLive(sessionId);
          closeTransport(live);
        } else if (!res.headersSent) {
          res.status(200).end();
        }
        // Keep durable metadata by default so a flaky client DELETE cannot brick the chat.
        // Hard delete only when explicitly requested.
        if (process.env.LEAST_HTTP_SESSION_HARD_DELETE === "1") {
          durable?.delete(sessionId);
          durable?.flush();
        }
        return;
      }

      // GET SSE: always prefer a healthy transport; force new if previous stream was poisoned.
      try {
        let record = getLive(sessionId);
        if (!record && config.httpSessionResume) {
          record = await ensureSession({ sessionId, reason: "get-resume" });
        }
        if (!record) {
          res.status(400).send("Invalid or missing MCP session id");
          return;
        }
        try {
          await record.transport.handleRequest(req, res);
          record.lastSeenAt = Date.now();
          durable?.touch(sessionId);
        } catch (error) {
          logSession(
            `Recreating SSE transport for ${sessionId}: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
          record = await ensureSession({
            sessionId,
            lockOwnerId: record.lockOwnerId,
            forceNew: true,
            reason: "get-heal"
          });
          await record.transport.handleRequest(req, res);
        }
      } catch (error) {
        console.error(error);
        if (!res.headersSent) {
          res.status(500).send(error instanceof Error ? error.message : String(error));
        }
      }
    };

    app.get(surfaceConfig.path, routeAuth, handleSessionRequest);
    app.delete(surfaceConfig.path, routeAuth, handleSessionRequest);
  }

  app.get("/", hostAuth, (_req, res) => {
    res.type("html").send(onboardingPage(config));
  });

  app.get("/setup", hostAuth, (_req, res) => {
    res.type("html").send(onboardingPage(config));
  });

  app.get("/healthz", hostAuth, (_req, res) => {
    res.json({
      ok: true,
      name: "Least",
      defaultRoot: config.defaultRoot,
      allowedRoots: config.allowedRoots,
      bashMode: config.bashMode,
      writeMode: config.writeMode,
      toolMode: config.toolMode,
      toolset: config.toolset,
      widgetDomain: config.widgetDomain,
      contextDir: config.contextDir,
      warmup: config.warmup,
      authEnabled: Boolean(config.authToken),
      authRequired: config.requireHttpToken,
      dualClient: config.dualClient,
      concurrencyMode: config.concurrencyMode,
      lockLeaseMs: config.lockLeaseMs
    });
  });

  if (config.httpProtocols.includes("mcp")) {
    if (config.dualClient) {
      mountMcpSurface({ path: "/mcp", surface: "chatgpt", authMode: "noauth", oauthChallenge: false });
      mountMcpSurface({ path: "/mcp-grok", surface: "grok", authMode: "oauth2", oauthChallenge: true });
    } else {
      mountMcpSurface({
        path: "/mcp",
        surface: config.grokOAuth ? "grok" : "chatgpt",
        authMode: config.grokOAuth ? "oauth2" : "noauth",
        oauthChallenge: config.grokOAuth
      });
    }
  }

  if (config.httpProtocols.includes("openai")) {
    app.use("/v1", hostAuth);
    mountOpenAiRoutes(app, config, registry);
  }

  const server = app.listen(config.port, config.host, () => {
    console.error(`[Least] HTTP protocols: ${config.httpProtocols.join(", ")}`);
    if (config.httpProtocols.includes("mcp")) {
      if (config.dualClient) {
        console.error(`[Least] ChatGPT MCP listening on http://${config.host}:${config.port}/mcp`);
        console.error(`[Least] Grok MCP listening on http://${config.host}:${config.port}/mcp-grok`);
      } else {
        console.error(`[Least] HTTP MCP listening on http://${config.host}:${config.port}/mcp`);
      }
      console.error(
        `[Least] MCP durability: resume=${config.httpSessionResume ? "on" : "off"} durable=${
          config.httpSessionDurable ? "on" : "off"
        } jsonResponse=${config.httpJsonResponse ? "on" : "off"} sessionTtlMs=${config.httpSessionTtlMs}`
      );
    }
    if (config.httpProtocols.includes("openai")) {
      console.error(
        `[Least] OpenAI-compatible API: http://${config.host}:${config.port}/v1/chat/completions`
      );
    }
    console.error(`[Least] defaultRoot=${config.defaultRoot}`);
    console.error(`[Least] allowedRoots=${config.allowedRoots.join(", ")}`);
    console.error(`[Least] bashMode=${config.bashMode}`);
    console.error(`[Least] writeMode=${config.writeMode}`);
    console.error(`[Least] widgetDomain=${config.widgetDomain}`);
    if (config.dualClient) console.error(`[Least] dualClient=enabled`);
    // Start dashboard if enabled
    void startDashboardServer(config).catch((err: Error) => {
      console.error(`[Least] Dashboard failed to start: ${err.message}`);
    });
  });

  // Long-lived MCP + Funnel: avoid premature socket kills during model think time / tool runs.
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 125_000;
  // Node 18+: requestTimeout 0 = no hard request timeout (tools may run a while).
  (server as typeof server & { requestTimeout?: number }).requestTimeout = 0;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
