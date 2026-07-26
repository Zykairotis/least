import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

function encode(message) {
  return `${JSON.stringify(message)}\n`;
}

class McpStdioClient {
  constructor(command, args, options) {
    this.child = spawn(command, args, options);
    this.buffer = "";
    this.nextId = 1;
    this.pending = new Map();
    this.child.stdout.on("data", (chunk) => this.onData(String(chunk)));
    this.child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    this.child.on("exit", (code) => {
      for (const { reject } of this.pending.values()) reject(new Error(`server exited ${code}`));
    });
  }

  onData(chunk) {
    this.buffer += chunk;
    while (true) {
      const index = this.buffer.indexOf("\n");
      if (index < 0) return;
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        clearTimeout(timer);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    }
  }

  request(method, params) {
    const id = this.nextId++;
    this.child.stdin.write(encode({ jsonrpc: "2.0", id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 15_000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(encode({ jsonrpc: "2.0", method, params }));
  }

  close() {
    this.child.kill("SIGTERM");
  }
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
    server.on("error", reject);
  });
}

function waitForHttpListening(child) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`timeout waiting for HTTP server\n${stderr}`)), 15_000);
    timer.unref();
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.includes("HTTP MCP listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`HTTP server exited before listening: ${code}\n${stderr}`));
    });
  });
}

function stopChild(child, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("timeout waiting for child exit"));
    }, timeoutMs);
    timer.unref();
    child.on("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

function decodeJsonOrSse(text) {
  const trimmed = text.trim();
  if (!trimmed) return {};
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return JSON.parse(trimmed);
  const dataLine = trimmed.split(/\r?\n/).find((line) => line.startsWith("data: "));
  if (dataLine) return JSON.parse(dataLine.slice("data: ".length));
  throw new Error(`unexpected MCP HTTP response: ${trimmed.slice(0, 200)}`);
}

async function postMcpJson(url, payload, sessionId) {
  const headers = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json"
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP MCP ${response.status} ${response.statusText}\n${text}`);
  }
  const json = decodeJsonOrSse(text);
  if (json?.error) {
    throw new Error(`HTTP MCP error: ${JSON.stringify(json.error)}`);
  }
  return { json, sessionId: response.headers.get("mcp-session-id") ?? sessionId };
}

const expectedTools = [
  "local_http_request",
  "local_http_json",
  "api_smoke_suite",
  "docker_compose_services",
  "docker_compose_ps",
  "docker_compose_logs",
  "docker_compose_health",
  "run_package_script",
  "run_vitest"
];

const packageToolSchemaProperties = {
  run_package_script: ["workspace_id", "packageManager", "script", "timeoutMs", "lease_token"],
  run_vitest: ["workspace_id", "packageFilter", "files", "timeoutMs", "lease_token"]
};

function assertStructuredToolsManifest(tools, label) {
  const toolsByName = new Map(tools.tools.map((tool) => [tool.name, tool]));
  for (const name of expectedTools) {
    assert.ok(toolsByName.has(name), `${label} tools/list should expose direct callable ${name}`);
    assert.ok(toolsByName.get(name).inputSchema?.type === "object", `${label} ${name} should expose an object input schema`);
  }

  for (const name of expectedTools.filter((tool) => tool !== "run_package_script" && tool !== "run_vitest")) {
    const annotations = toolsByName.get(name).annotations ?? {};
    assert.equal(annotations.readOnlyHint, true, `${label} ${name} should be read-only`);
    assert.notEqual(annotations.destructiveHint, true, `${label} ${name} should not be destructive`);
  }

  for (const name of ["run_package_script", "run_vitest"]) {
    const annotations = toolsByName.get(name).annotations ?? {};
    assert.equal(annotations.readOnlyHint, false, `${label} ${name} should not be read-only`);
    assert.equal(annotations.destructiveHint, true, `${label} ${name} should be command/mutation annotated`);
    assert.ok(toolsByName.get(name).inputSchema?.properties?.lease_token, `${label} ${name} should expose lease_token`);
  }

  for (const [toolName, propertyNames] of Object.entries(packageToolSchemaProperties)) {
    const properties = toolsByName.get(toolName).inputSchema?.properties ?? {};
    for (const propertyName of propertyNames) {
      assert.ok(properties[propertyName], `${label} ${toolName} should expose schema property ${propertyName}`);
    }
  }
}

function assertServerConfigIncludes(serverConfig, label) {
  for (const name of expectedTools) {
    assert.ok(serverConfig.structuredContent.registeredTools?.includes?.(name), `${label} server_config should include ${name}`);
  }
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "least-structured-tools-manifest-"));
await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "least-manifest-fixture" }, null, 2), "utf8");

const client = new McpStdioClient(process.execPath, ["dist/stdio.js", "--root", root, "--allow-root", root, "--tool-mode", "full", "--toolset", "full", "--bash", "safe"], {
  cwd: path.resolve("."),
  env: { ...process.env, LEAST_ROOT: root, LEAST_ALLOWED_ROOTS: root, LEAST_WIDGET_DOMAIN: "https://widgets.least.test" }
});

try {
  await client.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "least-structured-tools-manifest", version: "0.1.0" }
  });
  client.notify("notifications/initialized");

  const tools = await client.request("tools/list", {});
  assertStructuredToolsManifest(tools, "stdio");

  const serverConfig = await client.request("tools/call", { name: "server_config", arguments: {} });
  assertServerConfigIncludes(serverConfig, "stdio");

  const httpPort = await getFreePort();
  const httpEnv = {
    ...process.env,
    LEAST_ROOT: root,
    LEAST_ALLOWED_ROOTS: root,
    LEAST_HOST: "127.0.0.1",
    LEAST_PORT: String(httpPort),
    LEAST_BASH_MODE: "safe",
    LEAST_TOOL_MODE: "full",
    LEAST_TOOLSET: "full",
    LEAST_WIDGET_DOMAIN: "https://widgets.least.test"
  };
  httpEnv["LEAST_ALLOW_NO_HTTP_" + "TOKEN"] = "1";
  const httpServer = spawn(process.execPath, ["dist/http.js"], {
    cwd: path.resolve("."),
    env: httpEnv,
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    await waitForHttpListening(httpServer);
    const mcpUrl = `http://127.0.0.1:${httpPort}/mcp`;
    const initialized = await postMcpJson(mcpUrl, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "least-structured-tools-manifest-http", version: "0.1.0" }
      }
    });
    assert.ok(initialized.sessionId, "HTTP MCP initialize should return mcp-session-id");
    await postMcpJson(mcpUrl, { jsonrpc: "2.0", method: "notifications/initialized", params: {} }, initialized.sessionId);

    const httpTools = await postMcpJson(mcpUrl, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, initialized.sessionId);
    assertStructuredToolsManifest(httpTools.json.result, "http");

    const httpServerConfig = await postMcpJson(
      mcpUrl,
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "server_config", arguments: {} } },
      initialized.sessionId
    );
    assertServerConfigIncludes(httpServerConfig.json.result, "http");
  } finally {
    await stopChild(httpServer);
  }

  console.log("structured-tools-manifest-unit: ok");
} finally {
  client.close();
}
