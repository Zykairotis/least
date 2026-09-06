# Least + Agent Deck on Arch Linux

This document describes the Arch-native local-agent workflow for Least. Agent Deck is the session and worktree owner; Least remains the durable orchestration, monitoring, timeout, and result-inspection layer.

## Effective harnesses

| Least profile | Exact harness command | Purpose |
| --- | --- | --- |
| `codex` | `codex --yolo` | Codex interactive coding harness |
| `piv-build` | `piv --piv-mode build --piv-allow-bash` | Piv build-mode harness with Bash enabled |
| `claude-code` | `claude` | Claude Code interactive harness |
| `grok-build` | `agent --yolo` | Grok Build interactive harness |

`omp`, `pi`, WSL launchers, and Windows `.cmd` wrappers are not used by this Arch configuration.

The executable resolved for Piv during setup was:

```text
/home/mewtwo/.npm-global/bin/piv
```

## User workflow

```text
You / ChatGPT
      |
      | agent_start(profile, repository, task, prompt)
      v
+-------------------------+
| Least orchestration     |
|                         |
| - durable job id        |
| - dependency graph      |
| - timeout/watchdog      |
| - status/tail/result    |
| - cancellation/resume   |
+------------+------------+
             |
             | agent-deck launch
             | --cmd <exact harness>
             | --message <task prompt>
             | --worktree <task id>
             | --new-branch --no-wait
             v
+-------------------------+
| Agent Deck              |
|                         |
| - visible session card  |
| - tmux session owner    |
| - live terminal output  |
| - session attach/stop   |
| - isolated Git worktree |
+------------+------------+
             |
             | starts inside Agent Deck worktree
             v
+-------------------------+
| Selected harness        |
|                         |
| codex --yolo            |
| piv --piv-mode build... |
| claude                  |
| agent --yolo            |
+------------+------------+
             |
             | edits/tests/terminal output
             v
+-------------------------+
| Isolated task branch    |
|                         |
| main checkout untouched |
| until changes reviewed  |
+------------+------------+
             |
             | agent_tail / agent_result
             v
+-------------------------+
| Least review layer      |
|                         |
| diff, files, tests,     |
| minimality, final report|
+-------------------------+
```

## What happens when an agent starts

1. Least validates the requested profile and creates a durable job record under `.ai-bridge/agent-runs/`.
2. Least calls Agent Deck with `--no-wait`, preserving Least's asynchronous `agent_start` contract.
3. Agent Deck creates a task-specific Git worktree and branch under `.worktrees/`.
4. Agent Deck creates and registers a tmux session in the `Least` group.
5. Agent Deck runs the configured harness command inside the new worktree.
6. Agent Deck delivers Least's prompt through its `--message` mechanism.
7. Least stores the Agent Deck session id, tmux session name, worktree path, branch, and exact command in the job record.
8. `agent_status`, `agent_tail`, `agent_result`, `agent_cancel`, `agent_resume`, and the watchdog use that stored session metadata.

## Watching agents live

Open Agent Deck normally and select the session in the `Least` group. The session title is the Least job title.

CLI alternatives:

```bash
agent-deck list
agent-deck session show <session-id> --json
agent-deck session attach <session-id>
```

Least alternatives:

```bash
npm run agent:cli -- status --root /home/mewtwo/ZSSD/least --task-id <task-id>
npm run agent:cli -- tail --root /home/mewtwo/ZSSD/least --task-id <task-id> --lines 120
npm run agent:cli -- result --root /home/mewtwo/ZSSD/least --task-id <task-id>
```

The tmux fallback is:

```bash
tmux attach -t <agentdeck_tmux_session>
tmux capture-pane -p -t <agentdeck_tmux_session> -S -200
```

## Starting each harness

Codex:

```bash
npm run agent:cli -- start \
  --root /home/mewtwo/ZSSD/least \
  --agent codex \
  --repository least \
  --title "Codex task" \
  --prompt "Implement the requested change and run targeted tests."
```

Piv:

```bash
npm run agent:cli -- start \
  --root /home/mewtwo/ZSSD/least \
  --agent piv-build \
  --repository least \
  --title "Piv build task" \
  --prompt "Implement the requested change and verify it."
```

Claude Code:

```bash
npm run agent:cli -- start \
  --root /home/mewtwo/ZSSD/least \
  --agent claude-code \
  --repository least \
  --title "Claude task" \
  --prompt "Review and implement the requested change."
```

Grok Build:

```bash
npm run agent:cli -- start \
  --root /home/mewtwo/ZSSD/least \
  --agent grok-build \
  --repository least \
  --title "Grok task" \
  --prompt "Implement the requested change and report validation."
```

Add `--wait-for-launch --startup-wait-ms 30000` when the caller needs the Agent Deck session metadata in the initial response.

## Stop and resume

Stop a job while preserving its Agent Deck worktree:

```bash
npm run agent:cli -- cancel \
  --root /home/mewtwo/ZSSD/least \
  --task-id <task-id> \
  --reason "Stopped for review."
```

Resume the same Agent Deck session and worktree:

```bash
npm run agent:cli -- resume \
  --root /home/mewtwo/ZSSD/least \
  --task-id <task-id>
```

Cancellation stops the Agent Deck session but deliberately preserves the task worktree for inspection. Cleanup remains conservative by default.

## Safety model

The requested `--yolo` modes are explicitly allowed only in the local Arch profiles. Their containment boundary is the Agent Deck-created Git worktree, not the primary checkout.

The operational rule is:

```text
high-permission harness + isolated worktree + visible live session + independent diff review
```

Before accepting an agent's changes:

1. inspect `agent_result` and the worktree diff;
2. read changed source and test files;
3. run targeted tests from Least;
4. reject unrelated or excessive changes;
5. merge or transfer only reviewed changes.

## Piv project trust

Piv requires project trust before Bash and project resources can be used. During configuration, the shared Agent Deck worktree parent was trusted once:

```text
/home/mewtwo/ZSSD/least/.worktrees
```

This allows future Agent Deck worktrees under that parent to start without changing the required harness command. The harness remains exactly:

```text
piv --piv-mode build --piv-allow-bash
```

## Configuration files

- `agents.local.jsonc`: Agent Deck backend and local Arch harness definitions.
- `crew.config.ts`: Arch-compatible Groundcrew fallback inventory using tmux.
- `crew.config.json`: matching non-TypeScript fallback configuration.
- `src/agentDeck.ts`: Agent Deck launch/status/stop/restart adapter.
- `scripts/agent-deck-unit.mjs`: deterministic adapter regression test.

## Verification commands

```bash
npm run build
node scripts/agent-deck-unit.mjs
npm run agent:cli -- doctor --root /home/mewtwo/ZSSD/least --format json
```

A successful doctor run should report:

```text
OK: true
Session manager: agent-deck
Enabled local profiles: claude-code, grok-build, codex, piv-build
```
