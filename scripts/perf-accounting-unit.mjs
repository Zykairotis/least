import assert from "node:assert/strict";
import { getLeastPerfSnapshot, resetLeastPerf, recordCompaction, measuredToolCall } from "../dist/perf.js";

resetLeastPerf("session");

await measuredToolCall("files", "ws-1", async () => ({
  content: [{ type: "text", text: "x".repeat(2000) }],
  structuredContent: {
    cacheHit: true,
    rawBytes: 50_000,
    visibleBytes: 2000,
    savedBytes: 48_000,
    compacted: true,
    output_meta: { retrievalKey: "sha256:abc" }
  }
}));

recordCompaction({
  toolName: "bash",
  kind: "test_log",
  rawBytes: 100_000,
  visibleBytes: 10_000,
  savedBytes: 90_000,
  compacted: true,
  fallback: false,
  retrievalKeyPresent: true
});

const snapshot = getLeastPerfSnapshot("session");
const files = snapshot.tools.find((tool) => tool.tool === "files");
assert.ok(files, "files tool aggregate should exist");
assert.equal(files.cache_hit_rate, 1, "cacheHit camelCase should count as cache hit");
assert.ok((snapshot.largest_visible_outputs ?? []).length >= 0);
assert.ok(Number(snapshot.gain?.saved_bytes ?? 0) > 0, "gain should track saved bytes");

console.log("perf-accounting-unit: ok");