#!/usr/bin/env node

// Dashboard agent persistence unit tests — schema + agent_* tool output parsing
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

async function run() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "least-dashboard-agent-"));
  const dbPath = path.join(tmpDir, "dashboard.db");

  try {
    const store = await import("../dist/dashboardStore.js");
    store.initDashboardStore(dbPath);

    const db = new DatabaseSync(dbPath);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
    assert.ok(tables.includes("agent_jobs"), "agent_jobs table should exist");
    assert.ok(tables.includes("agent_terminal_sessions"), "agent_terminal_sessions table should exist");
    console.log("✓ agent tables exist");

    const ts = new Date().toISOString();

    store.persistDashboardEvent({
      id: 1001,
      ts,
      kind: "tool:end",
      toolName: "agent_start",
      sessionId: "test-session",
      payload: {
        output: {
          job_id: "job-test-001",
          task_id: "task-test-001",
          agent: "codex-host",
          repository: "least",
          title: "Smoke test job",
          state: "running",
          idempotency_key: "job-test-key",
          launch_phase: "running",
          launch_error: null,
          worktree_dir: "/tmp/worktrees/job-test-001",
          branch_name: "agent/job-test-001",
          terminal: {
            backend: "zellij",
            sessionName: "agent-job-test-001",
            paneId: "0",
            attachCommand: "zellij attach agent-job-test-001",
            watchCommand: "zellij watch agent-job-test-001",
            tailCommand: "zellij --session agent-job-test-001 action dump-screen --pane-id 0 --full",
          },
        },
      },
    });

    const jobs = store.listStoredAgentJobs(10);
    assert.strictEqual(jobs.length, 1, "should persist one agent job");
    const job = jobs[0];
    assert.strictEqual(job.job_id, "job-test-001");
    assert.strictEqual(job.task_id, "task-test-001");
    assert.strictEqual(job.agent, "codex-host");
    assert.strictEqual(job.state, "running");
    assert.strictEqual(job.idempotency_key, "job-test-key");
    assert.strictEqual(job.launch_phase, "running");
    assert.strictEqual(job.terminal_backend, "zellij");
    assert.strictEqual(job.terminal_session, "agent-job-test-001");
    assert.strictEqual(job.terminal_pane_id, "0");
    assert.strictEqual(job.worktree_dir, "/tmp/worktrees/job-test-001");
    console.log("✓ agent_start output persisted to agent_jobs");

    store.persistDashboardEvent({
      id: 1002,
      ts: new Date().toISOString(),
      kind: "tool:end",
      toolName: "agent_tail",
      sessionId: "test-session",
      payload: {
        output: {
          job_id: "job-test-001",
          source: "logs",
          backend: "logs",
          tail_hint: "Get-Content -Tail 50 .ai-bridge/agent-runs/job-test-001/stdout.log",
        },
      },
    });

    const sessions = store.listStoredAgentTerminalSessions(20);
    assert.ok(sessions.length >= 2, "should have zellij + logs terminal sessions");
    const backends = new Set(sessions.map((s) => s.backend));
    assert.ok(backends.has("zellij"), "zellij session should exist");
    assert.ok(backends.has("logs"), "logs session should exist");

    const logsSession = sessions.find((s) => s.backend === "logs");
    assert.ok(logsSession?.tail_command?.includes("stdout.log"), "logs tail command should be compact");
    assert.ok(!logsSession?.metadata_json?.includes("Lorem ipsum"), "should not store raw terminal text");
    console.log("✓ agent_tail output persisted to agent_terminal_sessions");

    store.persistDashboardEvent({
      id: 1003,
      ts: new Date().toISOString(),
      kind: "tool:end",
      toolName: "agent_sessions",
      sessionId: "test-session",
      payload: {
        output: {
          sessions: [
            {
              backend: "tmux",
              session_name: "least-agent",
              pane_id: "1",
              attach_command: "tmux attach -t least-agent",
              tail_command: "tmux capture-pane -p -t least-agent:1",
            },
          ],
        },
      },
    });

    const allSessions = store.listStoredAgentTerminalSessions(50);
    assert.ok(allSessions.some((s) => s.backend === "tmux"), "agent_sessions should upsert tmux session");
    console.log("✓ agent_sessions output persisted");

    // Verify metadata_json stays compact (no huge blobs)
    for (const row of jobs) {
      if (row.metadata_json) {
        assert.ok(row.metadata_json.length < 10_000, "job metadata should stay compact");
      }
    }
    console.log("✓ agent metadata stays compact");

    console.log("\n✓ All dashboard agent unit tests passed");
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      // Windows may keep the SQLite WAL handle briefly open; tests already passed.
    }
  }
}

run().catch((err) => {
  console.error("Dashboard agent unit tests failed:", err);
  process.exit(1);
});
