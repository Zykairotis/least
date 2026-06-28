#!/usr/bin/env node

// Dashboard unit tests — event bus, snapshot, redaction
import assert from "node:assert";

async function run() {
  const mod = await import("../dist/dashboardEvents.js");

  // 0. Reset
  mod.clearDashboardEvents();

  // 1. Event ids increment
  const e1 = mod.emitDashboardEvent({ kind: "tool:start", toolName: "read" });
  const e2 = mod.emitDashboardEvent({ kind: "tool:end", toolName: "read" });
  assert.ok(e2.id > e1.id, "event ids should increment");
  console.log("✓ event ids increment");

  // 2. Clear
  mod.clearDashboardEvents();
  assert.strictEqual(mod.getRecentDashboardEvents(500).length, 0, "clear should remove all events");
  console.log("✓ clearDashboardEvents works");

  // 3. Ring buffer cap
  mod.setDashboardMaxEvents(100);
  for (let i = 0; i < 200; i++) {
    mod.emitDashboardEvent({ kind: "log", payload: { n: i } });
  }
  const capped = mod.getRecentDashboardEvents(200);
  assert.ok(capped.length === 100, "ring buffer should cap at maxEvents: got " + capped.length);
  console.log("✓ ring buffer caps at maxEvents");

  // 4. Subscribers receive events
  mod.clearDashboardEvents();
  const received = [];
  const unsub = mod.subscribeDashboardEvents((e) => received.push(e.kind));
  mod.emitDashboardEvent({ kind: "tool:start", toolName: "write" });
  assert.ok(received.includes("tool:start"), "subscriber should receive events");
  console.log("✓ subscribers receive events");

  // 5. Unsubscribe
  unsub();
  const before = received.length;
  mod.emitDashboardEvent({ kind: "tool:end", toolName: "write" });
  assert.strictEqual(received.length, before, "unsubscribed should not receive events");
  console.log("✓ unsubscribe stops delivery");

  // 6. getDashboardEventsSince
  mod.clearDashboardEvents();
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const e = mod.emitDashboardEvent({ kind: "log", payload: { i } });
    ids.push(e.id);
  }
  const tail = mod.getDashboardEventsSince(ids[2]);
  assert.strictEqual(tail.length, 2, "should return events after given id");
  console.log("✓ getDashboardEventsSince works");

  // 7. Snapshot sections
  const snap = await import("../dist/dashboardSnapshot.js");
  snap.setDashboardConfig({ defaultRoot: "/tmp", dashboardPort: 8922, yoloMode: false });
  snap.setDashboardStarted();
  const state = snap.buildDashboardSnapshot();
  assert.ok(state.server, "snapshot should have server section");
  assert.ok(state.runtime, "snapshot should have runtime section");
  assert.ok(state.tools, "snapshot should have tools section");
  assert.ok(state.perf, "snapshot should have perf section");
  assert.ok(state.agents, "snapshot should have agents section");
  assert.ok(Array.isArray(state.agents.jobs), "agents.jobs should be an array");
  assert.ok(Array.isArray(state.agents.terminalSessions), "agents.terminalSessions should be an array");
  console.log("✓ snapshot returns expected sections");

  console.log("\n✓ All dashboard unit tests passed");
}

run().catch((err) => {
  console.error("Dashboard unit tests failed:", err);
  process.exit(1);
});
