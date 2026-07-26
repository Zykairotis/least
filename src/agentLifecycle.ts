import fsp from "node:fs/promises";
import path from "node:path";
import type { AgentCleanupInput, AgentJobRecord, AgentLifecycleState, AgentResumeInput } from "./agentTypes.js";
import type { Workspace } from "./guard.js";
import { LeastError } from "./guard.js";
import {
  agentRunsDir,
  listAgentRunEntries,
  removeAgentJob,
  resolveAgentJob,
  writeAgentJob
} from "./agentJobStore.js";
import { loadGroundcrewRuntime, refreshJobFromGroundcrew } from "./agentGroundcrewAdapter.js";
import { attachHintForJob, inferTerminalMetadata } from "./agentTerminalBackend.js";
import { loadEffectiveLocalAgentConfig } from "./agentConfig.js";
import { restartAgentDeckSession } from "./agentDeck.js";

const ACTIVE_AGENT_STATES = new Set<AgentLifecycleState>(["accepted", "provisioning", "running", "resumed"]);

function textBlock(title: string, value: unknown): string {
  return `## ${title}\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

export function isActiveAgentJobState(state: AgentLifecycleState): boolean {
  return ACTIVE_AGENT_STATES.has(state);
}

export function parseOlderThanMs(value: string): number {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new LeastError("older_than must be a non-empty ISO timestamp or relative duration like 7d, 24h, 30m.");
  }
  const asDate = Date.parse(trimmed);
  if (Number.isFinite(asDate)) return asDate;
  const match = /^(\d+)([smhdw])$/i.exec(trimmed);
  if (!match) {
    throw new LeastError(`Invalid older_than value: ${value}. Use an ISO timestamp or relative duration like 7d, 24h, 30m.`);
  }
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multipliers: Record<string, number> = {
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 7 * 86_400_000
  };
  return Date.now() - amount * multipliers[unit]!;
}

function jobStructured(job: AgentJobRecord): Record<string, unknown> {
  return {
    job_id: job.jobId,
    task_id: job.taskId,
    state: job.state,
    agent: job.agent,
    repository: job.repository,
    idempotency_key: job.idempotencyKey,
    request_hash: job.requestHash,
    launch: job.launch,
    launch_phase: job.launch?.phase,
    launch_error: job.launch?.error,
    worktree_dir: job.groundcrew?.worktreeDir,
    branch_name: job.groundcrew?.branchName,
    workspace_name: job.groundcrew?.workspaceName,
    timeout_ms: job.timeoutMs,
    idle_timeout_ms: job.idleTimeoutMs,
    deadline_at: job.watchdog?.deadlineAt,
    idle_deadline_at: job.watchdog?.idleDeadlineAt,
    last_activity_at: job.watchdog?.lastActivityAt,
    terminal: job.terminal,
    agent_deck: job.agentDeck,
    groundcrew_state: job.groundcrew?.runState
  };
}

async function refreshTerminalMetadataBestEffort(workspace: Workspace, job: AgentJobRecord): Promise<AgentJobRecord> {
  try {
    const terminal = await inferTerminalMetadata(workspace, job);
    return await writeAgentJob(workspace, { ...job, terminal });
  } catch (error) {
    return await writeAgentJob(workspace, {
      ...job,
      terminal: {
        backend: job.terminal?.backend ?? "none",
        ...job.terminal,
        inferred: true,
        warnings: [error instanceof Error ? error.message : String(error)]
      }
    });
  }
}

function assertResumeAvailable(runtime: Awaited<ReturnType<typeof loadGroundcrewRuntime>>): void {
  if (typeof runtime.resumeWorkspace !== "function") {
    throw new LeastError(
      "Groundcrew resumeWorkspace is not available. Upgrade @clipboard-health/groundcrew to a version that exports resumeWorkspace."
    );
  }
}

function assertCleanupAvailable(runtime: Awaited<ReturnType<typeof loadGroundcrewRuntime>>): void {
  if (typeof runtime.cleanupWorkspace !== "function") {
    throw new LeastError(
      "Groundcrew cleanupWorkspace is not available. Upgrade @clipboard-health/groundcrew to a version that exports cleanupWorkspace."
    );
  }
}

interface CleanupCandidate {
  jobId: string;
  taskId?: string;
  state?: AgentLifecycleState;
  updatedAt?: string;
  worktreeDir?: string;
  orphan: boolean;
  dirName: string;
  reason: string;
}

async function orphanDirUpdatedAt(workspace: Pick<Workspace, "root">, dirName: string): Promise<string | undefined> {
  try {
    const stat = await fsp.stat(path.join(agentRunsDir(workspace), dirName));
    return stat.mtime.toISOString();
  } catch {
    return undefined;
  }
}

async function buildCleanupCandidates(workspace: Workspace, input: AgentCleanupInput): Promise<CleanupCandidate[]> {
  const olderThanMs = input.olderThan ? parseOlderThanMs(input.olderThan) : undefined;
  const candidates: CleanupCandidate[] = [];

  if (input.jobId || input.taskId) {
    const job = await resolveAgentJob(workspace, input);
    if (isActiveAgentJobState(job.state)) {
      throw new LeastError(`Refusing cleanup for active job ${job.jobId} (state=${job.state}).`);
    }
    if (olderThanMs !== undefined && Date.parse(job.updatedAt) > olderThanMs) {
      return [];
    }
    candidates.push({
      jobId: job.jobId,
      taskId: job.taskId,
      state: job.state,
      updatedAt: job.updatedAt,
      worktreeDir: job.groundcrew?.worktreeDir,
      orphan: false,
      dirName: job.jobId,
      reason: `matched job_id/task_id (${job.state})`
    });
    return candidates;
  }

  const entries = await listAgentRunEntries(workspace);
  for (const entry of entries) {
    if (entry.orphan) {
      const updatedAt = await orphanDirUpdatedAt(workspace, entry.dirName);
      if (olderThanMs !== undefined && updatedAt !== undefined && Date.parse(updatedAt) > olderThanMs) continue;
      candidates.push({
        jobId: entry.dirName,
        updatedAt,
        orphan: true,
        dirName: entry.dirName,
        reason: "orphan agent-runs directory without status.json"
      });
      continue;
    }
    const job = entry.job!;
    if (isActiveAgentJobState(job.state)) continue;
    if (olderThanMs !== undefined && Date.parse(job.updatedAt) > olderThanMs) continue;
    candidates.push({
      jobId: job.jobId,
      taskId: job.taskId,
      state: job.state,
      updatedAt: job.updatedAt,
      worktreeDir: job.groundcrew?.worktreeDir,
      orphan: false,
      dirName: entry.dirName,
      reason: `stale job state (${job.state})`
    });
  }
  return candidates;
}

export async function agentResume(workspace: Workspace, input: AgentResumeInput): Promise<{ text: string; structured: Record<string, unknown> }> {
  const job = await resolveAgentJob(workspace, input);
  if (isActiveAgentJobState(job.state)) {
    throw new LeastError(`Refusing resume for active job ${job.jobId} (state=${job.state}). Cancel or wait for completion first.`);
  }
  let refreshed: AgentJobRecord;
  if (job.agentDeck?.sessionId) {
    const local = await loadEffectiveLocalAgentConfig(workspace);
    refreshed = await restartAgentDeckSession(workspace, job, local.config.sessionManager);
  } else {
    const runtime = await loadGroundcrewRuntime();
    assertResumeAvailable(runtime);
    const config = await runtime.loadConfig();
    await runtime.resumeWorkspace!(config, {
      task: job.taskId,
      ...(input.fresh === true ? { fresh: true } : {})
    });
    refreshed = await refreshJobFromGroundcrew({ workspace, runtime, config, job });
    refreshed = await refreshTerminalMetadataBestEffort(workspace, refreshed);
  }
  const attach = await attachHintForJob(workspace, refreshed);
  const structured = {
    ...jobStructured(refreshed),
    fresh: input.fresh === true,
    attach_hint: attach,
    attach_commands: attach.attach_commands,
    watch_commands: attach.watch_commands,
    tail_commands: attach.tail_commands,
    fallback_commands: attach.fallback_commands
  };
  const text = [
    "# Agent Resume",
    "",
    `Job: ${refreshed.jobId}`,
    `Task: ${refreshed.taskId}`,
    `State: ${refreshed.state}`,
    `Launch phase: ${refreshed.launch?.phase ?? "unknown"}`,
    `Agent: ${refreshed.agent}`,
    `Repository: ${refreshed.repository}`,
    refreshed.groundcrew?.worktreeDir ? `Worktree: ${refreshed.groundcrew.worktreeDir}` : undefined,
    "",
    "## Attach",
    "",
    attach.attach_commands.length ? attach.attach_commands.map((command) => `- ${command}`).join("\n") : "(none)",
    "",
    textBlock("Resume", structured)
  ].filter((part): part is string => typeof part === "string").join("\n");
  return { text, structured };
}

export async function agentCleanup(workspace: Workspace, input: AgentCleanupInput): Promise<{ text: string; structured: Record<string, unknown> }> {
  const dryRun = input.dryRun !== false;
  const cleanWorktrees = input.cleanWorktrees === true;
  const force = input.force === true;

  if (!dryRun && !input.jobId && !input.taskId && !input.olderThan) {
    throw new LeastError("agent_cleanup with dry_run=false requires job_id, task_id, or older_than.");
  }

  const candidates = await buildCleanupCandidates(workspace, input);
  const removedJobDirs: string[] = [];
  const removedWorktrees: string[] = [];
  const failures: string[] = [];
  const preservedWorktrees: string[] = [];

  let runtime: Awaited<ReturnType<typeof loadGroundcrewRuntime>> | undefined;
  let config: Record<string, unknown> | undefined;
  if (!dryRun && cleanWorktrees) {
    runtime = await loadGroundcrewRuntime();
    assertCleanupAvailable(runtime);
    config = await runtime.loadConfig();
  }

  for (const candidate of candidates) {
    if (dryRun) {
      removedJobDirs.push(candidate.jobId);
      if (cleanWorktrees && candidate.worktreeDir) {
        removedWorktrees.push(candidate.worktreeDir);
      } else if (candidate.worktreeDir) {
        preservedWorktrees.push(candidate.worktreeDir);
      }
      continue;
    }

    if (cleanWorktrees && candidate.taskId) {
      try {
        await runtime!.cleanupWorkspace!(config!, {
          task: candidate.taskId,
          ...(force ? { force: true } : {})
        });
        if (candidate.worktreeDir) removedWorktrees.push(candidate.worktreeDir);
      } catch (error) {
        failures.push(`${candidate.taskId}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
    } else if (candidate.worktreeDir) {
      preservedWorktrees.push(candidate.worktreeDir);
    }

    try {
      await removeAgentJob(workspace, candidate.jobId);
      removedJobDirs.push(candidate.jobId);
    } catch (error) {
      failures.push(`${candidate.jobId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const structured = {
    dry_run: dryRun,
    clean_worktrees: cleanWorktrees,
    force,
    worktrees_preserved_by_default: !cleanWorktrees,
    candidate_count: candidates.length,
    removed_job_dirs: removedJobDirs,
    removed_worktrees: removedWorktrees,
    preserved_worktrees: preservedWorktrees,
    failures,
    candidates: candidates.map((candidate) => ({
      job_id: candidate.jobId,
      task_id: candidate.taskId,
      state: candidate.state,
      updated_at: candidate.updatedAt,
      worktree_dir: candidate.worktreeDir,
      orphan: candidate.orphan,
      reason: candidate.reason
    }))
  };

  const text = [
    "# Agent Cleanup",
    "",
    `Dry run: ${dryRun}`,
    `Clean worktrees: ${cleanWorktrees}`,
    `Force: ${force}`,
    `Candidates: ${candidates.length}`,
    `Removed job dirs: ${removedJobDirs.length}`,
    `Removed worktrees: ${removedWorktrees.length}`,
    `Preserved worktrees: ${preservedWorktrees.length}`,
    failures.length ? `Failures: ${failures.length}` : undefined,
    "",
    textBlock("Cleanup", structured)
  ].filter((part): part is string => typeof part === "string").join("\n");

  return { text, structured };
}
