#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const {
  refreshAgentDeckJob,
  restartAgentDeckSession,
  startAgentDeckLaunch,
  stopAgentDeckSession
} = await import("../dist/agentDeck.js");

const root = await fs.mkdtemp(path.join(os.tmpdir(), "least-agent-deck-unit-"));
const fakeDeck = path.join(root, "agent-deck-fake.mjs");
const callsPath = path.join(root, "calls.jsonl");
const worktree = path.join(root, ".worktrees", "feature-unit-task");

await fs.writeFile(fakeDeck, `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + "\\n");
if (args[0] === "launch") {
  console.log(JSON.stringify({
    success: true,
    session_id: "unit-session-1",
    path: ${JSON.stringify(worktree)},
    group: "Least",
    command: "piv --piv-mode build --piv-allow-bash",
    resolved_command: "piv --piv-mode build --piv-allow-bash",
    tool: "shell",
    worktree_path: ${JSON.stringify(worktree)},
    worktree_branch: "feature/unit-task"
  }));
  process.exit(0);
}
if (args[0] === "session" && args[1] === "show") {
  console.log(JSON.stringify({
    id: "unit-session-1",
    status: "running",
    title: "unit task",
    path: ${JSON.stringify(worktree)},
    command: "piv --piv-mode build --piv-allow-bash",
    tool: "shell",
    group: "Least",
    tmux_session: "agentdeck_unit_task_deadbeef"
  }));
  process.exit(0);
}
if (args[0] === "session" && (args[1] === "stop" || args[1] === "start")) {
  console.log("ok");
  process.exit(0);
}
console.error("unexpected args", args);
process.exit(2);
`, "utf8");
await fs.chmod(fakeDeck, 0o755);
await fs.mkdir(worktree, { recursive: true });

const workspace = {
  id: "agent-deck-unit",
  root,
  name: "agent-deck-unit",
  createdAt: new Date().toISOString()
};
const createdAt = new Date().toISOString();
const job = {
  jobId: "agent_unit_task_001",
  taskId: "unit-task",
  createdAt,
  updatedAt: createdAt,
  workspaceId: workspace.id,
  workspaceRoot: root,
  agent: "piv-build",
  repository: "least",
  title: "unit task",
  promptFile: path.join(root, ".ai-bridge", "agent-runs", "agent_unit_task_001", "prompt.md"),
  state: "provisioning",
  timeoutMs: 3_600_000,
  idleTimeoutMs: 900_000,
  launch: {
    phase: "provisioning",
    acceptedAt: createdAt,
    startedAt: createdAt
  }
};
const profile = {
  provider: "custom",
  cmd: "piv --piv-mode build --piv-allow-bash",
  promptVia: "interactive",
  writePolicy: "worktree",
  enabled: true
};
const sessionManager = {
  kind: "agent-deck",
  executable: fakeDeck,
  group: "Least",
  worktree: true,
  newBranch: true,
  noParent: true,
  titleLock: true
};

try {
  const started = await startAgentDeckLaunch({
    workspace,
    job,
    profile,
    sessionManager,
    startInput: {
      workspaceId: workspace.id,
      workspaceRoot: root,
      agent: "piv-build",
      repository: "least",
      title: "unit task",
      prompt: "Return UNIT_READY.",
      taskId: "unit-task"
    }
  });
  assert.equal(started.state, "running");
  assert.equal(started.agentDeck?.sessionId, "unit-session-1");
  assert.equal(started.agentDeck?.command, "piv --piv-mode build --piv-allow-bash");
  assert.equal(started.terminal?.backend, "tmux");
  assert.equal(started.terminal?.sessionName, "agentdeck_unit_task_deadbeef");
  assert.equal(started.groundcrew?.worktreeDir, worktree);

  const calls = (await fs.readFile(callsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const launchCall = calls.find((call) => call[0] === "launch");
  assert.ok(launchCall);
  assert.equal(launchCall[launchCall.indexOf("--cmd") + 1], "piv --piv-mode build --piv-allow-bash");
  assert.equal(launchCall[launchCall.indexOf("--message") + 1], "Return UNIT_READY.");
  assert.ok(launchCall.includes("--no-wait"));
  assert.ok(launchCall.includes("--worktree"));
  assert.ok(launchCall.includes("--new-branch"));
  assert.ok(launchCall.includes("--no-parent"));
  assert.ok(launchCall.includes("--title-lock"));

  const refreshed = await refreshAgentDeckJob(workspace, started, sessionManager);
  assert.equal(refreshed.state, "running");
  assert.equal(refreshed.agentDeck?.status, "running");

  const stopped = await stopAgentDeckSession(workspace, refreshed, sessionManager, "cancelled", "unit done");
  assert.equal(stopped.state, "cancelled");
  assert.equal(stopped.terminal?.exited, true);

  const resumed = await restartAgentDeckSession(workspace, stopped, sessionManager);
  assert.equal(resumed.state, "running");
  assert.equal(resumed.agentDeck?.status, "running");

  console.log("agent-deck-unit: ok");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
