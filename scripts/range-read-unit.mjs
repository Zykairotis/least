import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../dist/config.js";
import { PathGuard, WorkspaceManager } from "../dist/guard.js";
import { readTextFile } from "../dist/fsOps.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "least-range-read-"));
const bigPath = path.join(root, "big.txt");
const lines = Array.from({ length: 4000 }, (_, i) => `line ${i + 1}`).join("\n");
await fs.writeFile(bigPath, lines, "utf8");

const envBackup = process.env.LEAST_MAX_READ_BYTES;
process.env.LEAST_MAX_READ_BYTES = "2000";
try {
  const config = loadConfig(["--root", root, "--allow-root", root]);
  const guard = new PathGuard(config);
  const workspaces = new WorkspaceManager(config);
  const workspace = workspaces.openWorkspace(root);

  let wholeFailed = false;
  try {
    await readTextFile(config, guard, workspace, "big.txt");
  } catch (error) {
    wholeFailed = /too large/i.test(error instanceof Error ? error.message : String(error));
  }
  assert.equal(wholeFailed, true, "whole-file read should reject large files");

  const range = await readTextFile(config, guard, workspace, "big.txt", { startLine: 10, endLine: 20 });
  assert.match(range.text, /line 10/);
  assert.ok((range.returnedBytes ?? range.bytes) <= config.maxReadBytes);
  assert.ok((range.fileBytes ?? 0) > config.maxReadBytes);

  const hugeRange = await readTextFile(config, guard, workspace, "big.txt", { startLine: 1, endLine: 4000 });
  assert.ok((hugeRange.returnedBytes ?? hugeRange.bytes) <= config.maxReadBytes, "huge requested range should stay within maxReadBytes");
  assert.equal(hugeRange.truncated, true, "huge requested range should mark truncated when byte budget stops early");

  const binaryPath = path.join(root, "binary.dat");
  const binaryBody = Buffer.alloc(5000, 0);
  binaryBody.write("text prefix\n", 0, "utf8");
  await fs.writeFile(binaryPath, binaryBody);
  let binaryRejected = false;
  try {
    await readTextFile(config, guard, workspace, "binary.dat", { startLine: 1, endLine: 5 });
  } catch (error) {
    binaryRejected = /binary file/i.test(error instanceof Error ? error.message : String(error));
  }
  assert.equal(binaryRejected, true, "binary large file should be rejected for range reads");
} finally {
  if (envBackup === undefined) delete process.env.LEAST_MAX_READ_BYTES;
  else process.env.LEAST_MAX_READ_BYTES = envBackup;
}

console.log("range-read-unit: ok");