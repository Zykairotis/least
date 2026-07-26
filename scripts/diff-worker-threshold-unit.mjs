#!/usr/bin/env node
/**
 * Regression: normal write sizes must not offload to a fresh worker.
 */
import assert from "node:assert/strict";
import {
  shouldOffloadUnifiedDiff,
  getDiffOffloadThresholdBytes,
  resetWorkerSpawnCount,
  getWorkerSpawnCount,
  offloadedUnifiedDiff
} from "../dist/workerOps.js";
import { makeUnifiedDiffMaybeOffloaded } from "../dist/fsOps.js";

const threshold = getDiffOffloadThresholdBytes();
assert.ok(threshold >= 4_000_000);

for (const size of [490_000, 510_000, 900_000, 1_000_000]) {
  const a = "a".repeat(size);
  const b = "b".repeat(size);
  assert.equal(
    shouldOffloadUnifiedDiff(a, b),
    false,
    `${size}B pair should not offload (threshold ${threshold})`
  );
}

// makeUnifiedDiffMaybeOffloaded for medium files should not spawn workers
resetWorkerSpawnCount();
const oldT = "line\n".repeat(20_000);
const newT = "line2\n".repeat(20_000);
await makeUnifiedDiffMaybeOffloaded(oldT, newT, "med.ts", 10_000);
assert.equal(getWorkerSpawnCount(), 0, "medium diff must stay on main thread");

// Explicit offload still works for huge payloads when forced via API
// (shouldOffload is true only above threshold — skip actual worker if too heavy for CI)
if (process.env.LEAST_TEST_WORKER === "1") {
  resetWorkerSpawnCount();
  const hugeOld = "x".repeat(2_100_000);
  const hugeNew = "y".repeat(2_100_000);
  assert.equal(shouldOffloadUnifiedDiff(hugeOld, hugeNew), true);
  await offloadedUnifiedDiff(hugeOld, hugeNew, "huge.ts", 1000);
  assert.ok(getWorkerSpawnCount() >= 1);
}

console.log("diff-worker-threshold-unit: ok");
