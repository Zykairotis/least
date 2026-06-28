import assert from "node:assert/strict";
import { measuredToolCall, getLeastPerfSnapshot, resetLeastPerf } from "../dist/perf.js";
import { withTimeout, ToolTimeoutError } from "../dist/timeout.js";

resetLeastPerf("session");

try {
  await measuredToolCall("timeout-unit", "ws-timeout", async () =>
    withTimeout("timeout-unit", 40, async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    })
  );
  throw new Error("expected timeout");
} catch (error) {
  assert.ok(error instanceof ToolTimeoutError, "withTimeout should reject with ToolTimeoutError");
}

const snapshot = getLeastPerfSnapshot("session");
const tool = snapshot.tools.find((item) => item.tool === "timeout-unit");
assert.equal(tool?.timeouts, 1, "one logical timeout should increment timeout metrics once");

console.log("timeout-unit: ok");