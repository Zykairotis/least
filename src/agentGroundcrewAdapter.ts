import { createHash } from "node:crypto";
import type { AgentJobRecord, AgentLifecycleState, GroundcrewRuntime } from "./agentTypes.js";
import type { Workspace } from "./guard.js";
import { LeastError } from "./guard.js";
import { writeAgentJob } from "./agentJobStore.js";

async function dynamicImport(specifier: string): Promise<unknown> {
  const importer = new Function("specifier", "return import(specifier)") as (value: string) => Promise<unknown>;
  return await importer(specifier);
}

function assertGroundcrewRuntime(value: unknown): GroundcrewRuntime {
  const runtime = value as Partial<GroundcrewRuntime> | undefined;
  if (
    runtime === undefined ||
    typeof runtime.loadConfig !== "function" ||
    typeof runtime.setupWorkspace !== "function" ||
    typeof runtime.interruptWorkspace !== "function" ||
    typeof runtime.readRunState !== "function"
  ) {
    throw new LeastError("@clipboard-health/groundcrew is installed but does not expose the expected orchestration API.");
  }
  return runtime as GroundcrewRuntime;
}

export async function loadGroundcrewRuntime(): Promise<GroundcrewRuntime> {
  try {
    return assertGroundcrewRuntime(await dynamicImport("@clipboard-health/groundcrew"));
  } catch (error) {
    if (error instanceof LeastError) throw error;
    throw new LeastError(
      "Groundcrew is not available. Install @clipboard-health/groundcrew and configure crew.config.ts before using agent_start."
    );
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function isoAfter(baseIso: string, ms: number): string {
  return new Date(new Date(baseIso).getTime() + ms).toISOString();
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
}

function readString(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const item = value?.[key];
  return typeof item === "string" && item.length > 0 ? item : undefined;
}

export function agentDefinitionsFromGroundcrewConfig(config: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const agents = config.agents;
  if (!agents || typeof agents !== "object") return {};
  const definitions = (agents as Record<string, unknown>).definitions;
  if (!definitions || typeof definitions !== "object") return {};
  return definitions as Record<string, Record<string, unknown>>;
}

export function defaultAgentFromGroundcrewConfig(config: Record<string, unknown>): string | undefined {
  const agents = config.agents;
  if (!agents || typeof agents !== "object") return undefined;
  return readString(agents as Record<string, unknown>, "default");
}

export function runStateFromGroundcrew(runtime: GroundcrewRuntime, config: Record<string, unknown>, taskId: string): Record<string, unknown> | undefined {
  return runtime.readRunState(config, taskId);
}

function lifecycleStateFromGroundcrew(state: string | undefined, fallback: AgentLifecycleState): AgentLifecycleState {
  if (
    state === "provisioning" ||
    state === "running" ||
    state === "completed" ||
    state === "resumed" ||
    state === "interrupted" ||
    state === "failed-to-launch" ||
    state === "timeout-soft" ||
    state === "timeout-hard" ||
    state === "cancelled"
  ) {
    return state;
  }
  return fallback;
}

function launchPhaseForState(state: AgentLifecycleState): NonNullable<AgentJobRecord["launch"]>["phase"] | undefined {
  if (state === "completed") return "completed";
  if (state === "running" || state === "resumed") return "running";
  if (
    state === "failed-to-launch" ||
    state === "interrupted" ||
    state === "timeout-soft" ||
    state === "timeout-hard" ||
    state === "cancelled" ||
    state === "missing"
  ) {
    return "failed";
  }
  if (state === "accepted" || state === "provisioning") return "provisioning";
  return undefined;
}

export function mergeRunStateIntoJob(job: AgentJobRecord, runState: Record<string, unknown> | undefined): AgentJobRecord {
  if (!runState) return job;
  const state = readString(runState, "state");
  const worktreeDir = readString(runState, "worktreeDir");
  const branchName = readString(runState, "branchName");
  const workspaceName = readString(runState, "workspaceName");
  const agent = readString(runState, "agent") ?? job.agent;
  const repository = readString(runState, "repository") ?? job.repository;
  const runStateHash = stableHash(runState);
  const previousHash = job.watchdog?.lastRunStateHash;
  const lastActivityAt = previousHash === runStateHash ? job.watchdog?.lastActivityAt : nowIso();
  const nextState = lifecycleStateFromGroundcrew(state, job.state);
  const launchPhase = launchPhaseForState(nextState);
  return {
    ...job,
    agent,
    repository,
    state: nextState,
    ...(launchPhase
      ? {
          launch: {
            ...(job.launch ?? { phase: launchPhase, acceptedAt: job.createdAt }),
            phase: launchPhase,
            ...(launchPhase === "completed" || launchPhase === "running" ? { error: undefined } : {})
          }
        }
      : {}),
    watchdog: {
      deadlineAt: job.watchdog?.deadlineAt ?? isoAfter(job.createdAt, job.timeoutMs),
      idleDeadlineAt: isoAfter(lastActivityAt ?? job.createdAt, job.idleTimeoutMs),
      lastActivityAt: lastActivityAt ?? job.createdAt,
      lastOutputAt: job.watchdog?.lastOutputAt,
      lastOutputHash: job.watchdog?.lastOutputHash,
      lastRunStateHash: runStateHash,
      lastCheckedAt: job.watchdog?.lastCheckedAt,
      timedOutAt: job.watchdog?.timedOutAt,
      timeoutReason: job.watchdog?.timeoutReason,
      interruptAttemptedAt: job.watchdog?.interruptAttemptedAt,
      interruptError: job.watchdog?.interruptError
    },
    groundcrew: {
      ...job.groundcrew,
      ...(worktreeDir === undefined ? {} : { worktreeDir }),
      ...(branchName === undefined ? {} : { branchName }),
      ...(workspaceName === undefined ? {} : { workspaceName }),
      runState
    }
  };
}

export async function refreshJobFromGroundcrew(input: {
  workspace: Workspace;
  runtime: GroundcrewRuntime;
  config: Record<string, unknown>;
  job: AgentJobRecord;
}): Promise<AgentJobRecord> {
  const runState = runStateFromGroundcrew(input.runtime, input.config, input.job.taskId);
  const merged = mergeRunStateIntoJob(input.job, runState);
  return await writeAgentJob(input.workspace, merged);
}
