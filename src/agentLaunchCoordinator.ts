import { readFile } from "node:fs/promises";
import type { AgentJobRecord, AgentLaunchPhase, AgentStartInput } from "./agentTypes.js";
import type { Workspace } from "./guard.js";
import { LeastError } from "./guard.js";
import { findLocalAgentProfile, loadEffectiveLocalAgentConfig, usesAgentDeck, validateLocalAgentLaunch } from "./agentConfig.js";
import { refreshAgentDeckJob, startAgentDeckLaunch } from "./agentDeck.js";
import {
  defaultAgentFromGroundcrewConfig,
  loadGroundcrewRuntime,
  refreshJobFromGroundcrew
} from "./agentGroundcrewAdapter.js";
import { refreshDirectAgentJobFromArtifacts, startDirectAgentLaunch } from "./agentDirectLaunch.js";
import { readAgentJob, writeAgentJob } from "./agentJobStore.js";
import { listAgentJobs } from "./agentJobStore.js";
import { dependenciesSatisfied } from "./agentDag.js";
import { waitForAgentArtifacts } from "./agentTerminalLogs.js";
import { inferTerminalMetadata } from "./agentTerminalBackend.js";
import { refreshGroundcrewPathForLaunch } from "./agentTerminalExec.js";

const launches = new Map<string, Promise<void>>();

export interface AgentLaunchRecoveryResult {
  job: AgentJobRecord;
  inFlight: boolean;
  classification?: "running" | "completed" | "failed" | "recovery-required" | "orphaned";
  recoverySafe: boolean;
  warnings: string[];
}

function uniqueWarnings(items: Array<string | undefined>): string[] {
  return [...new Set(items.filter((item): item is string => typeof item === "string" && item.trim().length > 0))];
}

function nowIso(): string {
  return new Date().toISOString();
}

function isFailureState(state: AgentJobRecord["state"]): boolean {
  return (
    state === "failed-to-launch" ||
    state === "timeout-soft" ||
    state === "timeout-hard" ||
    state === "cancelled" ||
    state === "interrupted" ||
    state === "missing"
  );
}

function phaseForJob(job: AgentJobRecord): AgentLaunchPhase {
  if (job.state === "completed") return "completed";
  if (job.state === "running" || job.state === "resumed") return "running";
  if (isFailureState(job.state)) return "failed";
  return "provisioning";
}

function isLaunchSettled(job: AgentJobRecord): boolean {
  return job.launch?.phase === "running" || job.launch?.phase === "completed" || job.launch?.phase === "failed";
}

function isPendingLaunchPhase(phase: AgentLaunchPhase | undefined): boolean {
  return (
    phase === "accepted" ||
    phase === "provisioning" ||
    phase === "groundcrew-setup" ||
    phase === "terminal-detected"
  );
}

function missingArtifactDetailMessage(root: string, checked: readonly string[], elapsedMs: number): string {
  return `Completed terminal exited successfully, but no result artifacts appeared in ${elapsedMs}ms at ${root}. Expected one of: ${checked.join(", ")}.`;
}

function knownRepositoriesFromConfig(config: Record<string, unknown>): string[] {
  const workspaceConfig = config.workspace;
  if (!workspaceConfig || typeof workspaceConfig !== "object" || Array.isArray(workspaceConfig)) return [];
  const knownRepositories = (workspaceConfig as Record<string, unknown>).knownRepositories;
  return Array.isArray(knownRepositories)
    ? knownRepositories.filter((item): item is string => typeof item === "string")
    : [];
}

async function readPromptText(job: AgentJobRecord): Promise<string> {
  try {
    return await readFile(job.promptFile, "utf8");
  } catch {
    return "";
  }
}

async function writeLaunchUpdate(
  workspace: Workspace,
  job: AgentJobRecord,
  update: Partial<AgentJobRecord> & { launch?: Partial<NonNullable<AgentJobRecord["launch"]>> }
): Promise<AgentJobRecord> {
  return await writeAgentJob(workspace, {
    ...job,
    ...update,
    launch: update.launch === undefined
      ? job.launch
      : {
          ...(job.launch ?? { phase: "accepted", acceptedAt: job.createdAt }),
          ...update.launch
        }
  });
}

async function refreshTerminalMetadataBestEffort(workspace: Workspace, job: AgentJobRecord): Promise<AgentJobRecord> {
  try {
    const terminal = await inferTerminalMetadata(workspace, job);
    const exitedSuccessfully =
      terminal.backend === "zellij" &&
      terminal.exited === true &&
      terminal.exitStatus === 0;
    const wasActive =
      job.state === "accepted" ||
      job.state === "running" ||
      job.state === "provisioning" ||
      job.state === "resumed";
    let nextState = job.state;
    let detail = job.detail;
    let launchPhase = phaseForJob(job);
    const terminalWarnings = [...(terminal.warnings ?? [])];

    if (exitedSuccessfully && wasActive) {
      const artifacts = await waitForAgentArtifacts(workspace, job, { timeoutMs: 5_000, intervalMs: 250 });
      nextState = "completed";
      launchPhase = "completed";
      if (!artifacts.found) {
        detail = missingArtifactDetailMessage(artifacts.root, artifacts.checked_files, artifacts.elapsed_ms);
        terminalWarnings.push(detail);
      } else if (detail?.startsWith("Completed terminal exited successfully,")) {
        detail = undefined;
      }
    } else if (terminal.backend !== "none") {
      launchPhase = phaseForJob({ ...job, state: nextState });
    }

    return await writeLaunchUpdate(workspace, job, {
      state: nextState,
      detail,
      terminal: {
        ...terminal,
        ...(terminalWarnings.length ? { warnings: uniqueWarnings(terminalWarnings) } : {})
      },
      launch: {
        phase: launchPhase === "provisioning" ? "terminal-detected" : launchPhase,
        ...(nextState === "completed" ? { setupFinishedAt: job.launch?.setupFinishedAt ?? nowIso() } : {}),
        ...(nextState === "completed" ? { error: undefined } : {})
      }
    });
  } catch (error) {
    return await writeLaunchUpdate(workspace, job, {
      terminal: {
        backend: job.terminal?.backend ?? "none",
        ...job.terminal,
        inferred: true,
        warnings: uniqueWarnings([...(job.terminal?.warnings ?? []), error instanceof Error ? error.message : String(error)])
      }
    });
  }
}

async function runAgentLaunch(workspace: Workspace, seedJob: AgentJobRecord, input: AgentStartInput): Promise<void> {
  let job = await readAgentJob(workspace, seedJob.jobId).catch(() => seedJob);
  try {
    if (!dependenciesSatisfied(job, await listAgentJobs(workspace))) {
      await writeLaunchUpdate(workspace, job, {
        state: "planned",
        detail: `Waiting for dependencies: ${(job.dependsOn ?? []).join(", ")}`,
        launch: { phase: "accepted", error: undefined }
      });
      return;
    }
    job = await writeLaunchUpdate(workspace, job, {
      state: job.state === "completed" ? job.state : "provisioning",
      detail: undefined,
      launch: {
        phase: "provisioning",
        startedAt: job.launch?.startedAt ?? nowIso(),
        error: undefined
      }
    });

    refreshGroundcrewPathForLaunch();
    const runtime = await loadGroundcrewRuntime();
    const config = await runtime.loadConfig();
    const resolvedAgent = job.agent?.trim() || defaultAgentFromGroundcrewConfig(config);
    if (!resolvedAgent) {
      throw new LeastError("No agent provided and Groundcrew config has no agents.default.");
    }
    if (resolvedAgent !== job.agent) {
      job = await writeLaunchUpdate(workspace, job, { agent: resolvedAgent });
    }

    const localConfig = await loadEffectiveLocalAgentConfig(workspace);
    const localProfile = findLocalAgentProfile(localConfig.config, resolvedAgent);
    const launchWarnings = validateLocalAgentLaunch(localConfig.config, resolvedAgent);
    if (launchWarnings.length) {
      throw new LeastError(`Local agent profile validation failed for ${resolvedAgent}: ${launchWarnings.join(" ")}`);
    }
    if (usesAgentDeck(localConfig.config)) {
      if (!localProfile) {
        throw new LeastError(`Agent Deck launch requires a local profile for agent "${resolvedAgent}".`);
      }
      await startAgentDeckLaunch({
        workspace,
        job,
        profile: localProfile,
        sessionManager: localConfig.config.sessionManager!,
        startInput: {
          ...input,
          prompt: input.prompt || await readPromptText(job)
        }
      });
      return;
    }

    const knownRepositories = knownRepositoriesFromConfig(config);
    const useDirectFolderLaunch = !knownRepositories.includes(job.repository);
    if (useDirectFolderLaunch) {
      if (!localProfile) {
        throw new LeastError(`Repository "${job.repository}" is not in Groundcrew knownRepositories and agent "${resolvedAgent}" has no local direct-launch profile.`);
      }
      await startDirectAgentLaunch({ workspace, job, profile: localProfile, startInput: input });
      return;
    }

    job = await writeLaunchUpdate(workspace, job, {
      launch: {
        phase: "groundcrew-setup",
        setupStartedAt: job.launch?.setupStartedAt ?? nowIso()
      }
    });

    await runtime.setupWorkspace(config, {
      task: job.taskId,
      completionTaskId: `least:${job.taskId}`,
      completionMarkDoneSupported: false,
      repository: job.repository,
      agent: resolvedAgent,
      details: {
        title: job.title,
        description: input.prompt || await readPromptText(job)
      }
    });

    job = await refreshJobFromGroundcrew({ workspace, runtime, config, job });
    job = await writeLaunchUpdate(workspace, job, {
      launch: {
        phase: phaseForJob(job),
        setupFinishedAt: nowIso(),
        error: undefined
      },
      detail: undefined
    });
    job = await refreshTerminalMetadataBestEffort(workspace, job);

    if (localProfile) {
      job = await writeLaunchUpdate(workspace, job, {
        detail: job.detail,
        launch: { phase: phaseForJob(job) }
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeLaunchUpdate(workspace, job, {
      state: "failed-to-launch",
      detail: message,
      launch: {
        phase: "failed",
        setupFinishedAt: nowIso(),
        error: message
      }
    });
  }
}

export function getInFlightLaunch(jobId: string): Promise<void> | undefined {
  return launches.get(jobId);
}

export function enqueueAgentLaunch(workspace: Workspace, job: AgentJobRecord, input: AgentStartInput): Promise<void> {
  const existing = launches.get(job.jobId);
  if (existing) return existing;
  const promise = runAgentLaunch(workspace, job, input).finally(() => {
    launches.delete(job.jobId);
  });
  launches.set(job.jobId, promise);
  return promise;
}

export async function waitForAgentLaunch(workspace: Workspace, jobId: string, timeoutMs: number): Promise<{ job: AgentJobRecord; settled: boolean }> {
  let job = await readAgentJob(workspace, jobId);
  if (timeoutMs <= 0 || isLaunchSettled(job)) {
    return { job, settled: isLaunchSettled(job) };
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    job = await readAgentJob(workspace, jobId);
    if (isLaunchSettled(job)) return { job, settled: true };
  }
  return { job, settled: isLaunchSettled(job) };
}

export async function classifyAgentLaunchRecovery(workspace: Workspace, seedJob: AgentJobRecord): Promise<AgentLaunchRecoveryResult> {
  let job = await readAgentJob(workspace, seedJob.jobId).catch(() => seedJob);
  const warnings: string[] = [];
  const inFlight = launches.has(job.jobId);
  const currentPhase = job.launch?.phase ?? phaseForJob(job);

  if (inFlight) {
    return { job, inFlight, classification: undefined, recoverySafe: false, warnings };
  }
  if (job.agentDeck?.sessionId) {
    const localConfig = await loadEffectiveLocalAgentConfig(workspace);
    job = await refreshAgentDeckJob(workspace, job, localConfig.config.sessionManager);
    if (job.state === "running" || job.state === "resumed") {
      return { job, inFlight, classification: "running", recoverySafe: false, warnings };
    }
    if (job.state === "completed") {
      return { job, inFlight, classification: "completed", recoverySafe: false, warnings };
    }
    if (isFailureState(job.state) || job.state === "orphaned") {
      return { job, inFlight, classification: "failed", recoverySafe: false, warnings };
    }
  }
  if (currentPhase === "recovery-required") {
    return { job, inFlight, classification: "recovery-required", recoverySafe: true, warnings };
  }
  if (currentPhase === "orphaned") {
    return { job, inFlight, classification: "orphaned", recoverySafe: false, warnings };
  }
  if (!isPendingLaunchPhase(currentPhase)) {
    job = await refreshDirectAgentJobFromArtifacts(workspace, job);
    if (job.state === "completed") {
      return { job, inFlight, classification: "completed", recoverySafe: false, warnings };
    }
    if (isFailureState(job.state)) {
      return { job, inFlight, classification: "failed", recoverySafe: false, warnings };
    }
    return { job, inFlight, classification: undefined, recoverySafe: false, warnings };
  }

  try {
    const runtime = await loadGroundcrewRuntime();
    const config = await runtime.loadConfig();
    job = await refreshJobFromGroundcrew({ workspace, runtime, config, job });
    if (phaseForJob(job) === "running") {
      job = await writeLaunchUpdate(workspace, job, {
        state: job.state === "resumed" ? "running" : job.state,
        launch: { phase: "running", error: undefined }
      });
      return { job, inFlight, classification: "running", recoverySafe: false, warnings };
    }
    if (phaseForJob(job) === "completed") {
      job = await writeLaunchUpdate(workspace, job, {
        state: "completed",
        launch: { phase: "completed", error: undefined, setupFinishedAt: job.launch?.setupFinishedAt ?? nowIso() }
      });
      return { job, inFlight, classification: "completed", recoverySafe: false, warnings };
    }
    if (phaseForJob(job) === "failed") {
      return { job, inFlight, classification: "failed", recoverySafe: false, warnings };
    }
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : String(error));
  }

  try {
    const terminal = await inferTerminalMetadata(workspace, job);
    if (terminal.backend !== "logs") {
      job = await writeLaunchUpdate(workspace, job, {
        terminal,
        launch: { phase: "terminal-detected" }
      });
      if (terminal.backend !== "zellij" || terminal.exited !== true) {
        job = await writeLaunchUpdate(workspace, job, {
          state: "running",
          detail: undefined,
          launch: { phase: "running", error: undefined }
        });
        return { job, inFlight, classification: "running", recoverySafe: false, warnings };
      }
      if (terminal.exitStatus === 0) {
        const artifacts = await waitForAgentArtifacts(workspace, job, { timeoutMs: 0 });
        if (artifacts.found) {
          job = await writeLaunchUpdate(workspace, job, {
            state: "completed",
            detail: undefined,
            launch: { phase: "completed", error: undefined, setupFinishedAt: nowIso() }
          });
          return { job, inFlight, classification: "completed", recoverySafe: false, warnings };
        }
        const detail = missingArtifactDetailMessage(artifacts.root, artifacts.checked_files, artifacts.elapsed_ms);
        job = await writeLaunchUpdate(workspace, job, {
          state: "orphaned",
          detail,
          launch: { phase: "orphaned", error: detail }
        });
        return { job, inFlight, classification: "orphaned", recoverySafe: false, warnings };
      }
      const detail = `Recovered terminal metadata shows the launch pane exited before completion${terminal.exitStatus == null ? "." : ` with exit status ${terminal.exitStatus}.`}`;
      job = await writeLaunchUpdate(workspace, job, {
        state: "orphaned",
        detail,
        launch: { phase: "orphaned", error: detail }
      });
      return { job, inFlight, classification: "orphaned", recoverySafe: false, warnings };
    }
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : String(error));
  }

  const artifacts = await waitForAgentArtifacts(workspace, job, { timeoutMs: 0 });
  if (artifacts.found) {
    job = await writeLaunchUpdate(workspace, job, {
      state: "completed",
      detail: undefined,
      launch: { phase: "completed", error: undefined, setupFinishedAt: nowIso() }
    });
    return { job, inFlight, classification: "completed", recoverySafe: false, warnings };
  }

  const startedProvisioning = Boolean(
    job.launch?.setupStartedAt ||
    job.launch?.startedAt ||
    job.groundcrew?.workspaceName ||
    job.groundcrew?.worktreeDir ||
    currentPhase === "groundcrew-setup" ||
    currentPhase === "terminal-detected"
  );
  const classification = startedProvisioning ? "orphaned" : "recovery-required";
  const detail = startedProvisioning
    ? "Provisioning started previously, but no in-process launch worker, live terminal, or completion artifacts were found."
    : "Provisioning is pending, but no in-process launch worker is active. Re-run agent_start with the same task_id or idempotency_key to resume safely.";
  job = await writeLaunchUpdate(workspace, job, {
    state: classification,
    detail,
    launch: { phase: classification, error: detail }
  });
  return {
    job,
    inFlight,
    classification,
    recoverySafe: classification === "recovery-required",
    warnings
  };
}
