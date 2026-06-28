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
      if (stderr.includes("HTTP MCP listening")) {
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

async function connectClient(name, url, token) {
  const client = new Client({ name, version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  });
  await client.connect(transport);
  return { client, transport };
}

async function callTool(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const textBlock = Array.isArray(result.content)
    ? result.content.find((block) => block && typeof block.text === "string")
    : undefined;
  return {
    isError: Boolean(result.isError),
    text: textBlock?.text ?? "",
    structured: result.structuredContent ?? {}
  };
}

async function expectSchemaProperty(client, toolName, propertyName) {
  const result = await client.listTools();
  const tool = result.tools.find((entry) => entry.name === toolName);
  const properties = tool?.inputSchema?.properties ?? {};
  if (!Object.prototype.hasOwnProperty.call(properties, propertyName)) {
    throw new Error(`${toolName} schema missing ${propertyName}: ${JSON.stringify(tool?.inputSchema)}`);
  }
}

function runSync(args, env) {
  return spawnSync(process.execPath, ["scripts/least.mjs", ...args], {
    cwd: path.resolve("."),
    env,
    encoding: "utf8"
  });
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "least-concurrency-smoke-"));
const home = await fs.mkdtemp(path.join(os.tmpdir(), "least-concurrency-home-"));
const port = await getFreePort();
const token = "least-concurrency-smoke-token";
const mcpUrl = `http://127.0.0.1:${port}/mcp`;
const testFile = "concurrency-smoke.txt";

await fs.writeFile(path.join(root, testFile), "version-1\n", "utf8");

const settingsResult = runSync(
  ["settings", "set", "--root", root, "--tunnel", "none", "--concurrency", "lease", "--lock-lease-ms", "120000", "--token", token],
  { ...process.env, LEAST_HOME: home }
);
if (settingsResult.status !== 0) {
  throw new Error(`failed to save concurrency settings\n${settingsResult.stdout}\n${settingsResult.stderr}`);
}

const settingsShow = runSync(["settings", "show", "--root", root], { ...process.env, LEAST_HOME: home });
if (!settingsShow.stdout.includes("Concurrency") || !settingsShow.stdout.includes("lease")) {
  throw new Error(`settings show missing concurrency\n${settingsShow.stdout}`);
}

const doctorResult = runSync(["doctor", "--root", root, "--tunnel", "none", "--port", String(port)], {
  ...process.env,
  LEAST_HOME: home
});
const doctorOutput = `${doctorResult.stdout}\n${doctorResult.stderr}`;
if (!doctorOutput.includes("Concurrency") || !doctorOutput.includes("lease mode")) {
  throw new Error(`doctor missing concurrency readiness\n${doctorOutput}`);
}

const child = spawn("node", ["dist/http.js"], {
  cwd: path.resolve("."),
  env: {
    ...process.env,
    LEAST_ROOT: root,
    LEAST_ALLOWED_ROOTS: root,
    LEAST_PORT: String(port),
    LEAST_HTTP_TOKEN: token,
    LEAST_HTTP_PROTOCOLS: "mcp",
    LEAST_BASH_MODE: "full",
    LEAST_WRITE_MODE: "workspace",
    LEAST_CONCURRENCY_MODE: "lease",
    LEAST_LOCK_LEASE_MS: "120000"
  },
  stdio: ["ignore", "pipe", "pipe"]
});

try {
  await waitForListening(child);

  const clientA = await connectClient("least-concurrency-a", mcpUrl, token);
  const clientB = await connectClient("least-concurrency-b", mcpUrl, token);

  try {
    await callTool(clientA.client, "open_current_workspace");
    await callTool(clientB.client, "open_current_workspace");

    for (const toolName of ["write", "edit", "bash", "shell", "renew_workspace_lock", "release_workspace_lock"]) {
      await expectSchemaProperty(clientA.client, toolName, "lease_token");
    }

    const readA = await callTool(clientA.client, "read", { path: testFile, include_sha256: true });
    const sha = readA.structured.sha256;
    if (!sha) throw new Error("read did not return sha256");

    const deniedWrite = await callTool(clientB.client, "write", {
      path: testFile,
      content: "blocked\n"
    });
    if (!deniedWrite.isError || deniedWrite.structured.error !== "workspace_locked") {
      throw new Error(`expected workspace_locked on write without lock, got ${JSON.stringify(deniedWrite.structured)}`);
    }

    const readAllowed = await callTool(clientB.client, "read", { path: testFile });
    if (!readAllowed.text.includes("version-1")) {
      throw new Error("session B read should succeed while locked");
    }

    const acquireA = await callTool(clientA.client, "acquire_workspace_lock", { client_label: "chatgpt" });
    if (acquireA.isError || !acquireA.structured.acquired) {
      throw new Error(`session A failed to acquire lock: ${JSON.stringify(acquireA.structured)}`);
    }
    const leaseToken = acquireA.structured.lease_token;
    if (typeof leaseToken !== "string" || !leaseToken) {
      throw new Error(`acquire_workspace_lock did not return lease_token: ${JSON.stringify(acquireA.structured)}`);
    }

    const deniedB = await callTool(clientB.client, "acquire_workspace_lock", { client_label: "grok" });
    if (!deniedB.isError || !deniedB.structured.locked_by_other) {
      throw new Error(`session B should be denied lock acquisition: ${JSON.stringify(deniedB.structured)}`);
    }

    const writeA = await callTool(clientA.client, "write", {
      path: testFile,
      content: "version-2\n",
      expected_sha256: sha
    });
    if (writeA.isError) {
      throw new Error(`session A write failed: ${writeA.text}`);
    }

    const staleWrite = await callTool(clientA.client, "write", {
      path: testFile,
      content: "version-stale\n",
      expected_sha256: sha
    });
    if (!staleWrite.isError || staleWrite.structured.error !== "stale_file_state") {
      throw new Error(`expected stale_file_state, got ${JSON.stringify(staleWrite.structured)}`);
    }

    const readonlyBash = await callTool(clientB.client, "bash", { command: "node -v" });
    if (readonlyBash.isError || !readonlyBash.text.includes("Exit: 0")) {
      throw new Error(`session B readonly bash should not require lease token: ${readonlyBash.text}`);
    }

    const readonlyShell = await callTool(clientB.client, "shell", { command: "node -v" });
    if (readonlyShell.isError || !readonlyShell.text.includes("Exit: 0")) {
      throw new Error(`session B readonly shell should not require lease token: ${readonlyShell.text}`);
    }

    const deniedBash = await callTool(clientB.client, "bash", { command: "npm test" });
    if (!deniedBash.isError || deniedBash.structured.error !== "workspace_locked") {
      throw new Error(`expected workspace_locked on bash, got ${JSON.stringify(deniedBash.structured)}`);
    }

    const tokenBash = await callTool(clientB.client, "bash", { command: "node -v", lease_token: leaseToken });
    if (tokenBash.isError || !tokenBash.text.includes("Exit: 0")) {
      throw new Error(`session B bash with lease token failed: ${tokenBash.text}`);
    }

    const tokenShell = await callTool(clientB.client, "shell", { command: "node -v", lease_token: leaseToken });
    if (tokenShell.isError || !tokenShell.text.includes("Exit: 0")) {
      throw new Error(`session B shell with lease token failed: ${tokenShell.text}`);
    }

    const tokenRenew = await callTool(clientB.client, "renew_workspace_lock", { lease_token: leaseToken });
    if (tokenRenew.isError || !tokenRenew.structured.renewed) {
      throw new Error(`session B failed to renew with lease token: ${JSON.stringify(tokenRenew.structured)}`);
    }

    const tokenRelease = await callTool(clientB.client, "release_workspace_lock", { lease_token: leaseToken });
    if (tokenRelease.isError || !tokenRelease.structured.released) {
      throw new Error(`session B failed to release with lease token: ${JSON.stringify(tokenRelease.structured)}`);
    }

    const acquireB = await callTool(clientB.client, "acquire_workspace_lock", { client_label: "grok" });
    if (acquireB.isError || !acquireB.structured.acquired) {
      throw new Error(`session B failed to acquire after release: ${JSON.stringify(acquireB.structured)}`);
    }

    const status = await callTool(clientB.client, "workspace_lock_status");
    if (!status.structured.locked) {
      throw new Error(`expected locked status, got ${JSON.stringify(status.structured)}`);
    }

    const releaseB = await callTool(clientB.client, "release_workspace_lock");
    if (releaseB.isError || !releaseB.structured.released) {
      throw new Error(`session B failed to release own lock: ${JSON.stringify(releaseB.structured)}`);
    }

    const acquireReconnectA = await callTool(clientA.client, "acquire_workspace_lock", { client_label: "chatgpt-reconnect" });
    if (acquireReconnectA.isError || !acquireReconnectA.structured.acquired) {
      throw new Error(`session A failed to acquire reconnect lock: ${JSON.stringify(acquireReconnectA.structured)}`);
    }

    const clientAReconnected = await connectClient("least-concurrency-a", mcpUrl, token);
    try {
      await callTool(clientAReconnected.client, "open_current_workspace");

      const reconnectBash1 = await callTool(clientAReconnected.client, "bash", {
        command: "node -e \"console.log('reconnect-one')\""
      });
      if (reconnectBash1.isError || !reconnectBash1.text.includes("reconnect-one")) {
        throw new Error(`reconnected session first bash failed: ${reconnectBash1.text}`);
      }

      const reconnectBash2 = await callTool(clientAReconnected.client, "bash", {
        command: "node -e \"console.log('reconnect-two')\""
      });
      if (reconnectBash2.isError || !reconnectBash2.text.includes("reconnect-two")) {
        throw new Error(`reconnected session second bash failed: ${reconnectBash2.text}`);
      }

      const reconnectRelease = await callTool(clientAReconnected.client, "release_workspace_lock");
      if (reconnectRelease.isError || !reconnectRelease.structured.released) {
        throw new Error(`reconnected session failed to release lock: ${JSON.stringify(reconnectRelease.structured)}`);
      }
    } finally {
      await clientAReconnected.client.close();
    }
  } finally {
    await clientA.client.close();
    await clientB.client.close();
  }

  console.log("concurrency-lock-smoke: ok");
} finally {
  child.kill("SIGTERM");
}
