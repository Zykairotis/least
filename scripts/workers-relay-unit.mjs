import assert from "node:assert/strict";
import {
  pathAllowed,
  publicHostnameFromRelayUrl,
  filterOutboundHeaders,
  relayForwardHeaders,
  parseWranglerDeployHostname
} from "./workersRelay.mjs";

assert.equal(pathAllowed("/"), true);
assert.equal(pathAllowed("/healthz"), true);
assert.equal(pathAllowed("/mcp"), true);
assert.equal(pathAllowed("/mcp-grok"), true);
assert.equal(pathAllowed("/oauth/authorize"), true);
assert.equal(pathAllowed("/oauth/token"), true);
assert.equal(pathAllowed("/.well-known/oauth-authorization-server"), true);
assert.equal(pathAllowed("/.well-known/oauth-protected-resource"), true);
assert.equal(pathAllowed("/setup"), true);
assert.equal(pathAllowed("/etc/passwd"), false);
assert.equal(pathAllowed("/mcp/../secret"), false);

assert.equal(publicHostnameFromRelayUrl("least-relay.foo.workers.dev"), "least-relay.foo.workers.dev");
assert.equal(
  publicHostnameFromRelayUrl("https://least-relay.foo.workers.dev/mcp?least_token=x"),
  "least-relay.foo.workers.dev"
);

const filtered = filterOutboundHeaders({
  Authorization: "Bearer abc",
  Host: "evil.example",
  "Content-Type": "application/json",
  Connection: "keep-alive"
});
assert.equal(filtered.Authorization, "Bearer abc");
assert.equal(filtered["Content-Type"], "application/json");
assert.equal(filtered.Host, undefined);
assert.equal(filtered.Connection, undefined);

const forwarded = relayForwardHeaders(
  { Host: "least-relay.foo.workers.dev", Authorization: "Bearer abc", Connection: "keep-alive" },
  "least-relay.foo.workers.dev"
);
assert.equal(forwarded["x-forwarded-host"], "least-relay.foo.workers.dev");
assert.equal(forwarded["x-forwarded-proto"], "https");
assert.equal(forwarded.Host, undefined);
assert.equal(forwarded.Authorization, "Bearer abc");

assert.equal(
  parseWranglerDeployHostname("Deployed least-relay triggers\n  https://least-relay.abc123.workers.dev"),
  "least-relay.abc123.workers.dev"
);
assert.equal(parseWranglerDeployHostname("no url here"), "");

console.log("✓ workers-relay unit tests passed");
