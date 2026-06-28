import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

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
    const timeout = setTimeout(() => reject(new Error("server did not start")), 20_000);
    const onData = (chunk) => {
      if (String(chunk).includes("HTTP protocols")) {
        clearTimeout(timeout);
        child.stderr.off("data", onData);
        resolve();
      }
    };
    child.stderr.on("data", onData);
    child.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`server exited early with code ${code}`));
    });
  });
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "least-openai-smoke-"));
const port = await getFreePort();
const token = "least-openai-smoke-token";
const base = `http://127.0.0.1:${port}`;

const child = spawn("node", ["dist/http.js"], {
  cwd: path.resolve("."),
  env: {
    ...process.env,
    LEAST_ROOT: root,
    LEAST_ALLOWED_ROOTS: root,
    LEAST_PORT: String(port),
    LEAST_HTTP_TOKEN: token,
    LEAST_HTTP_PROTOCOLS: "openai",
    LEAST_BASH_MODE: "safe",
    LEAST_WRITE_MODE: "handoff",
    LEAST_TOOL_MODE: "minimal"
  },
  stdio: ["ignore", "pipe", "pipe"]
});

try {
  await waitForListening(child);

  const models = await fetch(`${base}/v1/models`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (models.status !== 200) {
    throw new Error(`GET /v1/models expected 200, got ${models.status}`);
  }
  const modelsBody = await models.json();
  if (!JSON.stringify(modelsBody).includes("least-tools")) {
    throw new Error("GET /v1/models missing least-tools");
  }

  const noTools = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "least-tools", messages: [{ role: "user", content: "hi" }] })
  });
  if (noTools.status !== 400) {
    throw new Error(`POST without tool_calls expected 400, got ${noTools.status}`);
  }
  const noToolsBody = await noTools.json();
  if (noToolsBody?.error?.code !== "least_no_tool_calls") {
    throw new Error(`expected least_no_tool_calls, got ${noToolsBody?.error?.code}`);
  }

  const toolBody = {
    model: "least-tools",
    messages: [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "server_config", arguments: "{}" }
          }
        ]
      }
    ]
  };

  const completion = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(toolBody)
  });
  if (completion.status !== 200) {
    throw new Error(`POST tool_calls expected 200, got ${completion.status}: ${await completion.text()}`);
  }
  const completionJson = await completion.json();
  const content = completionJson?.choices?.[0]?.message?.content ?? "";
  if (!/toolMode|writeMode|bashMode/i.test(content)) {
    throw new Error(`completion content missing config fields: ${content.slice(0, 200)}`);
  }

  const stream = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ...toolBody, stream: true })
  });
  if (!String(stream.headers.get("content-type") ?? "").includes("text/event-stream")) {
    throw new Error(`stream expected text/event-stream, got ${stream.headers.get("content-type")}`);
  }
  const streamText = await stream.text();
  if (!streamText.includes("data:") || !streamText.includes("[DONE]")) {
    throw new Error("SSE missing data lines or [DONE]");
  }

  const badAuth = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: "Bearer wrong", "Content-Type": "application/json" },
    body: JSON.stringify(toolBody)
  });
  if (badAuth.status !== 401) {
    throw new Error(`wrong bearer expected 401, got ${badAuth.status}`);
  }

  const mcpOnly = spawn("node", ["dist/http.js"], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      LEAST_ROOT: root,
      LEAST_ALLOWED_ROOTS: root,
      LEAST_PORT: String(port + 1),
      LEAST_HTTP_TOKEN: token,
      LEAST_HTTP_PROTOCOLS: "mcp"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  try {
    await waitForListening(mcpOnly);
    const missing = await fetch(`http://127.0.0.1:${port + 1}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(toolBody)
    });
    if (missing.status !== 404) {
      throw new Error(`mcp-only expected 404 on /v1, got ${missing.status}`);
    }
  } finally {
    mcpOnly.kill("SIGTERM");
  }
} finally {
  child.kill("SIGTERM");
}

console.log("✓ openai smoke test passed");