import { createHash } from "node:crypto";
import type { AgentJobRecord, GroundcrewRuntime } from "./agentTypes.js";
import type { Workspace } from "./guard.js";
import { writeAgentJob } from "./agentJobStore.js";
import { refreshJobFromGroundcrew } from "./agentGroundcrewAdapter.js";

export interface AgentWatchdogResult {
  job: AgentJobRecord;
  checked: boolean;
  timedOut: boolean;
  timeoutReason?: "wall-clock" | "idle";
  interrupted: boolean;
  interruptError?: string;
  warnings: string[];
}

const ACTIVE_STATES = new Set<string>(["planned", "accepted", "provisioning", "running", "resumed", "unknown"]);
const FINAL_STATES = new Set<string>(["interrupted", "failed-to-launch", "timeout-soft", "timeout-hard", "cancelled", "missing", "recovery-required", "orphaned"]);

function nowIso(): string {
  return new Date().toISOString();
}

function isoAfter(baseIso: string, ms: number): string {
  return new Date(Date.parse(baseIso) + ms).toISOString();
}

function isExpired(deadline: string | undefined, nowMs: number): boolean {
  if (!deadline) return false;
  const deadlineMs = Date.parse(deadline);
  return Number.isFinite(deadlineMs) && nowMs >= deadlineMs;
}

function stableJsonHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
}

function normalizeWatchdog(job: AgentJobRecord): NonNullable<AgentJobRecord["watchdog"]> {
  const base = job.createdAt;
  const lastActivityAt = job.watchdog?.lastActivityAt ?? base;
  return {
    deadlineAt: job.watchdog?.deadlineAt ?? isoAfter(base, job.timeoutMs),
    idleDeadlineAt: job.watchdog?.idleDeadlineAt ?? isoAfter(lastActivityAt, job.idleTimeoutMs),
    lastActivityAt,
    lastOutputAt: job.watchdog?.lastOutputAt,
    lastOutputHash: job.watchdog?.lastOutputHash,
    lastRunStateHash: job.watchdog?.lastRunStateHash,
    lastCheckedAt: job.watchdog?.lastCheckedAt,
    timedOutAt: job.watchdog?.timedOutAt,
    timeoutReason: job.watchdog?.timeoutReason,
    interruptAttemptedAt: job.watchdog?.interruptAttemptedAt,
    interruptError: job.watchdog?.interruptError
  };
}

function timeoutReasonFor(job: AgentJobRecord, nowMs: number): "wall-clock" | "idle" | undefined {
  const watchdog = normalizeWatchdog(job);
  if (isExpired(watchdog.deadlineAt, nowMs)) return "wall-clock";
  if (isExpired(watchdog.idleDeadlineAt, nowMs)) return "idle";
  return undefined;
}

async function updateRunStateActivity(workspace: Workspace, job: AgentJobRecord, now: string): Promise<AgentJobRecord> {
  const watchdog = normalizeWatchdog(job);
  const runStateHash = stableJsonHash(job.groundcrew?.runState ?? null);
  const changed = runStateHash !== watchdog.lastRunStateHash;
  const nextActivityAt = changed ? now : watchdog.lastActivityAt;
  return await writeAgentJob(workspace, {
    ...job,
    watchdog: {
      ...watchdog,
      lastRunStateHash: runStateHash,
      lastActivityAt: nextActivityAt,
      idleDeadlineAt: changed ? isoAfter(nextActivityAt, job.idleTimeoutMs) : watchdog.idleDeadlineAt,
      lastCheckedAt: now
    }
  });
}

export async function evaluateAgentWatchdog(input: {
  workspace: Workspace;
  runtime: GroundcrewRuntime;
  config: Record<string, unknown>;
  job: AgentJobRecord;
  enforce: boolean;
}): Promise<AgentWatchdogResult> {
  const warnings: string[] = [];
  let refreshed = await refreshJobFromGroundcrew({
    workspace: input.workspace,
    runtime: input.runtime,
    config: input.config,
    job: input.job
  });

  const now = nowIso();
  const nowMs = Date.parse(now);
  refreshed = await updateRunStateActivity(input.workspace, refreshed, now);

  if (FINAL_STATES.has(refreshed.state)) {
    return { job: refreshed, checked: true, timedOut: false, interrupted: false, warnings };
  }
  if (!ACTIVE_STATES.has(refreshed.state)) {
    warnings.push(`State ${refreshed.state} is not recognized as active; watchdog did not enforce timeouts.`);
    return { job: refreshed, checked: true, timedOut: false, interrupted: false, warnings };
  }

  const reason = timeoutReasonFor(refreshed, nowMs);
  if (!reason) {
    return { job: refreshed, checked: true, timedOut: false, interrupted: false, warnings };
  }
  if (!input.enforce) {
    warnings.push(`Timeout detected (${reason}) but enforcement was disabled.`);
    return { job: refreshed, checked: true, timedOut: true, timeoutReason: reason, interrupted: false, warnings };
  }

  const attemptedAt = nowIso();
  try {
    await input.runtime.interruptWorkspace(input.config, {
      task: refreshed.taskId,
      reason: `least watchdog ${reason} timeout`
    });
    refreshed = await writeAgentJob(input.workspace, {
      ...refreshed,
      state: "timeout-soft",
      detail: `Least watchdog interrupted job after ${reason} timeout.`,
      watchdog: {
        ...normalizeWatchdog(refreshed),
        lastCheckedAt: attemptedAt,
        timedOutAt: attemptedAt,
        timeoutReason: reason,
        interruptAttemptedAt: attemptedAt,
        interruptError: undefined
      }
    });
    return { job: refreshed, checked: true, timedOut: true, timeoutReason: reason, interrupted: true, warnings };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    refreshed = await writeAgentJob(input.workspace, {
      ...refreshed,
      state: "timeout-hard",
      detail: `Least watchdog attempted interrupt after ${reason} timeout but Groundcrew returned an error: ${message}`,
      watchdog: {
        ...normalizeWatchdog(refreshed),
        lastCheckedAt: attemptedAt,
        timedOutAt: attemptedAt,
        timeoutReason: reason,
        interruptAttemptedAt: attemptedAt,
        interruptError: message
      }
    });
    return { job: refreshed, checked: true, timedOut: true, timeoutReason: reason, interrupted: false, interruptError: message, warnings };
  }
}
