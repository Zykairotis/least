#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { refreshGroundcrewWindowsPath } from "./ensure-windows-agent-path.mjs";

refreshGroundcrewWindowsPath();

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ws = { id: "least", root: repoRoot, name: "least", createdAt: new Date().toISOString() };

const {
  agentStart,
  agentStatus,
  agentTail,
  agentAttachHint,
  agentResult,
  agentPlan
} = await import("../dist/agentOps.js");
const { agentCleanup } = await import("../dist/agentLifecycle.js");
const {
  initDashboardStore,
  persistDashboardEvent,
  listStoredAgentJobs,
  listStoredAgentTerminalSessions
} = await import("../dist/dashboardStore.js");
const { buildDashboardSnapshot } = await import("../dist/dashboardSnapshot.js");

const prompt = "Inspect the repository and produce a short summary only. Do not modify source files.";
const input = {
  workspaceId: ws.id,
  workspaceRoot: ws.root,
  agent: "grok-build",
  repository: "least",
  title: `E2E smoke summary ${Date.now()}`,
  prompt,
  timeoutMs: 3_600_000,
  idleTimeoutMs: 900_000
};

console.log("agent-e2e-smoke: agent_plan");
const plan = agentPlan(input);
assert.ok(plan.structured.task_id, "plan should return task_id");
console.log("  task_id:", plan.structured.task_id);

console.log("agent-e2e-smoke: agent_start (grok-build)");
const started = await agentStart(ws, input);
console.log(started.text.split("\n").slice(0, 8).join("\n"));
const jobId = started.structured.job_id;
const taskId = started.structured.task_id;
assert.ok(jobId, "agent_start should return job_id");
assert.ok(taskId, "agent_start should return task_id");
console.log("  job_id:", jobId, "state:", started.structured.state);

console.log("agent-e2e-smoke: agent_status");
const status = await agentStatus(ws, { workspaceId: ws.id, workspaceRoot: ws.root, jobId });
console.log("  state:", status.structured.state);

console.log("agent-e2e-smoke: agent_tail");
const tail = await agentTail(ws, { workspaceId: ws.id, workspaceRoot: ws.root, jobId, lines: 30 });
console.log("  source:", tail.structured.source, "bytes:", tail.structured.bytes ?? "(n/a)");

console.log("agent-e2e-smoke: agent_attach_hint");
const attach = await agentAttachHint(ws, { workspaceId: ws.id, workspaceRoot: ws.root, jobId });
console.log("  attach:", attach.structured.attach_hint ?? attach.structured.attach_commands?.[0] ?? "(none)");

console.log("agent-e2e-smoke: agent_result");
const result = await agentResult(ws, {
  workspaceId: ws.id,
  workspaceRoot: ws.root,
  jobId,
  includeDiff: false,
  includeTail: true,
  tailLines: 20
});
console.log("  state:", result.structured.state);

console.log("agent-e2e-smoke: agent_cleanup dry_run");
const cleanup = await agentCleanup(ws, {
  workspaceId: ws.id,
  workspaceRoot: ws.root,
  dryRun: true,
  olderThan: "365d"
});
console.log("  stale candidates:", cleanup.structured.candidate_count);

const dbPath = path.join(repoRoot, ".least", "dashboard-e2e-smoke.db");
if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
initDashboardStore(dbPath);
persistDashboardEvent({
  id: 42_001,
  ts: new Date().toISOString(),
  kind: "tool:end",
  toolName: "agent_start",
  sessionId: "e2e-smoke",
  payload: { output: started.structured }
});
const jobs = listStoredAgentJobs(10);
const sessions = listStoredAgentTerminalSessions(10);
assert.ok(jobs.some((row) => row.job_id === jobId), "dashboard should persist job");
const snap = buildDashboardSnapshot();
assert.ok(snap.agents.jobCount >= 1, "snapshot should include agents");
console.log("agent-e2e-smoke: dashboard agents jobCount=", snap.agents.jobCount, "sessions=", snap.agents.terminalSessionCount);
console.log("agent-e2e-smoke: ok");