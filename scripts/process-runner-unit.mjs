import assert from "node:assert/strict";
import { runCappedProcess, streamProcessLines } from "../dist/processRunner.js";

async function expectSingleRejection(run) {
  let rejections = 0;
  try {
    await run();
  } catch {
    rejections += 1;
  }
  assert.equal(rejections, 1, "process runner should reject exactly once");
}

await expectSingleRejection(() =>
  runCappedProcess({
    command: "least-missing-executable-xyz",
    args: [],
    cwd: process.cwd(),
    maxOutputBytes: 1024
  })
);

await expectSingleRejection(() =>
  streamProcessLines({
    command: "least-missing-executable-xyz",
    args: [],
    cwd: process.cwd(),
    maxLines: 5
  })
);

console.log("process-runner-unit: ok");