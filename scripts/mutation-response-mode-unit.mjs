#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  mutationResponseModeFromArgs,
  diffComputeModeFromResponseMode
} from "../dist/mutationTypes.js";
import {
  computeMutationDiff,
  prepareTextContent,
  writeTextFile,
  makeUnifiedDiff
} from "../dist/fsOps.js";
import { shouldOffloadUnifiedDiff, getDiffOffloadThresholdBytes, resetWorkerSpawnCount, getWorkerSpawnCount } from "../dist/workerOps.js";
import { loadConfig } from "../dist/config.js";
import { PathGuard, WorkspaceManager } from "../dist/guard.js";

// --- mode parsing ---
assert.equal(mutationResponseModeFromArgs({}, "summary"), "summary");
assert.equal(mutationResponseModeFromArgs({ include_diff: false }, "compact_diff"), "summary");
assert.equal(mutationResponseModeFromArgs({ include_diff: true }, "summary"), "full_diff");
assert.equal(mutationResponseModeFromArgs({ response_mode: "compact_diff", include_diff: true }, "summary"), "compact_diff");
assert.equal(diffComputeModeFromResponseMode("summary"), "none");
assert.equal(diffComputeModeFromResponseMode("compact_diff"), "compact");
assert.equal(diffComputeModeFromResponseMode("full_diff"), "full");

// --- prepare once ---
const prepared = prepareTextContent("hello world\n");
assert.equal(prepared.bytes, Buffer.byteLength("hello world\n", "utf8"));
assert.equal(prepared.sha256.length, 64);
assert.ok(Buffer.isBuffer(prepared.buffer));

// --- summary skips unified diff body ---
const summaryDiff = await computeMutationDiff("old\n", "new\n", "x.ts", "none");
assert.equal(summaryDiff.diff, undefined);
assert.equal(summaryDiff.additions, null);
assert.equal(summaryDiff.statsComputed, false);

const fullDiff = await computeMutationDiff("old\n", "new\n", "x.ts", "full");
assert.ok((fullDiff.preview ?? fullDiff.diff).includes("x.ts"));
assert.ok(fullDiff.storageDiff && fullDiff.storageDiff.includes("x.ts"));
assert.ok((fullDiff.additions ?? 0) >= 1);
assert.equal(fullDiff.statsComputed, true);

// Storage holds complete content; preview is bounded separately.
const largeOld = "line\n".repeat(2_000);
const largeNew = "line2\n".repeat(2_000);
const fullStored = await computeMutationDiff(largeOld, largeNew, "big.ts", "full", 500, {
  storageMaxChars: 500_000
});
assert.ok(fullStored.storageDiff);
assert.ok(fullStored.preview);
assert.ok(fullStored.preview.length <= 600 || fullStored.truncated);
// Storage should be larger than the 500-char preview when the change is large.
assert.ok(fullStored.storageDiff.length >= fullStored.preview.length);

const compactDiff = await computeMutationDiff("a\n".repeat(5000), "b\n".repeat(5000), "big.ts", "compact", 500);
assert.ok(compactDiff.preview ?? compactDiff.diff);
assert.ok((compactDiff.preview ?? compactDiff.diff).length <= 600 || compactDiff.truncated);

// --- worker threshold: 510KB and 900KB stay local ---
const threshold = getDiffOffloadThresholdBytes();
assert.ok(threshold >= 4_000_000, `threshold should be >= 4MB, got ${threshold}`);
const mid = "x".repeat(510_000);
const big = "y".repeat(900_000);
assert.equal(shouldOffloadUnifiedDiff(mid, mid), false);
assert.equal(shouldOffloadUnifiedDiff(big, big), false);
assert.equal(shouldOffloadUnifiedDiff("z".repeat(2_100_000), "z".repeat(2_100_000)), true);

// --- writeTextFile summary mode does not produce meaningful unified body ---
const root = await fs.mkdtemp(path.join(os.tmpdir(), "least-mut-"));
try {
  const config = loadConfig(["--root", root, "--allow-root", root]);
  const guard = new PathGuard(config);
  const workspace = new WorkspaceManager(config).openWorkspace(root);

  resetWorkerSpawnCount();
  const content = "export const n = 1;\n" + "const x = 1;\n".repeat(1000);
  const result = await writeTextFile(config, guard, workspace, "src/game.ts", content, {
    createDirs: true,
    overwrite: true,
    diffMode: "none"
  });
  assert.equal(result.bytes, Buffer.byteLength(content, "utf8"));
  assert.equal(result.sha256.length, 64);
  assert.equal(result.diff.additions, 0);
  assert.equal(result.diff.deletions, 0);
  // summary path should not start workers
  assert.equal(getWorkerSpawnCount(), 0);

  const large = "L".repeat(510_000);
  const over = await writeTextFile(config, guard, workspace, "src/large.ts", large, {
    createDirs: true,
    overwrite: true,
    diffMode: "full"
  });
  assert.equal(over.bytes, 510_000);
  assert.equal(getWorkerSpawnCount(), 0, "510KB full diff must stay local");

  // overwrite with local diff still no worker
  const large2 = "M".repeat(510_000);
  await writeTextFile(config, guard, workspace, "src/large.ts", large2, {
    overwrite: true,
    diffMode: "full"
  });
  assert.equal(getWorkerSpawnCount(), 0);

  // local makeUnifiedDiff still works
  const d = makeUnifiedDiff("a\n", "b\n", "t.ts");
  assert.ok(d.changed);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

console.log("mutation-response-mode-unit: ok");
