#!/usr/bin/env node

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { refreshGroundcrewWindowsPath } from "./ensure-windows-agent-path.mjs";

refreshGroundcrewWindowsPath();

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ws = { id: "least", root: repoRoot, name: "least", createdAt: new Date().toISOString() };

const { agentStart, agentStatus } = await import("../dist/agentOps.js");
const { createAgentJob, writeAgentJob } = await import("../dist/agentJobStore.js");

const prompt = "Inspect the repository and produce a short summary only. Do not modify source files.";
const agent = "oh-my-pi";

function buildInput(suffix, overrides = {}) {
  return {
    workspaceId: ws.id,
    workspaceRoot: ws.root,
    agent,
    repository: "least",
    title: `Agent start contract smoke ${suffix}`,
    prompt,
    timeoutMs: 3_600_000,
    idleTimeoutMs: 900_000,
    ...overrides
  };
}

console.log("agent-start-contract-smoke: async accepted response");
const taskId = `least-agent-contract-task-${Date.now()}`;
const startedAt = Date.now();
const started = await agentStart(ws, buildInput("task-id", { taskId }));
const elapsedMs = Date.now() - startedAt;
assert.ok(started.structured.job_id, "agent_start should return job_id");
assert.equal(started.structured.task_id, taskId);
assert.equal(started.structured.accepted, true);
assert.ok(["accepted", "provisioning", "running", "completed", "failed-to-launch"].includes(String(started.structured.state)));
assert.ok(elapsedMs < 30_000, `agent_start should return quickly; took ${elapsedMs}ms`);
console.log("  job:", started.structured.job_id, "state:", started.structured.state, "elapsedMs:", elapsedMs);

console.log("agent-start-contract-smoke: task_id idempotency");
const reusedByTask = await agentStart(ws, buildInput("task-id-retry", { taskId }));
assert.equal(reusedByTask.structured.job_id, started.structured.job_id);
assert.equal(reusedByTask.structured.reused, true);
console.log("  reused job:", reusedByTask.structured.job_id);

console.log("agent-start-contract-smoke: idempotency_key reuse");
const idempotencyKey = `agent-start-contract-key-${Date.now()}`;
const startedByKey = await agentStart(ws, buildInput("idempotency-key", { idempotencyKey }));
const reusedByKey = await agentStart(ws, buildInput("idempotency-key-retry", { idempotencyKey }));
assert.equal(reusedByKey.structured.job_id, startedByKey.structured.job_id);
assert.equal(reusedByKey.structured.reused, true);
console.log("  reused by key:", reusedByKey.structured.job_id);

console.log("agent-start-contract-smoke: wait_for_launch timeout returns handle");
const waited = await agentStart(ws, buildInput("wait-timeout", {
  idempotencyKey: `agent-start-contract-wait-${Date.now()}`,
  waitForLaunch: true,
  startupWaitMs: 1
}));
assert.ok(waited.structured.job_id, "wait_for_launch response should still include job_id");
assert.equal(waited.structured.accepted, true);
assert.ok(
  waited.structured.startup_wait_elapsed === true ||
    ["running", "completed", "failed-to-launch"].includes(String(waited.structured.state)),
  "wait_for_launch should return a durable handle instead of timing out"
);
console.log("  wait result state:", waited.structured.state, "startup_wait_elapsed:", waited.structured.startup_wait_elapsed);

console.log("agent-start-contract-smoke: agent_status on accepted handle");
const status = await agentStatus(ws, { workspaceId: ws.id, workspaceRoot: ws.root, jobId: started.structured.job_id });
assert.equal(status.structured.job_id, started.structured.job_id);
assert.ok(status.structured.launch, "agent_status should expose launch metadata");
console.log("  status state:", status.structured.state, "launch:", status.structured.launch.phase);

console.log("agent-start-contract-smoke: stale provisioning becomes recovery-required");
const staleIdempotencyKey = `agent-start-contract-stale-${Date.now()}`;
let staleJob = await createAgentJob({
  workspace: ws,
  taskId: `least-agent-contract-stale-${Date.now()}`,
  agent,
  repository: "least",
  title: "Agent start stale recovery smoke",
  prompt,
  timeoutMs: 3_600_000,
  idleTimeoutMs: 900_000,
  idempotencyKey: staleIdempotencyKey
});
staleJob = await writeAgentJob(ws, {
  ...staleJob,
  state: "accepted",
  launch: {
    phase: "accepted",
    acceptedAt: staleJob.createdAt
  }
});
const staleStatus = await agentStatus(ws, { workspaceId: ws.id, workspaceRoot: ws.root, jobId: staleJob.jobId });
assert.equal(staleStatus.structured.state, "recovery-required");
assert.equal(staleStatus.structured.launch_phase, "recovery-required");
console.log("  stale status:", staleStatus.structured.state, "launch:", staleStatus.structured.launch_phase);

console.log("agent-start-contract-smoke: idempotent restart of recovery-required job");
const recovered = await agentStart(ws, buildInput("stale-restart", { idempotencyKey: staleIdempotencyKey }));
assert.equal(recovered.structured.job_id, staleJob.jobId);
assert.equal(recovered.structured.reused, true);
assert.equal(recovered.structured.recovery_restarted, true);
console.log("  recovered job:", recovered.structured.job_id, "recovery_restarted:", recovered.structured.recovery_restarted);

console.log("agent-start-contract-smoke: ok");
