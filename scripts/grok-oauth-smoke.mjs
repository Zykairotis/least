import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
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
      if (stderr.includes("HTTP protocols")) {
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
  const client = new Client({ name: "least-grok-oauth-smoke", version: "0.0.0" });
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

const root = await fs.mkdtemp(path.join(os.tmpdir(), "least-grok-oauth-smoke-"));
const port = await getFreePort();
const token = "least-grok-oauth-smoke-token";
const base = `http://127.0.0.1:${port}`;
const redirectUri = "https://example.com/callback";
const verifier = "least-grok-oauth-verifier";
const challenge = pkceChallenge(verifier);

const child = spawn("node", ["dist/http.js"], {
  cwd: path.resolve("."),
  env: {
    ...process.env,
    LEAST_ROOT: root,
    LEAST_ALLOWED_ROOTS: root,
    LEAST_PORT: String(port),
    LEAST_HTTP_TOKEN: token,
    LEAST_GROK_OAUTH: "1",
    LEAST_GROK_OAUTH_CLIENT_ID: "least-grok",
    LEAST_HTTP_PROTOCOLS: "mcp",
    LEAST_BASH_MODE: "safe",
    LEAST_WRITE_MODE: "handoff"
  },
  stdio: ["ignore", "pipe", "pipe"]
});

let childStderr = "";
child.stderr.on("data", (chunk) => {
  childStderr += String(chunk);
});
if (process.env.LEAST_DEBUG_OAUTH === "1") {
  child.stderr.pipe(process.stderr);
}

try {
  await waitForListening(child);

  const metadata = await fetch(`${base}/.well-known/oauth-protected-resource`, {
    headers: { "X-Forwarded-Proto": "https", "X-Forwarded-Host": "least.example.test" }
  });
  if (metadata.status !== 200) {
    throw new Error(`protected-resource metadata expected 200, got ${metadata.status}`);
  }
  const metadataJson = await metadata.json();
  if (metadataJson.resource !== "https://least.example.test" || !metadataJson.authorization_servers?.includes?.("https://least.example.test")) {
    throw new Error(`unexpected protected-resource metadata: ${JSON.stringify(metadataJson)}`);
  }

  const authServerMetadata = await fetch(`${base}/.well-known/oauth-authorization-server`, {
    headers: { "X-Forwarded-Proto": "https", "X-Forwarded-Host": "least.example.test" }
  });
  if (authServerMetadata.status !== 200) {
    throw new Error(`authorization-server metadata expected 200, got ${authServerMetadata.status}`);
  }
  const authServerJson = await authServerMetadata.json();
  if (authServerJson.authorization_endpoint !== "https://least.example.test/oauth/authorize" || authServerJson.token_endpoint_auth_methods_supported?.[0] !== "none") {
    throw new Error(`unexpected authorization-server metadata: ${JSON.stringify(authServerJson)}`);
  }

  const unauthorizedMcp = await fetch(`${base}/mcp`, { method: "POST" });
  const oauthChallengeHeader = unauthorizedMcp.headers.get("www-authenticate") ?? "";
  if (unauthorizedMcp.status !== 401 || !oauthChallengeHeader.includes("/.well-known/oauth-protected-resource")) {
    throw new Error(`unauthorized MCP expected OAuth challenge, got ${unauthorizedMcp.status} ${oauthChallengeHeader}`);
  }

  const authorizeUrl = new URL(`${base}/oauth/authorize`);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", "least-grok");
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("scope", "mcp");
  authorizeUrl.searchParams.set("state", "abc123");
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  const authorize = await fetch(authorizeUrl);
  if (authorize.status !== 200) {
    throw new Error(`GET /oauth/authorize expected 200, got ${authorize.status}`);
  }
  const authorizeText = await authorize.text();
  if (!authorizeText.includes("least-grok") || !authorizeText.includes("/oauth/approve")) {
    throw new Error("authorization page missing expected Grok OAuth fields");
  }

  const approveBody = new URLSearchParams({
    response_type: "code",
    client_id: "least-grok",
    redirect_uri: redirectUri,
    scope: "mcp",
    state: "abc123",
    code_challenge: challenge,
    code_challenge_method: "S256",
    approve: "1"
  });
  const approve = await fetch(`${base}/oauth/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: approveBody,
    redirect: "manual"
  });
  if (approve.status !== 302) {
    throw new Error(`POST /oauth/approve expected 302, got ${approve.status}`);
  }
  const approvedLocation = approve.headers.get("location") ?? "";
  const code = locationParam(approvedLocation, "code");
  const state = locationParam(approvedLocation, "state");
  if (!code || state !== "abc123") {
    throw new Error(`approve redirect missing code/state: ${approvedLocation}`);
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
    throw new Error(`POST /oauth/token expected 200, got ${tokenResponse.status}: ${await tokenResponse.text()}\n${childStderr}`);
  }
  const tokenJson = await tokenResponse.json();
  if (tokenJson.access_token !== token || tokenJson.token_type !== "Bearer" || tokenJson.scope !== "mcp") {
    throw new Error(`unexpected token response: ${JSON.stringify(tokenJson)}`);
  }

  const healthz = await fetch(`${base}/healthz`, {
    headers: { Authorization: `Bearer ${tokenJson.access_token}` }
  });
  if (healthz.status !== 200) {
    throw new Error(`GET /healthz with OAuth token expected 200, got ${healthz.status}`);
  }

  const tools = await listMcpTools(`${base}/mcp`, tokenJson.access_token);
  const toolNames = tools.map((tool) => tool.name);
  for (const expected of ["server_config", "open_current_workspace", "show_changes"]) {
    if (!toolNames.includes(expected)) {
      throw new Error(`OAuth MCP tools/list missing ${expected}; got ${toolNames.join(", ")}`);
    }
  }
  const serverConfig = tools.find((tool) => tool.name === "server_config");
  const securitySchemes = serverConfig?._meta?.securitySchemes ?? serverConfig?.securitySchemes ?? [];
  if (!securitySchemes.some((scheme) => scheme.type === "oauth2")) {
    throw new Error(`OAuth MCP tool metadata missing oauth2 security scheme: ${JSON.stringify(serverConfig)}`);
  }

  const reused = await fetch(`${base}/oauth/token`, {
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
  if (reused.status !== 400) {
    throw new Error(`reused code expected 400, got ${reused.status}`);
  }
  const reusedJson = await reused.json();
  if (reusedJson.error !== "invalid_grant") {
    throw new Error(`reused code expected invalid_grant, got ${JSON.stringify(reusedJson)}`);
  }

  const wrongVerifierApprove = await fetch(`${base}/oauth/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      response_type: "code",
      client_id: "least-grok",
      redirect_uri: redirectUri,
      scope: "mcp",
      state: "wrong",
      code_challenge: challenge,
      code_challenge_method: "S256",
      approve: "1"
    }),
    redirect: "manual"
  });
  const wrongVerifierCode = locationParam(wrongVerifierApprove.headers.get("location") ?? "", "code");
  if (wrongVerifierApprove.status !== 302 || !wrongVerifierCode) {
    throw new Error(`wrong-verifier approval expected code redirect, got ${wrongVerifierApprove.status}`);
  }

  const wrongVerifier = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code: wrongVerifierCode,
      client_id: "least-grok",
      redirect_uri: redirectUri,
      code_verifier: "wrong-verifier"
    })
  });
  if (wrongVerifier.status !== 400) {
    throw new Error(`wrong verifier expected 400, got ${wrongVerifier.status}`);
  }
  const wrongVerifierJson = await wrongVerifier.json();
  if (wrongVerifierJson.error !== "invalid_grant") {
    throw new Error(`wrong verifier expected invalid_grant, got ${JSON.stringify(wrongVerifierJson)}`);
  }

  const deny = await fetch(`${base}/oauth/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      response_type: "code",
      client_id: "least-grok",
      redirect_uri: redirectUri,
      scope: "mcp",
      state: "deny-state",
      code_challenge: challenge,
      code_challenge_method: "S256",
      deny: "1"
    }),
    redirect: "manual"
  });
  if (deny.status !== 302) {
    throw new Error(`deny expected 302, got ${deny.status}`);
  }
  const denyLocation = deny.headers.get("location") ?? "";
  if (locationParam(denyLocation, "error") !== "access_denied") {
    throw new Error(`deny redirect expected access_denied, got ${denyLocation}`);
  }
} finally {
  child.kill("SIGTERM");
}

console.log("✓ grok oauth smoke test passed");
