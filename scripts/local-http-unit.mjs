import assert from "node:assert/strict";
import { loadConfig } from "../dist/config.js";
import {
  buildUrl,
  isAllowedHost,
  localHttpJson,
  localHttpRequest,
  validateLocalHttpUrl
} from "../dist/httpOps.js";
import { redactStructured } from "../dist/redact.js";
import { structuredToolSuggestion } from "../dist/bashOps.js";

const config = loadConfig(["--root", process.cwd()]);

function assertThrows(fn, re) {
  let threw = false;
  try {
    fn();
  } catch (error) {
    threw = true;
    if (re) assert.match(String(error.message || error), re);
  }
  assert.equal(threw, true, "expected throw");
}

// 1. Allows localhost host check
assert.equal(isAllowedHost("localhost", config.httpTools), true);
assert.equal(isAllowedHost("127.0.0.1", config.httpTools), true);
assert.equal(isAllowedHost("::1", config.httpTools), true);
assert.equal(isAllowedHost("host.docker.internal", config.httpTools), true);

// 2. Blocks external host by default
assert.equal(isAllowedHost("example.com", config.httpTools), false);

// 3. Blocks file:// URL
assertThrows(
  () => validateLocalHttpUrl({ method: "GET", url: "file:///etc/passwd" }, config.httpTools),
  /protocol|file/i
);

// 4. Blocks URL credentials
assertThrows(
  () => validateLocalHttpUrl({ method: "GET", url: "http://user:pass@localhost:9/x" }, config.httpTools),
  /credential/i
);

// 5. buildUrl query + base/path
{
  const url = buildUrl("http://localhost:6795", "/api/tools", { limit: 10 }, undefined);
  assert.equal(url.origin, "http://localhost:6795");
  assert.equal(url.pathname, "/api/tools");
  assert.equal(url.searchParams.get("limit"), "10");
}

// 6. Mock fetch: Origin header + JSON parse
{
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify({ success: true, data: [1] }), {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json", authorization: "Bearer secret-token-value" }
    });
  };
  const result = await localHttpJson(
    {
      method: "POST",
      baseUrl: "http://localhost:6795",
      path: "/api/echo",
      origin: "http://localhost:6791",
      json: { hello: "world" }
    },
    config,
    fetchImpl
  );
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.json.success, true);
  assert.equal(seen.init.headers.get("Origin"), "http://localhost:6791");
  assert.equal(seen.init.headers.get("Content-Type"), "application/json");
  assert.equal(result.headers.authorization, "[REDACTED_SECRET]");
}

// 7. Blocks external host at request time
{
  await assert.rejects(
    () =>
      localHttpRequest(
        { method: "GET", url: "https://example.com/api" },
        config,
        async () => new Response("nope")
      ),
    /not allowed|Host/i
  );
}

// 8. Timeout
{
  const slowFetch = () =>
    new Promise((resolve) => {
      setTimeout(() => resolve(new Response("late")), 500);
    });
  const result = await localHttpRequest(
    { method: "GET", url: "http://localhost:9/slow", timeoutMs: 50 },
    config,
    slowFetch
  );
  assert.equal(result.timedOut, true);
  assert.equal(result.ok, false);
}

// 9. maxBodyBytes truncation
{
  const fetchImpl = async () =>
    new Response("x".repeat(10_000), {
      status: 200,
      headers: { "content-type": "text/plain" }
    });
  const result = await localHttpRequest(
    { method: "GET", url: "http://127.0.0.1:9/big", maxBodyBytes: 256 },
    config,
    fetchImpl
  );
  assert.equal(result.truncated, true);
  assert.ok(result.bodyText.length <= 256);
}

// 10. Redacts Authorization in structured objects
{
  const redacted = redactStructured({
    headers: { authorization: "Bearer abc", "content-type": "application/json" },
    token: "super-secret",
    nested: { password: "p@ss" }
  });
  assert.equal(redacted.headers.authorization, "[REDACTED_SECRET]");
  assert.equal(redacted.token, "[REDACTED_SECRET]");
  assert.equal(redacted.nested.password, "[REDACTED_SECRET]");
  assert.equal(redacted.headers["content-type"], "application/json");
}

// 11. Keeps Least internal lease tokens usable while redacting real tokens
{
  const redacted = redactStructured({
    lease_token: "least-local-lease-token",
    workspace_lease_token: "least-workspace-lease-token",
    access_token: "external-access-token",
    dashboardToken: "dashboard-token"
  });
  assert.equal(redacted.lease_token, "least-local-lease-token");
  assert.equal(redacted.workspace_lease_token, "least-workspace-lease-token");
  assert.equal(redacted.access_token, "[REDACTED_SECRET]");
  assert.equal(redacted.dashboardToken, "[REDACTED_SECRET]");
}

// 12. Follows allowed redirects manually and reports the final local URL
{
  const seenUrls = [];
  const fetchImpl = async (url) => {
    seenUrls.push(url);
    if (url.endsWith("/redirect")) {
      return new Response("", { status: 302, headers: { location: "/ok" } });
    }
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  const result = await localHttpRequest(
    { method: "GET", url: "http://localhost:7777/redirect", followRedirects: true },
    config,
    fetchImpl
  );
  assert.equal(result.ok, true);
  assert.equal(result.json.success, true);
  assert.equal(result.url, "http://localhost:7777/ok");
  assert.deepEqual(seenUrls, ["http://localhost:7777/redirect", "http://localhost:7777/ok"]);
}

// 13. Blocks redirects to disallowed hosts even when followRedirects is enabled
{
  await assert.rejects(
    () =>
      localHttpRequest(
        { method: "GET", url: "http://localhost:7777/redirect-external", followRedirects: true },
        config,
        async () => new Response("", { status: 302, headers: { location: "https://example.com/nope" } })
      ),
    /not allowed|Host/i
  );
}

// 14. Soft bash suggestions
assert.match(structuredToolSuggestion("curl -s http://localhost:1"), /local_http_json/);
assert.match(structuredToolSuggestion("docker compose ps"), /docker_compose/);
assert.match(structuredToolSuggestion("pnpm --filter app exec vitest run a.test.ts"), /run_vitest/);

console.log("local-http-unit: ok");
