import assert from "node:assert/strict";
import { WorkspaceLockManager } from "../dist/workspaceLocks.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const leaseMs = 80;
const manager = new WorkspaceLockManager(leaseMs);
const workspaceId = "ws_test";

let result = manager.acquire(workspaceId, "session-a", "chatgpt");
assert.equal(result.ok, true);
if (!result.ok) throw new Error("expected acquire to succeed");
assert.equal(result.alreadyOwned, false);

result = manager.acquire(workspaceId, "session-a");
assert.equal(result.ok, true);
if (!result.ok) throw new Error("expected idempotent acquire");
assert.equal(result.alreadyOwned, true);

result = manager.acquire(workspaceId, "session-b", "grok");
assert.equal(result.ok, false);
if (result.ok) throw new Error("expected acquire denial");
assert.equal(result.reason, "owned_by_other");

const renewed = manager.renew(workspaceId, "session-a");
assert.ok(renewed);

const deniedRenew = manager.renew(workspaceId, "session-b");
assert.equal(deniedRenew, undefined);

const released = manager.release(workspaceId, "session-a");
assert.equal(released.released, true);

result = manager.acquire(workspaceId, "session-b");
assert.equal(result.ok, true);
if (!result.ok) throw new Error("expected session-b acquire before not_owner release test");

const deniedRelease = manager.release(workspaceId, "session-a");
assert.equal(deniedRelease.released, false);
assert.equal(deniedRelease.reason, "not_owner");

manager.release(workspaceId, "session-b");

const emptyRelease = manager.release(workspaceId, "session-b");
assert.equal(emptyRelease.released, false);
assert.equal(emptyRelease.reason, "no_lock");

const shortManager = new WorkspaceLockManager(30);
const shortWs = "ws_expire";
let shortResult = shortManager.acquire(shortWs, "session-expire");
assert.equal(shortResult.ok, true);
await sleep(45);
shortManager.prune();
assert.equal(shortManager.get(shortWs), undefined);
shortResult = shortManager.acquire(shortWs, "session-next");
assert.equal(shortResult.ok, true);

console.log("workspace-locks-unit: ok");