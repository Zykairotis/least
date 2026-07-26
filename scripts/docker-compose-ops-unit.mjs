import assert from "node:assert/strict";
import {
  clampLogTail,
  parseJsonPsLines,
  parseTablePs,
  summarizeComposeServices,
  validateServiceName
} from "../dist/dockerComposeOps.js";

// 1. Validates service names
assert.equal(validateServiceName("trading-backend"), "trading-backend");
assert.equal(validateServiceName("web_1"), "web_1");

// 2. Rejects invalid service name with shell metacharacters
assert.throws(() => validateServiceName("web; rm -rf /"), /Invalid/);
assert.throws(() => validateServiceName("web$(id)"), /Invalid/);
assert.throws(() => validateServiceName("web && reboot"), /Invalid/);

// 3. Bounds tail
{
  const settings = { maxLogTail: 5000 };
  assert.equal(clampLogTail(120, settings), 120);
  assert.equal(clampLogTail(0, settings), 1);
  assert.equal(clampLogTail(99999, settings), 5000);
  assert.equal(clampLogTail(undefined, settings), 200);
}

// 4. Parses JSON compose ps output
{
  const stdout = [
    JSON.stringify({ Name: "proj-backend-1", Service: "trading-backend", State: "running", Health: "healthy" }),
    JSON.stringify({ Name: "proj-df-1", Service: "dragonfly", State: "running", Health: "unhealthy" }),
    JSON.stringify({ Name: "proj-old-1", Service: "worker", State: "exited" })
  ].join("\n");
  const services = parseJsonPsLines(stdout);
  assert.equal(services.length, 3);
  const summary = summarizeComposeServices(services);
  assert.equal(summary.healthy, false);
  assert.deepEqual(summary.unhealthy, ["dragonfly"]);
  assert.deepEqual(summary.exited, ["worker"]);
}

// 5. Handles table fallback
{
  const table = [
    "NAME                SERVICE           STATUS",
    "proj-backend-1      trading-backend   Up 2 hours (healthy)",
    "proj-front-1        frontend          Up 2 hours"
  ].join("\n");
  const services = parseTablePs(table);
  assert.equal(services.length, 2);
  assert.equal(services[0].service, "trading-backend");
  assert.equal(services[0].state, "running");
}

console.log("docker-compose-ops-unit: ok");
