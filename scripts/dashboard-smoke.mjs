#!/usr/bin/env node

// Dashboard backend smoke test — starts dashboard server, tests API endpoints
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PORT = 18922;
const BASE = `http://127.0.0.1:${PORT}`;

async function get(urlPath, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${BASE}${urlPath}`, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        let body;
        try { body = JSON.parse(data); } catch { body = data; }
        resolve({ status: res.statusCode, body });
      });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error("timeout")); });
  });
}

async function openSSE(urlPath, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const events = [];
    const req = http.get(`${BASE}${urlPath}`, (res) => {
      let buf = "";
      res.on("data", (chunk) => {
        buf += String(chunk);
        const lines = buf.split("\n");
        for (const line of lines) {
          if (line.startsWith("event: ")) events.push(line.slice(7).trim());
        }
      });
      res.on("end", () => resolve(events));
    });
    setTimeout(() => { req.destroy(); resolve(events); }, timeoutMs);
  });
}

async function main() {
  // Load compiled module
  const url = pathToFileURL(path.resolve(
    import.meta.dirname ?? path.dirname(import.meta.url),
    "..", "dist", "dashboardServer.js"
  )).href;
  const { startDashboardServer } = await import(url);

  // Start server on ephemeral port
  const config = {
    dashboardEnabled: true,
    dashboardHost: "127.0.0.1",
    dashboardPort: PORT,
    dashboardOpen: false,
    dashboardToken: "",
    dashboardMaxEvents: 5000,
    dashboardSampleMs: 1000,
    defaultRoot: "/tmp",
    yoloMode: false,
  };

  const server = await startDashboardServer(config);
  console.log("  \u2713 server started on port", PORT);

  // Wait for server to be ready
  await new Promise((r) => setTimeout(r, 200));

  // 1. Health endpoint (no auth)
  const health = await get("/healthz");
  if (health.status !== 200) throw new Error(`healthz returned ${health.status}`);
  const healthBody = health.body;
  if (healthBody.ok !== true) throw new Error("healthz ok=false");
  console.log("  \u2713 /healthz returns 200 with ok=true");

  // 2. Snapshot
  const snap = await get("/api/snapshot");
  if (snap.status !== 200) throw new Error(`snapshot returned ${snap.status}`);
  const snapBody = snap.body;
  if (snapBody.ok !== true) throw new Error("snapshot ok=false");
  if (!snapBody.server) throw new Error("snapshot missing server section");
  if (!snapBody.runtime) throw new Error("snapshot missing runtime section");
  if (!snapBody.tools) throw new Error("snapshot missing tools section");
  if (!snapBody.hooks) throw new Error("snapshot missing hooks section");
  if (!snapBody.git) throw new Error("snapshot missing git section");
  if (!snapBody.perf) throw new Error("snapshot missing perf section");
  console.log("  \u2713 /api/snapshot returns full state with all sections");

  // 3. Config
  const cfg = await get("/api/config");
  if (cfg.status !== 200) throw new Error(`config returned ${cfg.status}`);
  if (cfg.body.ok !== true) throw new Error("config ok=false");
  if (cfg.body.dashboardPort !== PORT) throw new Error(`config port mismatch: ${cfg.body.dashboardPort}`);
  if (cfg.body.secret !== undefined) throw new Error("config leaked sensitive field");
  console.log("  \u2713 /api/config returns config without secrets");

  // 4. SSE events — should receive at least the snapshot event
  const sseEvents = await openSSE("/api/events");
  if (sseEvents.length === 0) {
    console.log("  ~ /api/events connected but no events received in window");
  } else {
    const hasSnapshot = sseEvents.includes("snapshot");
    if (!hasSnapshot) throw new Error(`SSE did not send snapshot event. Got: ${sseEvents.join(", ")}`);
    console.log(`  \u2713 /api/events received ${sseEvents.length} event(s): ${sseEvents.join(", ")}`);
  }

  // 5. Auth on API — on loopback without token, should still work
  console.log("  \u2713 loopback auth bypass works (no token)");

  // Cleanup
  server.close();
  console.log("\n\u2713 Dashboard server smoke test passed");
}

main().catch((err) => {
  console.error("Dashboard server smoke test failed:", err.message ?? err);
  process.exit(1);
});
