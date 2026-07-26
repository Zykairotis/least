#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const { agentCleanup, agentResume, isActiveAgentJobState, parseOlderThanMs } = await import("../dist/agentLifecycle.js");
const { agentJobDir, agentJobPath, writeAgentJob } = await import("../dist/agentJobStore.js");
const { LeastError } = await import("../dist/guard.js");

function workspace(root) {
  return { id: "smoke", root, name: "smoke", createdAt: new Date().toISOString() };
}

function baseJob(ws, overrides = {}) {
  const timestamp = new Date().toISOString();
  return {
    jobId: "agent_lifecycle_stale_001",
    taskId: "least-agent-lifecycle-stale",
    createdAt: timestamp,
    updatedAt: timestamp,
    workspaceId: ws.id,
    workspaceRoot: ws.root,
    agent: "codex-host",
    repository: "least",
    title: "Agent lifecycle smoke stale job",
    promptFile: path.join(ws.root, ".ai-bridge", "agent-runs", "agent_lifecycle_stale_001", "prompt.md"),
    state: "cancelled",
    timeoutMs: 3_600_000,
    idleTimeoutMs: 900_000,
    ...overrides
  };
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "least-agent-lifecycle-smoke-"));
const ws = workspace(tmpRoot);

try {
  assert.equal(isActiveAgentJobState("running"), true);
  assert.equal(isActiveAgentJobState("cancelled"), false);
  const olderThanMs = parseOlderThanMs("7d");
  assert.ok(olderThanMs < Date.now());
  console.log("agent-lifecycle-smoke: helpers ok");

  const staleJob = baseJob(ws);
  await writeAgentJob(ws, staleJob);
  const staleUpdatedAt = new Date(Date.now() - 8 * 86_400_000).toISOString();
  const staleStatusPath = agentJobPath(ws, staleJob.jobId);
  const staleStatus = JSON.parse(await fs.readFile(staleStatusPath, "utf8"));
  staleStatus.updatedAt = staleUpdatedAt;
  await fs.writeFile(staleStatusPath, `${JSON.stringify(staleStatus, null, 2)}\n`, "utf8");
  await fs.writeFile(staleJob.promptFile, "stale prompt\n", "utf8");

  const runningJob = baseJob(ws, {
    jobId: "agent_lifecycle_running_001",
    taskId: "least-agent-lifecycle-running",
    title: "Agent lifecycle smoke running job",
    state: "running",
    promptFile: path.join(ws.root, ".ai-bridge", "agent-runs", "agent_lifecycle_running_001", "prompt.md")
  });
  await writeAgentJob(ws, runningJob);

  const orphanDir = path.join(ws.root, ".ai-bridge", "agent-runs", "orphan-no-status");
  await fs.mkdir(orphanDir, { recursive: true });
  await fs.writeFile(path.join(orphanDir, "stdout.log"), "orphan\n", "utf8");

  const preview = await agentCleanup(ws, {
    workspaceId: ws.id,
    workspaceRoot: ws.root,
    olderThan: "7d",
    dryRun: true
  });
  assert.equal(preview.structured.dry_run, true);
  assert.ok(preview.structured.candidate_count >= 1);
  assert.ok(preview.structured.removed_job_dirs.includes(staleJob.jobId));
  assert.ok(!preview.structured.removed_job_dirs.includes(runningJob.jobId));
  assert.equal(preview.structured.worktrees_preserved_by_default, true);
  assert.ok(await pathExists(agentJobPath(ws, staleJob.jobId)));
  console.log("agent-lifecycle-smoke: agent_cleanup dry_run ok");

  await assert.rejects(
    () => agentCleanup(ws, {
      workspaceId: ws.id,
      workspaceRoot: ws.root,
      jobId: runningJob.jobId,
      dryRun: false
    }),
    (error) => error instanceof LeastError && /Refusing cleanup for active job/.test(error.message)
  );
  console.log("agent-lifecycle-smoke: active job guard ok");

  const removed = await agentCleanup(ws, {
    workspaceId: ws.id,
    workspaceRoot: ws.root,
    jobId: staleJob.jobId,
    dryRun: false
  });
  assert.equal(removed.structured.dry_run, false);
  assert.deepEqual(removed.structured.removed_job_dirs, [staleJob.jobId]);
  assert.ok(!(await pathExists(agentJobPath(ws, staleJob.jobId))));
  console.log("agent-lifecycle-smoke: agent_cleanup delete ok");

  const interruptedJob = baseJob(ws, {
    jobId: "agent_lifecycle_resume_001",
    taskId: "least-agent-lifecycle-resume",
    title: "Agent lifecycle smoke resume job",
    state: "interrupted",
    promptFile: path.join(ws.root, ".ai-bridge", "agent-runs", "agent_lifecycle_resume_001", "prompt.md"),
    groundcrew: {
      worktreeDir: "/tmp/fake-worktree",
      branchName: "agent/lifecycle-resume"
    }
  });
  await writeAgentJob(ws, interruptedJob);

  try {
    await agentResume(ws, {
      workspaceId: ws.id,
      workspaceRoot: ws.root,
      jobId: interruptedJob.jobId
    });
    console.log("agent-lifecycle-smoke: agent_resume ok (Groundcrew available)");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.match(message, /Groundcrew|resumeWorkspace|worktree|Repository|zellij|PATH/i);
    console.log("agent-lifecycle-smoke: agent_resume expected failure path ok");
  }

  await assert.rejects(
    () => agentResume(ws, {
      workspaceId: ws.id,
      workspaceRoot: ws.root,
      jobId: runningJob.jobId
    }),
    (error) => error instanceof LeastError && /Refusing resume for active job/.test(error.message)
  );
  console.log("agent-lifecycle-smoke: resume active job guard ok");

  console.log("agent-lifecycle-smoke: ok");
} finally {
  await fs.rm(tmpRoot, { recursive: true, force: true });
}