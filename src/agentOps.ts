import { createHash } from "node:crypto";
import type { Workspace } from "./guard.js";
import { LeastError } from "./guard.js";
import type { AgentCancelInput, AgentJobRecord, AgentPlanInput, AgentStartInput, AgentStatusInput } from "./agentTypes.js";
import {
  createAgentJob,
  findAgentJobByIdempotencyKey,
  findAgentJobByTask,
  makeAgentTaskId,
  resolveAgentJob,
  writeAgentJob
} from "./agentJobStore.js";
import {
  agentDefinitionsFromGroundcrewConfig,
  defaultAgentFromGroundcrewConfig,
  loadGroundcrewRuntime,
  refreshJobFromGroundcrew
} from "./agentGroundcrewAdapter.js";
import { classifyAgentLaunchRecovery, enqueueAgentLaunch, waitForAgentLaunch } from "./agentLaunchCoordinator.js";
import { summarizeAgentResult } from "./agentResult.js";
import { tailAgentJob } from "./agentTail.js";
import { waitForAgentArtifacts } from "./agentTerminalLogs.js";
import { evaluateAgentWatchdog, type AgentWatchdogResult } from "./agentWatchdog.js";
import { runAgentDoctor } from "./agentDoctor.js";
import { attachHintForJob, detectTerminalBackends, inferTerminalMetadata, listAgentTerminalSessions } from "./agentTerminalBackend.js";

const DEFAULT_AGENT_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_AGENT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_AGENT_STARTUP_WAIT_MS = 5_000;

function clampInt(value: number, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function textBlock(title: string, value: unknown): string {
  return `## ${title}\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function coerceString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function planTaskId(title: string, supplied?: string): string {
  return supplied && supplied.trim().length > 0 ? supplied.trim() : makeAgentTaskId(title);
}

function isoAfter(baseIso: string, ms: number): string {
  return new Date(Date.parse(baseIso) + ms).toISOString();
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function uniqueWarnings(items: Array<string | undefined>): string[] {
  return [...new Set(items.filter((item): item is string => typeof item === "string" && item.trim().length > 0))];
}

function missingArtifactDetailMessage(root: string, checked: readonly string[], elapsedMs: number): string {
  return `Completed terminal exited successfully, but no result artifacts appeared in ${elapsedMs}ms at ${root}. Expected one of: ${checked.join(", ")}.`;
}

function jobStructured(job: AgentJobRecord, watchdog?: AgentWatchdogResult): Record<string, unknown> {
  return {
    job_id: job.jobId,
    task_id: job.taskId,
    state: job.state,
    agent: job.agent,
    repository: job.repository,
    worktree_dir: job.groundcrew?.worktreeDir,
    branch_name: job.groundcrew?.branchName,
    workspace_name: job.groundcrew?.workspaceName,
    timeout_ms: job.timeoutMs,
    idle_timeout_ms: job.idleTimeoutMs,
    deadline_at: job.watchdog?.deadlineAt,
    idle_deadline_at: job.watchdog?.idleDeadlineAt,
    last_activity_at: job.watchdog?.lastActivityAt,
    last_output_at: job.watchdog?.lastOutputAt,
    watchdog_last_checked_at: job.watchdog?.lastCheckedAt,
    idempotency_key: job.idempotencyKey,
    request_hash: job.requestHash,
    launch: job.launch,
    launch_phase: job.launch?.phase,
    launch_error: job.launch?.error,
    timed_out_at: job.watchdog?.timedOutAt,
    timeout_reason: job.watchdog?.timeoutReason,
    interrupt_attempted_at: job.watchdog?.interruptAttemptedAt,
    interrupt_error: job.watchdog?.interruptError,
    detail: job.detail,
    terminal: job.terminal,
    ...(watchdog
      ? {
          watchdog: {
            checked: watchdog.checked,
            timed_out: watchdog.timedOut,
            timeout_reason: watchdog.timeoutReason,
            interrupted: watchdog.interrupted,
            interrupt_error: watchdog.interruptError,
            warnings: watchdog.warnings
          }
        }
      : {}),
    groundcrew_state: job.groundcrew?.runState
  };
}

export function normalizeAgentTimeoutMs(value: unknown): number {
  return clampInt(Number(value), DEFAULT_AGENT_TIMEOUT_MS, 60_000, 24 * 60 * 60 * 1000);
}

export function normalizeAgentIdleTimeoutMs(value: unknown): number {
  return clampInt(Number(value), DEFAULT_AGENT_IDLE_TIMEOUT_MS, 60_000, 3 * 60 * 60 * 1000);
}

export function normalizeAgentStartupWaitMs(value: unknown): number {
  return clampInt(Number(value), DEFAULT_AGENT_STARTUP_WAIT_MS, 0, 30_000);
}

export async function agentDoctor(workspace: Workspace): Promise<{ text: string; structured: Record<string, unknown> }> {
  const result = await runAgentDoctor(workspace);
  return { text: result.text, structured: result.structured as unknown as Record<string, unknown> };
}

async function refreshTerminalMetadataBestEffort(workspace: Workspace, job: AgentJobRecord): Promise<AgentJobRecord> {
  try {
    const terminal = await inferTerminalMetadata(workspace, job);
    const exitedSuccessfully =
      terminal.backend === "zellij" &&
      terminal.exited === true &&
      terminal.exitStatus === 0;
    const wasActive = job.state === "accepted" || job.state === "running" || job.state === "provisioning" || job.state === "resumed";
    let nextState = job.state;
    let detail = job.detail;
    let terminalWarnings = [...(terminal.warnings ?? [])];

    if (exitedSuccessfully && wasActive) {
      const artifacts = await waitForAgentArtifacts(workspace, job, { timeoutMs: 5_000, intervalMs: 250 });
      nextState = "completed";
      if (artifacts.found) {
        if (detail?.startsWith("Completed terminal exited successfully,")) detail = undefined;
      } else {
        detail = missingArtifactDetailMessage(artifacts.root, artifacts.checked_files, artifacts.elapsed_ms);
        terminalWarnings.push(detail);
      }
    }

    return await writeAgentJob(workspace, {
      ...job,
      state: nextState,
      detail,
      terminal: {
        ...terminal,
        ...(terminalWarnings.length ? { warnings: uniqueWarnings(terminalWarnings) } : {})
      }
    });
  } catch (error) {
    return await writeAgentJob(workspace, {
      ...job,
      terminal: {
        backend: job.terminal?.backend ?? "none",
        ...job.terminal,
        inferred: true,
        warnings: uniqueWarnings([...(job.terminal?.warnings ?? []), error instanceof Error ? error.message : String(error)])
      }
    });
  }
}

function isActiveLifecycleState(state: AgentJobRecord["state"]): boolean {
  return state === "accepted" || state === "running" || state === "provisioning" || state === "resumed";
}

function isLaunchPending(job: AgentJobRecord): boolean {
  const phase = job.launch?.phase;
  if (!phase) return job.state === "accepted" || job.state === "provisioning";
  return phase === "accepted" || phase === "provisioning" || phase === "groundcrew-setup" || phase === "terminal-detected";
}

async function resolveExistingStart(workspace: Workspace, input: AgentStartInput): Promise<AgentJobRecord | undefined> {
  if (input.taskId) {
    const byTask = await findAgentJobByTask(workspace, input.taskId);
    if (byTask) return byTask;
  }
  if (input.idempotencyKey) {
    const byIdempotency = await findAgentJobByIdempotencyKey(workspace, input.idempotencyKey);
    if (byIdempotency) return byIdempotency;
  }
  return undefined;
}

function startResponseStructured(job: AgentJobRecord, options: { reused: boolean; startupWaitElapsed?: boolean }): Record<string, unknown> {
  return {
    ...jobStructured(job),
    accepted: true,
    reused: options.reused,
    recovery_status:
      job.launch?.phase === "recovery-required" || job.launch?.phase === "orphaned"
        ? job.launch.phase
        : undefined,
    launch_async: isLaunchPending(job),
    startup_wait_elapsed: options.startupWaitElapsed === true,
    status_path: ".ai-bridge/agent-runs/<job_id>/status.json",
    next: {
      status: "agent_status",
      tail: "agent_tail",
      result: "agent_result",
      attach_hint: "agent_attach_hint",
      watchdog: "agent_watchdog"
    }
  };
}

function shouldRefreshTerminalMetadata(job: AgentJobRecord): boolean {
  const hasGroundcrewContext = Boolean(job.groundcrew?.workspaceName || job.groundcrew?.worktreeDir);
  if (!job.terminal) return hasGroundcrewContext;
  if (job.terminal.backend === "logs") return hasGroundcrewContext;
  if (
    isActiveLifecycleState(job.state) &&
    job.terminal.backend === "zellij" &&
    hasGroundcrewContext
  ) {
    return true;
  }
  if (
    job.terminal.backend === "zellij" &&
    job.groundcrew?.workspaceName &&
    job.terminal.tabName !== job.groundcrew.workspaceName
  ) {
    return true;
  }
  return false;
}

export async function agentList(): Promise<{ text: string; structured: Record<string, unknown> }> {
  const runtime = await loadGroundcrewRuntime();
  const config = await runtime.loadConfig();
  const definitions = agentDefinitionsFromGroundcrewConfig(config);
  const defaultAgent = defaultAgentFromGroundcrewConfig(config);
  const agents = Object.entries(definitions).map(([name, definition]) => ({
    name,
    default: name === defaultAgent,
    command: typeof definition.cmd === "string" ? definition.cmd : undefined,
    color: typeof definition.color === "string" ? definition.color : undefined,
    supports_resume: typeof definition.resumeArgs === "string" && definition.resumeArgs.length > 0,
    resume_args: typeof definition.resumeArgs === "string" ? definition.resumeArgs : undefined,
    sandbox: definition.sandbox ?? undefined
  }));
  const structured = {
    available: true,
    default_agent: defaultAgent,
    count: agents.length,
    agents
  };
  const text = [`# Agent List`, "", `Groundcrew available: true`, `Default agent: ${defaultAgent ?? "(none)"}`, `Configured agents: ${agents.length}`, "", textBlock("Agents", agents)].join("\n");
  return { text, structured };
}

export function agentPlan(input: AgentPlanInput): { text: string; structured: Record<string, unknown> } {
  const selectedAgent = input.agent?.trim() || "groundcrew-default";
  const title = coerceString(input.title, "Local agent task");
  const taskId = makeAgentTaskId(title);
  const risk = input.mode === "analysis" || input.mode === "review" ? "low" : "medium";
  const requiresApproval = risk !== "low";
  const createdAt = new Date().toISOString();
  const deadlineAt = isoAfter(createdAt, input.timeoutMs);
  const idleDeadlineAt = isoAfter(createdAt, input.idleTimeoutMs);
  const structured = {
    plan_id: `plan_${taskId}`,
    selected_agent: selectedAgent,
    repository: input.repository,
    task_id: taskId,
    title,
    mode: input.mode ?? "implementation",
    timeout_ms: input.timeoutMs,
    idle_timeout_ms: input.idleTimeoutMs,
    deadline_at: deadlineAt,
    idle_deadline_at: idleDeadlineAt,
    risk,
    requires_approval: requiresApproval,
    warnings: [
      "agent_plan is a dry run; it does not validate Groundcrew config or create a worktree.",
      "agent_start returns a durable job handle quickly, then provisions Groundcrew asynchronously.",
      "Watchdog enforcement only happens through agent_watchdog or agent_status with enforce_timeout=true."
    ]
  };
  const text = [
    "# Agent Plan",
    "",
    `Agent: ${selectedAgent}`,
    `Repository: ${input.repository}`,
    `Task id: ${taskId}`,
    `Mode: ${structured.mode}`,
    `Risk: ${risk}`,
    `Requires approval: ${requiresApproval}`,
    `Deadline: ${deadlineAt}`,
    `Idle deadline: ${idleDeadlineAt}`,
    "",
    textBlock("Plan", structured)
  ].join("\n");
  return { text, structured };
}

export async function agentStart(workspace: Workspace, input: AgentStartInput): Promise<{ text: string; structured: Record<string, unknown> }> {
  let defaultAgent: string | undefined;
  if (!input.agent?.trim()) {
    const runtime = await loadGroundcrewRuntime();
    const config = await runtime.loadConfig();
    defaultAgent = defaultAgentFromGroundcrewConfig(config);
  }
  const agent = input.agent?.trim() || defaultAgent;
  if (!agent) {
    throw new LeastError("No agent provided and Groundcrew config has no agents.default.");
  }

  const existing = await resolveExistingStart(workspace, input);
  if (existing) {
    let returned = existing;
    let recoveryRestarted = false;
    const recovery = await classifyAgentLaunchRecovery(workspace, existing);
    returned = recovery.job;
    if (recovery.classification === "recovery-required" && recovery.recoverySafe && (input.taskId || input.idempotencyKey)) {
      enqueueAgentLaunch(workspace, returned, { ...input, agent: returned.agent });
      recoveryRestarted = true;
      returned = await writeAgentJob(workspace, {
        ...returned,
        state: "provisioning",
        detail: undefined,
        launch: {
          ...(returned.launch ?? { phase: "accepted", acceptedAt: returned.createdAt }),
          phase: "provisioning",
          error: undefined
        }
      });
    } else if (isLaunchPending(returned)) {
      enqueueAgentLaunch(workspace, returned, { ...input, agent: returned.agent });
    }
    let startupWaitElapsed = false;
    if (input.waitForLaunch) {
      const wait = await waitForAgentLaunch(workspace, existing.jobId, normalizeAgentStartupWaitMs(input.startupWaitMs));
      returned = wait.job;
      startupWaitElapsed = !wait.settled;
    }
    const structured = {
      ...startResponseStructured(returned, { reused: true, startupWaitElapsed }),
      recovery_restarted: recoveryRestarted
    };
    const text = [
      "# Agent Start Accepted",
      "",
      `Job: ${returned.jobId}`,
      `Task: ${returned.taskId}`,
      `State: ${returned.state}`,
      `Launch phase: ${returned.launch?.phase ?? "unknown"}`,
      `Reused: true`,
      `Recovery restarted: ${recoveryRestarted}`,
      "",
      textBlock("Job", structured)
    ].join("\n");
    return { text, structured };
  }

  const taskId = planTaskId(input.title, input.taskId);
  let job = await createAgentJob({
    workspace,
    taskId,
    agent,
    repository: input.repository,
    title: input.title,
    prompt: input.prompt,
    timeoutMs: input.timeoutMs,
    idleTimeoutMs: input.idleTimeoutMs,
    idempotencyKey: input.idempotencyKey
  });

  enqueueAgentLaunch(workspace, job, input);

  let startupWaitElapsed = false;
  if (input.waitForLaunch) {
    const wait = await waitForAgentLaunch(workspace, job.jobId, normalizeAgentStartupWaitMs(input.startupWaitMs));
    job = wait.job;
    startupWaitElapsed = !wait.settled;
  }

  const structured = startResponseStructured(job, { reused: false, startupWaitElapsed });
  const text = [
    "# Agent Start Accepted",
    "",
    `Job: ${job.jobId}`,
    `Task: ${job.taskId}`,
    `State: ${job.state}`,
    `Launch phase: ${job.launch?.phase ?? "unknown"}`,
    `Agent: ${job.agent}`,
    `Repository: ${job.repository}`,
    `Deadline: ${job.watchdog?.deadlineAt ?? "unknown"}`,
    `Idle deadline: ${job.watchdog?.idleDeadlineAt ?? "unknown"}`,
    "",
    textBlock("Job", structured)
  ].join("\n");
  return { text, structured };
}

export async function agentStatus(workspace: Workspace, input: AgentStatusInput): Promise<{ text: string; structured: Record<string, unknown> }> {
  const job = await resolveAgentJob(workspace, input);
  let watchdog: AgentWatchdogResult;
  try {
    const runtime = await loadGroundcrewRuntime();
    const config = await runtime.loadConfig();
    watchdog = await evaluateAgentWatchdog({
      workspace,
      runtime,
      config,
      job,
      enforce: input.enforceTimeouts === true
    });
  } catch (error) {
    watchdog = {
      job,
      checked: false,
      timedOut: false,
      interrupted: false,
      warnings: [error instanceof Error ? error.message : String(error)]
    };
  }
  const recovery = await classifyAgentLaunchRecovery(workspace, watchdog.job);
  const combinedWarnings = [...watchdog.warnings, ...recovery.warnings];
  const terminalJob = recovery.classification
    ? recovery.job
    : shouldRefreshTerminalMetadata(watchdog.job)
      ? await refreshTerminalMetadataBestEffort(workspace, watchdog.job)
      : watchdog.job;
  const structured = {
    ...jobStructured(terminalJob, watchdog),
    recovery_status: recovery.classification,
    recovery_safe: recovery.recoverySafe,
    recovery_in_flight: recovery.inFlight
  };
  const text = ["# Agent Status", "", `Job: ${terminalJob.jobId}`, `Task: ${terminalJob.taskId}`, `State: ${terminalJob.state}`, `Launch phase: ${terminalJob.launch?.phase ?? "unknown"}`, `Agent: ${terminalJob.agent}`, `Repository: ${terminalJob.repository}`, `Deadline: ${terminalJob.watchdog?.deadlineAt ?? "unknown"}`, `Idle deadline: ${terminalJob.watchdog?.idleDeadlineAt ?? "unknown"}`, `Timed out: ${watchdog.timedOut}`, `Interrupted: ${watchdog.interrupted}`, recovery.classification ? `Recovery status: ${recovery.classification}` : undefined, combinedWarnings.length ? `Warnings: ${combinedWarnings.join("; ")}` : undefined, "", textBlock("Status", structured)].filter((part): part is string => typeof part === "string").join("\n");
  return { text, structured };
}

export async function agentWatchdog(workspace: Workspace, input: AgentStatusInput): Promise<{ text: string; structured: Record<string, unknown> }> {
  const job = await resolveAgentJob(workspace, input);
  let watchdog: AgentWatchdogResult;
  try {
    const runtime = await loadGroundcrewRuntime();
    const config = await runtime.loadConfig();
    watchdog = await evaluateAgentWatchdog({
      workspace,
      runtime,
      config,
      job,
      enforce: input.enforceTimeouts !== false
    });
  } catch (error) {
    watchdog = {
      job,
      checked: false,
      timedOut: false,
      interrupted: false,
      warnings: [error instanceof Error ? error.message : String(error)]
    };
  }
  const structured = jobStructured(watchdog.job, watchdog);
  const text = ["# Agent Watchdog", "", `Job: ${watchdog.job.jobId}`, `Task: ${watchdog.job.taskId}`, `State: ${watchdog.job.state}`, `Timed out: ${watchdog.timedOut}`, `Timeout reason: ${watchdog.timeoutReason ?? "none"}`, `Interrupted: ${watchdog.interrupted}`, watchdog.warnings.length ? `Warnings: ${watchdog.warnings.join("; ")}` : undefined, "", textBlock("Watchdog", structured)].filter((part): part is string => typeof part === "string").join("\n");
  return { text, structured };
}

export async function agentTail(workspace: Workspace, input: AgentStatusInput & { lines?: number }): Promise<{ text: string; structured: Record<string, unknown> }> {
  let job = await resolveAgentJob(workspace, input);
  if (shouldRefreshTerminalMetadata(job)) {
    job = await refreshTerminalMetadataBestEffort(workspace, job);
  }
  const tail = await tailAgentJob(workspace, job, { lines: input.lines });
  if (tail.text.trim().length > 0) {
    const outputHash = hashText(tail.text);
    if (outputHash !== job.watchdog?.lastOutputHash) {
      const now = new Date().toISOString();
      job = await writeAgentJob(workspace, {
        ...job,
        watchdog: {
          deadlineAt: job.watchdog?.deadlineAt ?? isoAfter(job.createdAt, job.timeoutMs),
          idleDeadlineAt: isoAfter(now, job.idleTimeoutMs),
          lastActivityAt: now,
          lastOutputAt: now,
          lastOutputHash: outputHash,
          lastRunStateHash: job.watchdog?.lastRunStateHash,
          lastCheckedAt: job.watchdog?.lastCheckedAt,
          timedOutAt: job.watchdog?.timedOutAt,
          timeoutReason: job.watchdog?.timeoutReason,
          interruptAttemptedAt: job.watchdog?.interruptAttemptedAt,
          interruptError: job.watchdog?.interruptError
        }
      });
    }
  }
  const text = [
    "# Agent Tail",
    "",
    `Job: ${job.jobId}`,
    `Task: ${job.taskId}`,
    `Source: ${tail.source}`,
    tail.target ? `Target: ${tail.target}` : undefined,
    tail.error ? `Warning: ${tail.error}` : undefined,
    "",
    "```text",
    tail.text || "(no output captured)",
    "```",
    "",
    textBlock("Tail", tail)
  ].filter((part): part is string => typeof part === "string").join("\n");
  return { text, structured: { ...tail, watchdog: job.watchdog } as unknown as Record<string, unknown> };
}

export async function agentResult(workspace: Workspace, input: AgentStatusInput & { includeDiff?: boolean; includeTail?: boolean; diffMaxChars?: number; tailLines?: number }): Promise<{ text: string; structured: Record<string, unknown> }> {
  let job = await resolveAgentJob(workspace, input);
  if (shouldRefreshTerminalMetadata(job)) {
    job = await refreshTerminalMetadataBestEffort(workspace, job);
  }
  const result = await summarizeAgentResult(workspace, job, {
    includeDiff: input.includeDiff,
    includeTail: input.includeTail,
    diffMaxChars: input.diffMaxChars,
    tailLines: input.tailLines
  });
  const text = [
    "# Agent Result",
    "",
    `Job: ${result.job_id}`,
    `Task: ${result.task_id}`,
    `State: ${result.state}`,
    `Conclusion: ${result.conclusion}`,
    `Agent: ${result.agent}`,
    `Repository: ${result.repository}`,
    result.worktree_dir ? `Worktree: ${result.worktree_dir}` : undefined,
    result.branch_name ? `Branch: ${result.branch_name}` : undefined,
    "",
    "## Changed Files",
    "",
    result.git.changed_files.length ? result.git.changed_files.map((file) => `- ${file}`).join("\n") : "(none)",
    "",
    "## Diff Stat",
    "",
    "```text",
    result.git.diff_stat || "(none)",
    "```",
    result.git.diff === undefined ? undefined : "",
    result.git.diff === undefined ? undefined : "## Diff",
    result.git.diff === undefined ? undefined : "",
    result.git.diff === undefined ? undefined : "```diff",
    result.git.diff === undefined ? undefined : result.git.diff || "(empty)",
    result.git.diff === undefined ? undefined : "```",
    "",
    textBlock("Result", result)
  ].filter((part): part is string => typeof part === "string").join("\n");
  return { text, structured: result as unknown as Record<string, unknown> };
}

export async function agentCancel(workspace: Workspace, input: AgentCancelInput): Promise<{ text: string; structured: Record<string, unknown> }> {
  const job = await resolveAgentJob(workspace, input);
  const runtime = await loadGroundcrewRuntime();
  const config = await runtime.loadConfig();
  await runtime.interruptWorkspace(config, {
    task: job.taskId,
    ...(input.reason === undefined ? {} : { reason: input.reason })
  });
  const refreshed = await refreshJobFromGroundcrew({ workspace, runtime, config, job });
  const structured = {
    ...jobStructured(refreshed),
    worktree_preserved: true,
    reason: input.reason
  };
  const text = ["# Agent Cancel", "", `Job: ${refreshed.jobId}`, `Task: ${refreshed.taskId}`, `State: ${refreshed.state}`, "Worktree preserved: true", "", textBlock("Cancel", structured)].join("\n");
  return { text, structured };
}

export async function agentTerminalDoctor(workspace?: Workspace): Promise<{ text: string; structured: Record<string, unknown> }> {
  const backends = await detectTerminalBackends(workspace);
  const structured = {
    platform: `${process.platform}/${process.arch}`,
    terminal_backends: backends
  };
  const text = [
    "# Agent Terminal Doctor",
    "",
    `Platform: ${process.platform}/${process.arch}`,
    "",
    backends.map((backend) => {
      const warnings = backend.warnings.length ? ` (${backend.warnings.join("; ")})` : "";
      return `- ${backend.available ? "OK" : "FAIL"} ${backend.backend}${backend.version ? ` - ${backend.version}` : ""}${backend.detail ? ` - ${backend.detail}` : ""}${warnings}`;
    }).join("\n"),
    "",
    textBlock("Terminal Backends", structured)
  ].join("\n");
  return { text, structured };
}

export async function agentSessions(workspace: Workspace): Promise<{ text: string; structured: Record<string, unknown> }> {
  const sessions = await listAgentTerminalSessions(workspace);
  const structured = { count: sessions.length, sessions };
  const text = [
    "# Agent Sessions",
    "",
    sessions.length
      ? sessions.map((session) => `- ${session.backend} ${session.sessionName ?? "(no session)"}${session.paneId ? ` pane=${session.paneId}` : ""}${session.title ? ` - ${session.title}` : ""}${session.cwd ? ` [${session.cwd}]` : ""}`).join("\n")
      : "(no sessions found)",
    "",
    textBlock("Sessions", structured)
  ].join("\n");
  return { text, structured };
}

export async function agentAttachHint(workspace: Workspace, input: AgentStatusInput): Promise<{ text: string; structured: Record<string, unknown> }> {
  const job = await resolveAgentJob(workspace, input);
  const canInferLiveTerminal = Boolean(job.groundcrew?.workspaceName || job.groundcrew?.worktreeDir);
  const enriched = canInferLiveTerminal && shouldRefreshTerminalMetadata(job) && job.terminal?.backend !== "logs"
    ? { ...job, terminal: await inferTerminalMetadata(workspace, job).catch(() => undefined) }
    : job;
  const hint = await attachHintForJob(workspace, enriched);
  const text = [
    "# Agent Attach Hint",
    "",
    `Job: ${hint.job_id}`,
    `Task: ${hint.task_id}`,
    `Backend: ${hint.backend}`,
    "",
    "## Attach",
    "",
    hint.attach_commands.length ? hint.attach_commands.map((command) => `- ${command}`).join("\n") : "(none)",
    "",
    "## Watch",
    "",
    hint.watch_commands.length ? hint.watch_commands.map((command) => `- ${command}`).join("\n") : "(none)",
    "",
    "## Tail",
    "",
    hint.tail_commands.length ? hint.tail_commands.map((command) => `- ${command}`).join("\n") : "(none)",
    "",
    "## Log fallback",
    "",
    hint.fallback_commands.map((command) => `- ${command}`).join("\n"),
    hint.warnings.length ? `\n## Warnings\n\n${hint.warnings.map((warning) => `- ${warning}`).join("\n")}` : "",
    "",
    textBlock("Attach Hint", hint)
  ].filter(Boolean).join("\n");
  return { text, structured: hint as unknown as Record<string, unknown> };
}

export function agentInputFromArgs(args: Record<string, unknown>, workspace: Workspace): AgentStartInput {
  return {
    workspaceId: workspace.id,
    workspaceRoot: workspace.root,
    agent: typeof args.agent === "string" ? args.agent : undefined,
    repository: coerceString(args.repository ?? args.repo, ""),
    title: coerceString(args.title, "Local agent task"),
    prompt: coerceString(args.prompt, ""),
    mode: typeof args.mode === "string" ? args.mode : undefined,
    taskId: typeof args.task_id === "string" ? args.task_id : undefined,
    idempotencyKey: typeof args.idempotency_key === "string" ? args.idempotency_key : undefined,
    waitForLaunch: args.wait_for_launch === true,
    startupWaitMs: normalizeAgentStartupWaitMs(args.startup_wait_ms),
    timeoutMs: normalizeAgentTimeoutMs(args.timeout_ms),
    idleTimeoutMs: normalizeAgentIdleTimeoutMs(args.idle_timeout_ms)
  };
}

export function validateStartInput(input: AgentStartInput): void {
  if (!input.repository) throw new LeastError("agent_start requires repository/repo.");
  if (!input.prompt) throw new LeastError("agent_start requires prompt.");
}
