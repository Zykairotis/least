import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../dist/config.js";
import { storeToolOutput, retrieveStoredOutput, isValidRetrievalKey } from "../dist/toolOutputStore.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "least-output-store-"));
const config = loadConfig(["--root", root, "--allow-root", root]);
const workspaceId = "test-ws";
const payload = Array.from({ length: 120 }, (_, i) => `line ${i + 1}: alpha`).join("\n");

const key = await storeToolOutput(config, root, workspaceId, "bash", "test_log", payload);
assert.ok(key && isValidRetrievalKey(key), "store should return valid key");

const full = await retrieveStoredOutput(config, root, workspaceId, key, { maxBytes: 50_000 });
assert.match(full.content, /alpha/);
assert.equal(full.totalLines, 120);

const slice = await retrieveStoredOutput(config, root, workspaceId, key, { startLine: 5, endLine: 8 });
assert.match(slice.content, /5 \|/);
assert.ok(slice.returnedBytes < full.returnedBytes);

let rejected = false;
try {
  await retrieveStoredOutput(config, root, workspaceId, "../escape", {});
} catch {
  rejected = true;
}
assert.equal(rejected, true, "invalid key should be rejected");

let crossWorkspaceRejected = false;
try {
  await retrieveStoredOutput(config, root, "other-workspace", key, { maxBytes: 50_000 });
} catch (error) {
  crossWorkspaceRejected = /not found|expired/i.test(error instanceof Error ? error.message : String(error));
}
assert.equal(crossWorkspaceRejected, true, "retrieval from another workspace id should fail");

function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
const storeRoot = path.join(root, ".least", "cache", "tool-output", workspaceId);
const siblingStoreFile = path.join(`${root}sibling`, ".least", "cache", "tool-output", workspaceId, "abc.txt");
assert.equal(isInside(storeRoot, siblingStoreFile), false, "sibling-prefix store paths must not satisfy containment");

console.log("output-store-unit: ok");