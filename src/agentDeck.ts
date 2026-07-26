import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentSessionManagerConfig, LocalAgentProfile } from "./agentConfig.js";
import { commandTextForLocalAgent } from "./agentConfig.js";
import type { AgentJobRecord, AgentStartInput } from "./agentTypes.js";
import type { Workspace } from "./guard.js";
import { LeastError } from "./guard.js";
import { writeAgentJob } from "./agentJobStore.js";

const execFileAsync = promisify(execFile);
const DEFAULT_AGENT_DECK_TIMEOUT_MS = 120_000;

interface AgentDeckLaunchResponse {
  success?: boolean;
  id?: string;
  session_id?: string;
  path?: string;
  profile?: string;
  group?: string;
  command?: string;
  resolved_command?: string;
  title?: string;
  tool?: string;
  worktree_path?: string;
  worktree_branch?: string;
}

interface AgentDeckSessionResponse {
  id?: string;
  status?: string;
  title?: string;
  path?: string;
  command?: string;
  tool?: string;
  profile?: string;
  group?: string;
  tmux_session?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function clampTimeout(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_AGENT_DECK_TIMEOUT_MS;
  return Math.max(10_000, Math.min(10 * 60_000, Math.floor(value!)));
}

function parseJson<T>(stdout: string, command: string): T {
  const trimmed = stdout.trim();
  if (!trimmed) throw new LeastError(`${command} returned no JSON output.`);
  try {
    return JSON.parse(trimmed) as T;
  } catch (error) {
    throw new LeastError(`${command} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function executable(config: AgentSessionManagerConfig | undefined): string {
  return config?.executable?.trim() || "agent-deck";
}

function sanitizeWorktreeName(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized.slice(0, 80) || `least-${Date.now()}`;
}

function shellQuote(value: string): string {
  if (/^[a-zA-Z0-9_./:=+@%-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function profileCommand(profile: LocalAgentProfile): string {
  const value = profile.command ?? profile.cmd;
  if (Array.isArray(value)) return value.map(shellQuote).join(" ");
  return commandTextForLocalAgent(profile).trim();
}

async function runJson<T>(config: AgentSessionManagerConfig | undefined, args: string[], cwd: string): Promise<T> {
  const command = executable(config);
  try {
    const { stdout } = await execFileAsync(command, args, {
      cwd,
      timeout: clampTimeout(config?.launchTimeoutMs),
      maxBuffer: 2_000_000,
      env: process.env
    });
    return parseJson<T>(stdout, `${command} ${args.join(" ")}`);
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout?.trim();
    const stderr = (error as { stderr?: string }).stderr?.trim();
    const message = error instanceof Error ? error.message : String(error);
    throw new LeastError([`Agent Deck command failed: ${message}`, stderr, stdout].filter(Boolean).join("\n"));
  }
}

export async function showAgentDeckSession(
  config: AgentSessionManagerConfig | undefined,
  sessionId: string,
  cwd: string
): Promise<AgentDeckSessionResponse> {
  const args = ["session", "show", sessionId, "--json"];
  if (config?.profile) args.unshift("--profile", config.profile);
  return await runJson<AgentDeckSessionResponse>(config, args, cwd);
}

export async function startAgentDeckLaunch(input: {
  workspace: Workspace;
  job: AgentJobRecord;
  profile: LocalAgentProfile;
  sessionManager: AgentSessionManagerConfig;
  startInput: AgentStartInput;
}): Promise<AgentJobRecord> {
  const command = profileCommand(input.profile);
  if (!command) throw new LeastError(`Agent ${input.job.agent} has no command for Agent Deck.`);

  const group = input.sessionManager.group?.trim() || "Least";
  const title = input.job.title.trim() || input.job.taskId;
  const prompt = input.startInput.prompt.trim();
  const args: string[] = [];
  if (input.sessionManager.profile) args.push("--profile", input.sessionManager.profile);
  args.push(
    "launch",
    input.workspace.root,
    "--cmd",
    command,
    "--message",
    prompt,
    "--title",
    title,
    "--group",
    group,
    "--json"
  );
  if (input.sessionManager.noParent !== false) args.push("--no-parent");
  if (input.sessionManager.titleLock !== false) args.push("--title-lock");
  args.push("--no-wait");
  if (input.sessionManager.worktree !== false) {
    args.push("--worktree", sanitizeWorktreeName(input.job.taskId));
    if (input.sessionManager.newBranch !== false) args.push("--new-branch");
  }

  const launch = await runJson<AgentDeckLaunchResponse>(input.sessionManager, args, input.workspace.root);
  const sessionId = launch.session_id ?? launch.id;
  if (!launch.success || !sessionId) {
    throw new LeastError(`Agent Deck did not return a successful session id: ${JSON.stringify(launch)}`);
  }
  const session = await showAgentDeckSession(input.sessionManager, sessionId, input.workspace.root);
  const worktreeDir = launch.worktree_path ?? launch.path ?? session.path ?? input.workspace.root;
  const branchName = launch.worktree_branch;
  const tmuxSession = session.tmux_session;
  const status = session.status ?? "running";
  const updatedAt = nowIso();

  return await writeAgentJob(input.workspace, {
    ...input.job,
    state: "running",
    detail: undefined,
    launch: {
      ...(input.job.launch ?? { phase: "accepted", acceptedAt: input.job.createdAt }),
      phase: "running",
      setupStartedAt: input.job.launch?.setupStartedAt ?? updatedAt,
      setupFinishedAt: updatedAt,
      lastUpdateAt: updatedAt,
      error: undefined
    },
    groundcrew: {
      worktreeDir,
      branchName,
      workspaceName: tmuxSession,
      runState: {
        launcher: "agent-deck",
        session_id: sessionId,
        status,
        worktree_dir: worktreeDir,
        branch_name: branchName,
        tmux_session: tmuxSession
      }
    },
    agentDeck: {
      sessionId,
      profile: launch.profile ?? input.sessionManager.profile,
      group: launch.group ?? group,
      command: launch.command ?? command,
      resolvedCommand: launch.resolved_command,
      tool: launch.tool ?? session.tool,
      status,
      tmuxSession,
      worktreePath: worktreeDir,
      worktreeBranch: branchName
    },
    terminal: {
      backend: "tmux",
      sessionName: tmuxSession,
      paneCwd: worktreeDir,
      paneCommand: launch.resolved_command ?? launch.command ?? command,
      attachCommand: `${executable(input.sessionManager)} session attach ${shellQuote(sessionId)}`,
      watchCommand: `${executable(input.sessionManager)} session attach ${shellQuote(sessionId)}`,
      tailCommand: tmuxSession ? `tmux capture-pane -p -t ${shellQuote(tmuxSession)} -S -200` : undefined,
      inferred: false
    }
  });
}

function isFinalState(job: AgentJobRecord): boolean {
  return ["completed", "cancelled", "interrupted", "timeout-soft", "timeout-hard", "failed-to-launch", "missing"].includes(job.state);
}

export async function refreshAgentDeckJob(
  workspace: Workspace,
  job: AgentJobRecord,
  config?: AgentSessionManagerConfig
): Promise<AgentJobRecord> {
  if (!job.agentDeck?.sessionId || isFinalState(job)) return job;
  try {
    const session = await showAgentDeckSession(config, job.agentDeck.sessionId, workspace.root);
    const status = session.status ?? job.agentDeck.status ?? "unknown";
    const tmuxSession = session.tmux_session ?? job.agentDeck.tmuxSession;
    const worktreeDir = session.path ?? job.groundcrew?.worktreeDir ?? job.agentDeck.worktreePath;
    const failed = status === "error";
    const nextState = failed ? "interrupted" : "running";
    const updatedAt = nowIso();
    return await writeAgentJob(workspace, {
      ...job,
      state: nextState,
      detail: failed ? `Agent Deck session ${job.agentDeck.sessionId} is in error state.` : undefined,
      launch: {
        ...(job.launch ?? { phase: "accepted", acceptedAt: job.createdAt }),
        phase: failed ? "failed" : "running",
        lastUpdateAt: updatedAt,
        ...(failed ? { error: `Agent Deck session status: ${status}` } : { error: undefined })
      },
      groundcrew: {
        ...job.groundcrew,
        worktreeDir,
        workspaceName: tmuxSession,
        runState: {
          ...(job.groundcrew?.runState ?? {}),
          launcher: "agent-deck",
          session_id: job.agentDeck.sessionId,
          status,
          tmux_session: tmuxSession,
          worktree_dir: worktreeDir
        }
      },
      agentDeck: {
        ...job.agentDeck,
        status,
        tmuxSession,
        worktreePath: worktreeDir,
        tool: session.tool ?? job.agentDeck.tool,
        command: session.command ?? job.agentDeck.command,
        group: session.group ?? job.agentDeck.group,
        profile: session.profile ?? job.agentDeck.profile
      },
      terminal: {
        ...job.terminal,
        backend: "tmux",
        sessionName: tmuxSession,
        paneCwd: worktreeDir,
        paneCommand: session.command ?? job.terminal?.paneCommand,
        attachCommand: `${executable(config)} session attach ${shellQuote(job.agentDeck.sessionId)}`,
        watchCommand: `${executable(config)} session attach ${shellQuote(job.agentDeck.sessionId)}`,
        tailCommand: tmuxSession ? `tmux capture-pane -p -t ${shellQuote(tmuxSession)} -S -200` : job.terminal?.tailCommand,
        inferred: false
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return await writeAgentJob(workspace, {
      ...job,
      state: "interrupted",
      detail: `Agent Deck session ${job.agentDeck.sessionId} is unavailable: ${message}`,
      launch: {
        ...(job.launch ?? { phase: "accepted", acceptedAt: job.createdAt }),
        phase: "failed",
        lastUpdateAt: nowIso(),
        error: message
      },
      terminal: {
        backend: job.terminal?.backend ?? "tmux",
        ...job.terminal,
        warnings: [...new Set([...(job.terminal?.warnings ?? []), message])]
      }
    });
  }
}

export async function stopAgentDeckSession(
  workspace: Workspace,
  job: AgentJobRecord,
  config?: AgentSessionManagerConfig,
  state: AgentJobRecord["state"] = "cancelled",
  reason?: string
): Promise<AgentJobRecord> {
  if (!job.agentDeck?.sessionId) throw new LeastError(`Job ${job.jobId} has no Agent Deck session id.`);
  const args = ["session", "stop", job.agentDeck.sessionId];
  if (config?.profile) args.unshift("--profile", config.profile);
  const command = executable(config);
  try {
    await execFileAsync(command, args, {
      cwd: workspace.root,
      timeout: clampTimeout(config?.launchTimeoutMs),
      maxBuffer: 1_000_000,
      env: process.env
    });
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    const message = stderr || (error instanceof Error ? error.message : String(error));
    if (!/not found|already stopped|not running/i.test(message)) throw new LeastError(`Failed to stop Agent Deck session: ${message}`);
  }
  const updatedAt = nowIso();
  return await writeAgentJob(workspace, {
    ...job,
    state,
    detail: reason,
    launch: {
      ...(job.launch ?? { phase: "accepted", acceptedAt: job.createdAt }),
      phase: state === "completed" ? "completed" : "failed",
      lastUpdateAt: updatedAt,
      ...(state === "completed" ? { setupFinishedAt: updatedAt, error: undefined } : { error: reason })
    },
    agentDeck: {
      ...job.agentDeck,
      status: state
    },
    terminal: {
      ...job.terminal,
      backend: "tmux",
      exited: true
    }
  });
}

export async function restartAgentDeckSession(
  workspace: Workspace,
  job: AgentJobRecord,
  config?: AgentSessionManagerConfig
): Promise<AgentJobRecord> {
  if (!job.agentDeck?.sessionId) throw new LeastError(`Job ${job.jobId} has no Agent Deck session id.`);
  const args = ["session", "start", job.agentDeck.sessionId];
  if (config?.profile) args.unshift("--profile", config.profile);
  const command = executable(config);
  await execFileAsync(command, args, {
    cwd: workspace.root,
    timeout: clampTimeout(config?.launchTimeoutMs),
    maxBuffer: 1_000_000,
    env: process.env
  });
  return await refreshAgentDeckJob(workspace, {
    ...job,
    state: "resumed",
    launch: {
      ...(job.launch ?? { phase: "accepted", acceptedAt: job.createdAt }),
      phase: "running",
      lastUpdateAt: nowIso(),
      error: undefined
    }
  }, config);
}
