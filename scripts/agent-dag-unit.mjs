import assert from "node:assert/strict";
import { planDag } from "../dist/agentDag.js";

function job(taskId, state, dependsOn = []) {
  return {
    jobId: `job_${taskId}`,
    taskId,
    state,
    dependsOn,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    workspaceId: "ws",
    workspaceRoot: "/tmp/ws",
    agent: "test",
    repository: "repo",
    title: taskId,
    promptFile: "/tmp/ws/prompt.txt",
    timeoutMs: 60000,
    idleTimeoutMs: 60000
  };
}

const cycle = planDag([job("a", "planned", ["b"]), job("b", "planned", ["c"]), job("c", "planned", ["a"])]);
assert.equal(cycle.cycles.length, 1);

const clean = planDag([job("base", "completed"), job("next", "planned", ["base"]), job("later", "planned", ["next"])]);
assert.deepEqual(clean.ready, ["next"]);
assert.deepEqual(clean.waiting, ["later"]);

console.log("agent-dag-unit: ok");
