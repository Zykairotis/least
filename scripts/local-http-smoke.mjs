import assert from "node:assert/strict";
import http from "node:http";
import { loadConfig } from "../dist/config.js";
import { apiSmokeSuite, localHttpJson } from "../dist/httpOps.js";

const config = loadConfig(["--root", process.cwd()]);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/ok") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ success: true }));
    return;
  }
  if (req.method === "POST" && url.pathname === "/echo") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ success: true, echo: JSON.parse(body || "{}"), origin: req.headers.origin || null }));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ success: false }));
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
const baseUrl = `http://127.0.0.1:${port}`;

try {
  const getResult = await localHttpJson({ method: "GET", baseUrl, path: "/ok" }, config);
  assert.equal(getResult.ok, true);
  assert.equal(getResult.json.success, true);

  const postResult = await localHttpJson(
    {
      method: "POST",
      baseUrl,
      path: "/echo",
      origin: "http://localhost:6791",
      json: { instrumentRegex: "NIFTY 50", limit: 2 }
    },
    config
  );
  assert.equal(postResult.ok, true);
  assert.equal(postResult.json.echo.instrumentRegex, "NIFTY 50");
  assert.equal(postResult.json.origin, "http://localhost:6791");

  const suite = await apiSmokeSuite(
    {
      baseUrl,
      origin: "http://localhost:6791",
      checks: [
        {
          name: "ok",
          method: "GET",
          path: "/ok",
          expectedStatus: 200,
          expectJsonPath: [{ path: "/success", equals: true }]
        },
        {
          name: "echo",
          method: "POST",
          path: "/echo",
          json: { a: 1 },
          expectedStatus: 200,
          expectJsonPath: [
            { path: "/success", equals: true },
            { path: "/echo", type: "object" }
          ]
        }
      ]
    },
    config
  );
  assert.equal(suite.ok, true);
  assert.equal(suite.passed, 2);
  assert.equal(suite.failed, 0);
} finally {
  await new Promise((resolve) => server.close(resolve));
}

console.log("local-http-smoke: ok");
