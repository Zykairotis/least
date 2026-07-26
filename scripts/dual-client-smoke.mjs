import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function waitForListening(child) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timeout = setTimeout(() => reject(new Error(`server did not start\n${stderr}`)), 20_000);
    const onData = (chunk) => {
      stderr += String(chunk);
      if (stderr.includes("dualClient=enabled")) {
        clearTimeout(timeout);
        child.stderr.off("data", onData);
        resolve();
      }
    };
    child.stderr.on("data", onData);
    child.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`server exited early with code ${code}\n${stderr}`));
    });
  });
}

function pkceChallenge(verifier) {
  return createHash("sha256").update(verifier).digest("base64url");
}

function locationParam(location, name) {
  const url = new URL(location);
  return url.searchParams.get(name);
}

async function listMcpTools(url, token) {
  const client = new Client({ name: "least-dual-client-smoke", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  });
  try {
    await client.connect(transport);
    const result = await client.listTools();
    return result.tools;
  } finally {
    await client.close();
  }
}

function runSync(args, env) {
  return spawnSync(process.execPath, ["scripts/least.mjs", ...args], {
    cwd: path.resolve("."),
    env,
    encoding: "utf8"
  });
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "least-dual-client-smoke-"));
const home = await fs.mkdtemp(path.join(os.tmpdir(), "least-dual-client-home-"));
const port = await getFreePort();
const token = "least-dual-client-smoke-token";
const base = `http://127.0.0.1:${port}`;
const redirectUri = "https://example.com/callback";
const verifier = "least-dual-client-verifier";
const challenge = pkceChallenge(verifier);

const settingsResult = runSync(
  [
    "settings",
    "set",
    "--root",
    root,
    "--tunnel",
    "tailscale-funnel",
    "--dual-client",
    "--token",
    token
  ],
  { ...process.env, LEAST_HOME: home }
);
if (settingsResult.status !== 0 || !settingsResult.stdout.includes("Saved workspace settings")) {
  throw new Error(`failed to save dual-client settings\n${settingsResult.stdout}\n${settingsResult.stderr}`);
}
const settingsShow = runSync(["settings", "show", "--root", root], { ...process.env, LEAST_HOME: home });
if (!settingsShow.stdout.includes("Dual client") || !settingsShow.stdout.includes("/mcp-grok")) {
  throw new Error(`settings show did not preserve dual-client\n${settingsShow.stdout}`);
}

const doctorPort = await getFreePort();
const doctorResult = runSync(
  ["doctor", "--root", root, "--dual-client", "--tunnel", "tailscale-funnel", "--port", String(doctorPort)],
  { ...process.env, LEAST_HOME: home }
);
if (doctorResult.status !== 0) {
  throw new Error(`dual-client doctor failed\n${doctorResult.stdout}\n${doctorResult.stderr}`);
}
const doctorOutput = `${doctorResult.stdout}\n${doctorResult.stderr}`;
if (!doctorOutput.includes("Dual client") || !doctorOutput.includes("/mcp-grok")) {
  throw new Error(`doctor output missing dual-client paths\n${doctorOutput}`);
}

const child = spawn("node", ["dist/http.js"], {
  cwd: path.resolve("."),
  env: {
    ...process.env,
    LEAST_ROOT: root,
    LEAST_ALLOWED_ROOTS: root,
    LEAST_PORT: String(port),
    LEAST_HTTP_TOKEN: token,
    LEAST_DUAL_CLIENT: "1",
    LEAST_GROK_OAUTH_CLIENT_ID: "least-grok",
    LEAST_HTTP_PROTOCOLS: "mcp",
    LEAST_BASH_MODE: "safe",
    LEAST_WRITE_MODE: "handoff"
  },
  stdio: ["ignore", "pipe", "pipe"]
});

try {
  await waitForListening(child);

  const metadata = await fetch(`${base}/.well-known/oauth-protected-resource`, {
    headers: { "X-Forwarded-Proto": "https", "X-Forwarded-Host": "least.example.test" }
  });
  if (metadata.status !== 200) {
    throw new Error(`protected-resource metadata expected 200, got ${metadata.status}`);
  }
  const metadataJson = await metadata.json();
  if (metadataJson.resource !== "https://least.example.test/mcp-grok") {
    throw new Error(`unexpected protected-resource metadata: ${JSON.stringify(metadataJson)}`);
  }

  const unauthorizedChatgpt = await fetch(`${base}/mcp`, { method: "POST" });
  const chatgptChallenge = unauthorizedChatgpt.headers.get("www-authenticate") ?? "";
  if (unauthorizedChatgpt.status !== 401 || chatgptChallenge) {
    throw new Error(`unauthorized /mcp expected plain 401, got ${unauthorizedChatgpt.status} ${chatgptChallenge}`);
  }

  const unauthorizedGrok = await fetch(`${base}/mcp-grok`, { method: "POST" });
  const grokChallenge = unauthorizedGrok.headers.get("www-authenticate") ?? "";
  if (unauthorizedGrok.status !== 401 || !grokChallenge.includes("/.well-known/oauth-protected-resource")) {
    throw new Error(`unauthorized /mcp-grok expected OAuth challenge, got ${unauthorizedGrok.status} ${grokChallenge}`);
  }

  const chatgptTools = await listMcpTools(`${base}/mcp?least_token=${encodeURIComponent(token)}`);
  const chatgptConfig = chatgptTools.find((tool) => tool.name === "server_config");
  const chatgptSchemes = chatgptConfig?._meta?.securitySchemes ?? chatgptConfig?.securitySchemes ?? [];
  if (!chatgptSchemes.some((scheme) => scheme.type === "noauth")) {
    throw new Error(`ChatGPT /mcp missing noauth security scheme: ${JSON.stringify(chatgptConfig)}`);
  }

  const authorizeUrl = new URL(`${base}/oauth/authorize`);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", "least-grok");
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("scope", "mcp");
  authorizeUrl.searchParams.set("state", "dual123");
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  const approve = await fetch(`${base}/oauth/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      response_type: "code",
      client_id: "least-grok",
      redirect_uri: redirectUri,
      scope: "mcp",
      state: "dual123",
      code_challenge: challenge,
      code_challenge_method: "S256",
      approve: "1"
    }),
    redirect: "manual"
  });
  if (approve.status !== 302) {
    throw new Error(`POST /oauth/approve expected 302, got ${approve.status}`);
  }
  const code = locationParam(approve.headers.get("location") ?? "", "code");
  if (!code) {
    throw new Error("approve redirect missing code");
  }

  const tokenResponse = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: "least-grok",
      redirect_uri: redirectUri,
      code_verifier: verifier
    })
  });
  if (tokenResponse.status !== 200) {
    throw new Error(`POST /oauth/token expected 200, got ${tokenResponse.status}: ${await tokenResponse.text()}`);
  }
  const tokenJson = await tokenResponse.json();
  if (tokenJson.access_token !== token) {
    throw new Error(`unexpected token response: ${JSON.stringify(tokenJson)}`);
  }

  const grokTools = await listMcpTools(`${base}/mcp-grok`, tokenJson.access_token);
  const grokConfig = grokTools.find((tool) => tool.name === "server_config");
  const grokSchemes = grokConfig?._meta?.securitySchemes ?? grokConfig?.securitySchemes ?? [];
  if (!grokSchemes.some((scheme) => scheme.type === "oauth2")) {
    throw new Error(`Grok /mcp-grok missing oauth2 security scheme: ${JSON.stringify(grokConfig)}`);
  }
} finally {
  child.kill("SIGTERM");
}

console.log("✓ dual-client smoke test passed");