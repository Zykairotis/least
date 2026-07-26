import express from "express";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import url from "node:url";
import type { LeastConfig } from "./config.js";
import type { DashboardEvent } from "./dashboardTypes.js";
import { subscribeDashboardEvents, getDashboardEventsSince } from "./dashboardEvents.js";
import { buildDashboardSnapshot, setDashboardConfig, setDashboardStarted, setDashboardClientCount, setDashboardStreaming, updateGitSnapshot } from "./dashboardSnapshot.js";
import { createDashboardAuthMiddleware } from "./dashboardAuth.js";
import * as dashboardStore from "./dashboardStore.js";
import type { PerfWindowName } from "./perf.js";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const DIST_DIR = path.resolve(__dirname, "..", "dist", "dashboard");

let _config: LeastConfig | undefined;
let _connectedClients = new Set<string>();
let _gitInterval: NodeJS.Timeout | undefined;

function sendSSE(res: express.Response, eventName: string, data: unknown, id?: number): void {
  if (id != null) res.write(`id: ${id}\n`);
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export async function startDashboardServer(config: LeastConfig): Promise<http.Server> {
  if (!config.dashboardEnabled) {
    const noop = new http.Server();
    noop.close();
    return noop;
  }
  _config = config;
  setDashboardConfig(config);
  setDashboardStarted();
  setDashboardMaxEvents(config.dashboardMaxEvents);
  dashboardStore.initDashboardStore(config.dashboardDbPath || ".least/dashboard.db");

  const app = express();
  const auth = createDashboardAuthMiddleware(config);

  // Health (no auth)
  app.get("/healthz", (_req: any, res: any) => {
    res.json({ ok: true, name: "Least Dashboard" });
  });

  // API routes (behind auth)
  const api = express.Router();
  api.use(auth);

  api.get("/snapshot", (req: any, res: any) => {
    const windowName = (req.query.window as PerfWindowName) ?? "session";
    const snapshot = buildDashboardSnapshot(200, windowName);
    res.json({ ok: true, ...snapshot });
  });

  api.get("/config", (_req: any, res: any) => {
    res.json({
      ok: true,
      dashboardHost: config.dashboardHost,
      dashboardPort: config.dashboardPort,
      dashboardEnabled: config.dashboardEnabled,
      dashboardMaxEvents: config.dashboardMaxEvents,
      dashboardSampleMs: config.dashboardSampleMs,
      dashboardOpen: config.dashboardOpen,
      startedAt: new Date().toISOString(),
    });
  });

  api.get("/log-sessions", (req: any, res: any) => {
    const limit = typeof req.query.limit === "string" ? Number.parseInt(req.query.limit, 10) : 100;
    res.json({ ok: true, dbPath: dashboardStore.getDashboardStorePath(), sessions: dashboardStore.listStoredSessions(Number.isFinite(limit) ? limit : 100) });
  });

  api.get("/stored-events", (req: any, res: any) => {
    const sid = typeof req.query.sessionId === "string" ? req.query.sessionId : "default";
    const limit = typeof req.query.limit === "string" ? Number.parseInt(req.query.limit, 10) : 500;
    res.json({ ok: true, events: dashboardStore.listStoredSessionEvents(sid, Number.isFinite(limit) ? limit : 500) });
  });

  api.get("/stored-tool-calls", (req: any, res: any) => {
    const sid = typeof req.query.sessionId === "string" ? req.query.sessionId : "default";
    const limit = typeof req.query.limit === "string" ? Number.parseInt(req.query.limit, 10) : 500;
    res.json({ ok: true, toolCalls: dashboardStore.listStoredToolCalls(sid, Number.isFinite(limit) ? limit : 500) });
  });

  api.get("/agent-jobs", (req: any, res: any) => {
    const limit = typeof req.query.limit === "string" ? Number.parseInt(req.query.limit, 10) : 100;
    res.json({ ok: true, jobs: dashboardStore.listStoredAgentJobs(Number.isFinite(limit) ? limit : 100) });
  });

  api.get("/agent-terminal-sessions", (req: any, res: any) => {
    const limit = typeof req.query.limit === "string" ? Number.parseInt(req.query.limit, 10) : 500;
    res.json({ ok: true, terminalSessions: dashboardStore.listStoredAgentTerminalSessions(Number.isFinite(limit) ? limit : 500) });
  });

  api.get("/events", (req: any, res: any) => {
    const clientId = `client-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    // Prefer Last-Event-ID (browser auto-reconnect) over query param.
    const headerId = req.headers["last-event-id"];
    const sinceFromHeader = typeof headerId === "string" ? Number.parseInt(headerId, 10) : Number.NaN;
    const sinceFromQuery = typeof req.query.since === "string" ? Number.parseInt(req.query.since, 10) : Number.NaN;
    const sinceId = Number.isFinite(sinceFromHeader) && sinceFromHeader > 0
      ? sinceFromHeader
      : Number.isFinite(sinceFromQuery) && sinceFromQuery > 0
        ? sinceFromQuery
        : 0;

    const snapshot = buildDashboardSnapshot(200);
    sendSSE(res, "snapshot", { ok: true, ...snapshot });
    if (sinceId > 0) {
      const backlog = getDashboardEventsSince(sinceId);
      for (const event of backlog) sendSSE(res, "dashboard", event, event.id);
    }
    _connectedClients.add(clientId);
    setDashboardClientCount(_connectedClients.size);
    setDashboardStreaming(true);
    ensureGitPolling(config);
    // Push current git state immediately so UI is not empty until first poll tick.
    void updateGitSnapshot(config).catch(() => {});
    const unsub = subscribeDashboardEvents((event: DashboardEvent) => {
      try { sendSSE(res, "dashboard", event, event.id); } catch { unsub(); }
    });
    const heartbeat = setInterval(() => {
      try {
        // Named heartbeat event so clients can show "live" without full snapshot.
        sendSSE(res, "heartbeat", { ts: new Date().toISOString(), clients: _connectedClients.size });
      } catch {
        clearInterval(heartbeat);
      }
    }, 12_000);
    req.on("close", () => {
      clearInterval(heartbeat); unsub();
      _connectedClients.delete(clientId);
      setDashboardClientCount(_connectedClients.size);
      if (_connectedClients.size === 0) { setDashboardStreaming(false); stopGitPolling(); }
    });
  });

  app.use("/api", api);

  // Static assets (behind auth)
  const dashboardBuilt = fs.existsSync(path.join(DIST_DIR, "index.html"));
  if (dashboardBuilt) {
    app.use(auth, express.static(DIST_DIR, { maxAge: "1h" }));
    app.get("/{*path}", auth, (req: any, res: any) => {
      if (req.path.startsWith("/api/") || req.path === "/healthz") return;
      res.sendFile(path.join(DIST_DIR, "index.html"));
    });
  } else {
    app.get("/{*path}", (_req: any, res: any) => {
      res.type("html").send(BUILD_ERROR_HTML);
    });
  }

  return new Promise((resolve, reject) => {
    const server = app.listen(config.dashboardPort, config.dashboardHost, () => {
      resolve(server);
    });
    server.on("error", (err: Error) => {
      reject(err);
    });
  });
}

function ensureGitPolling(config: LeastConfig): void {
  if (_gitInterval) return;
  // Default 5s — event-driven tool activity already refreshes snapshot on the client.
  const intervalMs = Number(process.env.LEAST_DASHBOARD_GIT_INTERVAL_MS) || 5_000;
  _gitInterval = setInterval(async () => {
    if (_connectedClients.size === 0) return;
    try { await updateGitSnapshot(config); } catch { /* best-effort */ }
  }, intervalMs);
  _gitInterval.unref();
}

function stopGitPolling(): void {
  if (_gitInterval) { clearInterval(_gitInterval); _gitInterval = undefined; }
}

function setDashboardMaxEvents(n: number): void {
  import("./dashboardEvents.js").then((mod) => mod.setDashboardMaxEvents(n)).catch(() => {});
}

const BUILD_ERROR_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Least Dashboard</title>
<style>
body{background:#030407;color:#c8d0dc;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{background:#0a0d12;border:1px solid rgba(77,109,140,0.2);border-radius:8px;padding:2rem;max-width:480px;text-align:center}
h1{color:#7ab8b6;font-size:1.25rem;margin:0 0 .75rem}
p{color:#7b8799;margin:.5rem 0;line-height:1.5}
code{background:#0f131a;padding:2px 6px;border-radius:4px;font-size:.9em;color:#c4a86a}
</style>
</head>
<body><div class="card">
<h1>Least Dashboard</h1>
<p>Dashboard assets are not yet built.</p>
<p>Run <code>npm run dashboard:build</code> to build them, or start the Vite dev server with <code>npm run dashboard:dev</code>.</p>
</div></body>
</html>`;
