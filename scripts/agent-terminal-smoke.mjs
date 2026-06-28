#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const {
  agentAttachHint,
  agentSessions,
  agentTail,
  agentTerminalDoctor
} = await import("../dist/agentOps.js");
const { detectTerminalBackends } = await import("../dist/agentTerminalBackend.js");
const { agentJobDir, writeAgentJob } = await import("../dist/agentJobStore.js");
const { resetTerminalExecCache } = await import("../dist/agentTerminalExec.js");

function workspace(root) {
  return { id: "smoke", root, name: "smoke", createdAt: new Date().toISOString() };
}

function baseJob(ws, overrides = {}) {
  const timestamp = new Date().toISOString();
  return {
    jobId: "agent_smoke_logs_001",
    taskId: "least-agent-smoke-logs",
    createdAt: timestamp,
    updatedAt: timestamp,
    workspaceId: ws.id,
    workspaceRoot: ws.root,
    agent: "codex-host",
    repository: "least",
    title: "Agent terminal smoke test",
    promptFile: path.join(ws.root, ".ai-bridge", "agent-runs", "agent_smoke_logs_001", "prompt.md"),
    state: "running",
    timeoutMs: 3_600_000,
    idleTimeoutMs: 900_000,
    ...overrides
  };
}

async function writeFakeLogs(ws, jobId, lines = ["line-1", "line-2", "line-3"]) {
  const dir = agentJobDir(ws, jobId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "stdout.log"), `${lines.join("\n")}\n`, "utf8");
  await fs.writeFile(path.join(dir, "stderr.log"), "stderr-smoke\n", "utf8");
  await fs.writeFile(path.join(dir, "events.jsonl"), '{"event":"smoke"}\n', "utf8");
}

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "least-agent-terminal-smoke-"));
const ws = workspace(tmpRoot);

try {
  resetTerminalExecCache();

  const logsJob = baseJob(ws);
  await writeAgentJob(ws, logsJob);
  await writeFakeLogs(ws, logsJob.jobId);

  const zellijJob = baseJob(ws, {
    jobId: "agent_smoke_zellij_001",
    taskId: "least-agent-smoke-zellij",
    title: "Zellij metadata smoke",
    terminal: {
      backend: "zellij",
      sessionName: "agent-smoke-zellij",
      paneId: "0",
      attachCommand: "zellij attach agent-smoke-zellij",
      watchCommand: "zellij watch agent-smoke-zellij",
      tailCommand: "zellij --session agent-smoke-zellij action dump-screen --pane-id 0 --full"
    }
  });
  await writeAgentJob(ws, zellijJob);

  const tmuxJob = baseJob(ws, {
    jobId: "agent_smoke_tmux_001",
    taskId: "least-agent-smoke-tmux",
    title: "tmux metadata smoke",
    groundcrew: { workspaceName: "groundcrew:least-agent-smoke-tmux" },
    terminal: {
      backend: "tmux",
      sessionName: "groundcrew:least-agent-smoke-tmux",
      attachCommand: "tmux attach -t groundcrew:least-agent-smoke-tmux",
      tailCommand: "tmux capture-pane -p -t groundcrew:least-agent-smoke-tmux -S -200"
    }
  });
  await writeAgentJob(ws, tmuxJob);

  const backends = await detectTerminalBackends(ws);
  assert.ok(backends.some((entry) => entry.backend === "logs" && entry.available), "logs backend should always be available");
  console.log("agent-terminal-smoke: detectTerminalBackends ok");

  const doctor = await agentTerminalDoctor(ws);
  assert.ok(doctor.structured.terminal_backends, "doctor should return terminal_backends");
  assert.match(doctor.text, /Agent Terminal Doctor/);
  console.log("agent-terminal-smoke: agent_terminal_doctor ok");

  const tail = await agentTail(ws, { workspaceId: ws.id, workspaceRoot: ws.root, jobId: logsJob.jobId, lines: 50 });
  assert.equal(tail.structured.source, "logs");
  assert.match(tail.structured.text, /line-3/);
  if (process.platform === "win32") {
    assert.match(String(tail.structured.tail_hint), /Get-Content -Tail 50/);
  } else {
    assert.match(String(tail.structured.tail_hint), /tail -n 50/);
  }
  console.log("agent-terminal-smoke: agent_tail logs fallback ok");

  const sessions = await agentSessions(ws);
  assert.ok(sessions.structured.count >= 3, "should list fake zellij, tmux, and logs sessions");
  const sessionBackends = new Set(sessions.structured.sessions.map((entry) => entry.backend));
  assert.ok(sessionBackends.has("logs"), "sessions should include logs fallback");
  console.log("agent-terminal-smoke: agent_sessions ok");

  const zellijHint = await agentAttachHint(ws, { workspaceId: ws.id, workspaceRoot: ws.root, jobId: zellijJob.jobId });
  assert.ok(zellijHint.structured.attach_commands.some((cmd) => /zellij attach agent-smoke-zellij/.test(cmd)));
  assert.ok(zellijHint.structured.watch_commands.some((cmd) => /zellij watch agent-smoke-zellij/.test(cmd)));
  assert.ok(zellijHint.structured.tail_commands.some((cmd) => /dump-screen --pane-id 0/.test(cmd)));
  console.log("agent-terminal-smoke: agent_attach_hint zellij ok");

  const tmuxHint = await agentAttachHint(ws, { workspaceId: ws.id, workspaceRoot: ws.root, jobId: tmuxJob.jobId });
  assert.ok(tmuxHint.structured.attach_commands.some((cmd) => /tmux attach -t groundcrew:least-agent-smoke-tmux/.test(cmd)));
  assert.ok(tmuxHint.structured.tail_commands.some((cmd) => /tmux capture-pane -p -t groundcrew:least-agent-smoke-tmux/.test(cmd)));
  console.log("agent-terminal-smoke: agent_attach_hint tmux ok");

  const logsHint = await agentAttachHint(ws, { workspaceId: ws.id, workspaceRoot: ws.root, jobId: logsJob.jobId });
  const logsStructured = logsHint.structured;
  if (process.platform === "win32") {
    assert.ok(logsStructured.tail_commands.some((cmd) => /Get-Content -Tail 200/.test(cmd)));
    assert.ok(logsStructured.attach_commands.some((cmd) => /Get-Content -Wait/.test(cmd)));
    assert.ok(logsStructured.fallback_commands.every((cmd) => /Get-Content -Tail 200/.test(cmd)));
  } else {
    assert.ok(logsStructured.tail_commands.some((cmd) => /tail -n 200/.test(cmd)));
    assert.ok(logsStructured.attach_commands.some((cmd) => /tail -f/.test(cmd)));
  }
  console.log("agent-terminal-smoke: attach hints logs fallback ok");

  console.log("agent-terminal-smoke: ok");
} finally {
  await fs.rm(tmpRoot, { recursive: true, force: true });
}