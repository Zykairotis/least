import assert from "node:assert/strict";
import { resetLeastPerf, recordCompaction } from "../dist/perf.js";
import { leastGain, leastDiscover } from "../dist/gainOps.js";

resetLeastPerf("session");
recordCompaction({
  toolName: "bash",
  kind: "test_log",
  rawBytes: 2_000_000,
  visibleBytes: 44_000,
  savedBytes: 1_956_000,
  compacted: true,
  fallback: false
});

const gainText = leastGain("session", "text");
assert.match(gainText, /Raw bytes processed/i);
assert.match(gainText, /Top savers/i);

const discover = leastDiscover("session");
assert.ok(Array.isArray(discover.recommendations));

console.log("gain-unit: ok");