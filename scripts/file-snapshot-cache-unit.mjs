import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  getFileSnapshotCacheStats,
  invalidateFileSnapshot,
  readTextWithSnapshot
} from "../dist/fileSnapshotCache.js";
import {
  getCachedFileList,
  getCachedGitValue,
  invalidateWorkspaceCaches,
  setCachedFileList,
  setCachedGitValue
} from "../dist/workspaceCache.js";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "least-snapshot-"));
const filePath = path.join(dir, "sample.txt");
await fs.writeFile(filePath, "hello snapshot\n", "utf8");

const first = await readTextWithSnapshot(filePath);
assert.equal(first.cacheHit, false);
assert.equal(first.text, "hello snapshot\n");
assert.ok(first.sha256);

const second = await readTextWithSnapshot(filePath);
assert.equal(second.cacheHit, true);
assert.equal(second.sha256, first.sha256);

const aliasPath = path.join(dir, "sample-link.txt");
await fs.symlink(filePath, aliasPath);
const alias = await readTextWithSnapshot(aliasPath);
assert.equal(alias.cacheHit, true, "symlink alias should share canonical snapshot");

await fs.writeFile(filePath, "changed\n", "utf8");
const third = await readTextWithSnapshot(filePath);
assert.equal(third.cacheHit, false);
assert.equal(third.text, "changed\n");

invalidateFileSnapshot(filePath);
const stats = getFileSnapshotCacheStats();
assert.ok(typeof stats.entries === "number");

// Granular workspace cache: content mutation keeps file list.
const ws = "ws-granular";
setCachedFileList(ws, "all", "fs", ["a.ts", "b.ts"], false, 60_000);
setCachedGitValue(ws, "status", "M a.ts", 60_000);
assert.ok(getCachedFileList(ws, "all"));
assert.ok(getCachedGitValue(ws, "status"));

invalidateWorkspaceCaches(ws, { fileList: false, git: true });
assert.ok(getCachedFileList(ws, "all"), "file list should survive content invalidation");
assert.equal(getCachedGitValue(ws, "status"), undefined, "git cache should clear");

invalidateWorkspaceCaches(ws, { fileList: true, git: false });
assert.equal(getCachedFileList(ws, "all"), undefined, "file list should clear on structure invalidation");

console.log("file-snapshot-cache-unit: ok");
