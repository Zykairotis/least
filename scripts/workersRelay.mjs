import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const WORKERS_RELAY_TUNNEL = "workers-relay";
export const ALLOWED_RELAY_PATHS = [
  /^\/$/,
  /^\/healthz$/,
  /^\/setup$/,
  /^\/mcp(?:-grok)?$/,
  /^\/oauth(?:\/|$)/,
  /^\/\.well-known\/oauth-[a-z0-9-]+(?:\/.*)?$/
];
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
  "host"
]);

export function pathAllowed(pathname) {
  return ALLOWED_RELAY_PATHS.some((re) => re.test(pathname));
}

export function workersRelayDir() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "relay", "cloudflare-worker");
}

export function workersRelayStatePath(home = process.env.LEAST_HOME || path.join(os.homedir(), ".least")) {
  return path.join(home, "workers-relay.json");
}

export function loadWorkersRelayState(home) {
  const filePath = workersRelayStatePath(home);
  if (!fs.existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function saveWorkersRelayState(state, home) {
  const filePath = workersRelayStatePath(home);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const next = {
    version: 1,
    hostname: "",
    relayToken: "",
    workerName: "least-relay",
    ...loadWorkersRelayState(home),
    ...state,
    updatedAt: new Date().toISOString()
  };
  fs.writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    /* ignore */
  }
  return next;
}

export function publicHostnameFromRelayUrl(input) {
  if (!input) return "";
  const raw = String(input).includes("://") ? String(input) : `https://${input}`;
  const url = new URL(raw);
  return url.hostname;
}

export function filterOutboundHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

export function relayForwardHeaders(headers, publicHostname) {
  const out = filterOutboundHeaders(headers);
  const incoming = headers && typeof headers === "object" ? headers : {};
  const forwardedHost =
    incoming["x-forwarded-host"] ||
    incoming["X-Forwarded-Host"] ||
    incoming.host ||
    incoming.Host ||
    publicHostname;
  if (forwardedHost) out["x-forwarded-host"] = String(forwardedHost).split(",")[0].trim();
  out["x-forwarded-proto"] = "https";
  return out;
}

function commandExists(command) {
  const result = spawnSync(process.platform === "win32" ? "where" : "command", process.platform === "win32" ? [command] : ["-v", command], {
    shell: process.platform !== "win32",
    stdio: "ignore"
  });
  return result.status === 0;
}

async function loadWebSocket() {
  if (typeof globalThis.WebSocket === "function") return globalThis.WebSocket;
  const undici = await import("undici");
  if (typeof undici.WebSocket === "function") return undici.WebSocket;
  throw new Error("WebSocket is not available. Use Node.js 22+ (or a Node 20 build with undici WebSocket).");
}

export function parseWranglerDeployHostname(output) {
  const text = String(output || "");
  const match = text.match(/https:\/\/([a-z0-9.-]+\.workers\.dev)/i);
  return match?.[1] || "";
}

export async function deployWorkersRelay({ log = console.error } = {}) {
  const dir = workersRelayDir();
  if (!fs.existsSync(path.join(dir, "wrangler.toml"))) {
    throw new Error(`Relay worker is missing at ${dir}`);
  }
  const wranglerBin = commandExists("wrangler") ? "wrangler" : "";
  const npx = commandExists("npx") ? "npx" : "";
  if (!wranglerBin && !npx) {
    throw new Error("wrangler is not installed. Install it with: npm install -g wrangler");
  }
  const run = (args, options = {}) =>
    spawnSync(wranglerBin || npx, wranglerBin ? args : ["--yes", "wrangler", ...args], {
      cwd: dir,
      encoding: "utf8",
      env: process.env,
      ...options
    });

  log("[least] Checking Cloudflare login (wrangler whoami)");
  const who = run(["whoami"]);
  if (who.status !== 0 || /not authenticated/i.test(`${who.stdout}\n${who.stderr}`)) {
    throw new Error(
      [
        "Cloudflare is not logged in on this machine.",
        "",
        "  npx wrangler login",
        "",
        "Then rerun: least relay-deploy"
      ].join("\n")
    );
  }

  const existing = loadWorkersRelayState();
  const relayToken = existing.relayToken || randomBytes(32).toString("hex");
  log("[least] Publishing RELAY_TOKEN to the Worker");
  const secret = run(["secret", "put", "RELAY_TOKEN"], { input: `${relayToken}\n` });
  if (secret.status !== 0) {
    throw new Error(`wrangler secret put failed:\n${secret.stderr || secret.stdout}`);
  }

  log("[least] Deploying least-relay Worker");
  const deployed = run(["deploy"]);
  const combined = `${deployed.stdout}\n${deployed.stderr}`;
  if (deployed.status !== 0) {
    throw new Error(`wrangler deploy failed:\n${combined}`);
  }
  const hostname = parseWranglerDeployHostname(combined);
  if (!hostname) {
    throw new Error(`Deploy succeeded but no *.workers.dev hostname was found in wrangler output:\n${combined}`);
  }
  const saved = saveWorkersRelayState({ hostname, relayToken, workerName: "least-relay" });
  return { ...saved, output: combined };
}

export function startWorkersRelayAgent(options) {
  const hostname = publicHostnameFromRelayUrl(options.hostname);
  const relayToken = options.relayToken;
  const localBase = String(options.localBase || "http://127.0.0.1:8787").replace(/\/$/, "");
  const log = options.log || ((line) => console.error(line));
  if (!hostname) throw new Error("workers-relay needs the deployed workers.dev hostname");
  if (!relayToken) throw new Error("workers-relay needs RELAY_TOKEN from least relay-deploy");

  let stopped = false;
  let socket;
  let timer;
  let attempt = 0;
  let WebSocketImpl;

  const connect = async () => {
    if (stopped) return;
    WebSocketImpl = WebSocketImpl || (await loadWebSocket());
    const url = `wss://${hostname}/agent?relay_token=${encodeURIComponent(relayToken)}`;
    log(`[least] Relay agent connecting to wss://${hostname}/agent`);
    socket = new WebSocketImpl(url);
    socket.addEventListener("open", () => {
      attempt = 0;
      log("[least] Relay agent connected");
      try {
        socket.send(JSON.stringify({ t: "hello" }));
      } catch {
        /* ignore */
      }
    });
    socket.addEventListener("message", (event) => {
      void handleMessage(String(event.data ?? event));
    });
    socket.addEventListener("close", (event) => {
      if (stopped) return;
      log(`[least] Relay agent disconnected (${event.code || ""} ${event.reason || ""}). Reconnecting.`);
      scheduleReconnect();
    });
    socket.addEventListener("error", () => {
      if (stopped) return;
      log("[least] Relay agent socket error");
    });
  };

  const scheduleReconnect = () => {
    if (stopped) return;
    attempt += 1;
    const delay = Math.min(15_000, 500 * 2 ** Math.min(attempt, 5));
    timer = setTimeout(connect, delay);
    timer.unref?.();
  };

  const handleMessage = async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || msg.t !== "http") return;
    if (typeof msg.path !== "string" || !pathAllowed(new URL(msg.path, "http://least.local").pathname)) {
      socket?.send(JSON.stringify({ t: "err", id: msg.id, message: "path not allowed" }));
      return;
    }
    try {
      const headers = relayForwardHeaders(msg.headers, hostname);
      const body = msg.bodyB64 ? Buffer.from(msg.bodyB64, "base64") : undefined;
      const response = await fetch(`${localBase}${msg.path}`, {
        method: msg.method || "GET",
        headers,
        body,
        redirect: "manual"
      });
      const outHeaders = {};
      response.headers.forEach((value, key) => {
        if (!HOP_BY_HOP.has(key.toLowerCase())) outHeaders[key] = value;
      });
      socket?.send(JSON.stringify({ t: "head", id: msg.id, status: response.status, headers: outHeaders }));
      if (response.body) {
        for await (const chunk of response.body) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          const pieceSize = 48 * 1024;
          for (let i = 0; i < buf.length; i += pieceSize) {
            socket?.send(
              JSON.stringify({
                t: "data",
                id: msg.id,
                chunkB64: buf.subarray(i, i + pieceSize).toString("base64")
              })
            );
          }
        }
      }
      socket?.send(JSON.stringify({ t: "end", id: msg.id }));
    } catch (error) {
      socket?.send(
        JSON.stringify({
          t: "err",
          id: msg.id,
          message: error instanceof Error ? error.message : String(error)
        })
      );
    }
  };

  connect();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      try {
        socket?.close(1000, "stop");
      } catch {
        /* ignore */
      }
    }
  };
}
