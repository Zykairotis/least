import type { AgentJobRecord, AgentTerminalMetadata } from "./agentTypes.js";
import type { Workspace } from "./guard.js";
import { listAgentJobs } from "./agentJobStore.js";
import type { AgentTerminalSession, AttachHintResult, TerminalBackendDetection, TerminalTailOptions, TerminalTailResult } from "./agentTerminalTypes.js";
import {
  configureZellijTerminalExec,
  detectZellijBackend,
  inferZellijMetadata,
  listZellijTerminalSessions,
  tailZellijJob,
  zellijAttachCommand,
  zellijTailCommand,
  zellijWatchCommand
} from "./agentTerminalZellij.js";
import {
  configureTmuxTerminalExec,
  detectTmuxBackend,
  inferTmuxMetadata,
  listTmuxTerminalSessions,
  tailTmuxJob,
  tmuxAttachCommand,
  tmuxSessionCandidates,
  tmuxTailCommand,
  tmuxTargets
} from "./agentTerminalTmux.js";
import {
  isWindowsPlatform,
  probeTerminalBackendRuntime,
  terminalExecOptionsFromWorkspace,
  type TerminalExecResolution
} from "./agentTerminalExec.js";
import { logFallbackCommands, logSessionForJob, logTailCommand, logWatchFallbackCommands, tailAgentLogs } from "./agentTerminalLogs.js";

function textHasOutput(result: TerminalTailResult): boolean {
  return result.source !== "none" && result.text.trim().length > 0;
}

async function configureTerminalExecForWorkspace(workspace?: Pick<Workspace, "root">): Promise<void> {
  const options = await terminalExecOptionsFromWorkspace(workspace);
  configureZellijTerminalExec(options);
  configureTmuxTerminalExec(options);
}

export async function detectTerminalBackends(workspace?: Pick<Workspace, "root">): Promise<TerminalBackendDetection[]> {
  await configureTerminalExecForWorkspace(workspace);
  const [zellij, tmux, runtime] = await Promise.all([
    detectZellijBackend(),
    detectTmuxBackend(),
    probeTerminalBackendRuntime(workspace)
  ]);
  const logs: TerminalBackendDetection = {
    backend: "logs",
    available: true,
    detail: "Least job log directory fallback",
    warnings: [],
    capabilities: { tailLogs: true }
  };
  if (isWindowsPlatform() && runtime.wslAvailable && !zellij.available && !tmux.available) {
    logs.warnings.push("WSL is available but neither zellij nor tmux were found in native PATH or WSL distros.");
  }
  return [zellij, tmux, logs];
}

export async function inferTerminalMetadata(workspace: Pick<Workspace, "root">, job: AgentJobRecord): Promise<AgentTerminalMetadata> {
  await configureTerminalExecForWorkspace(workspace);
  const zellij = await inferZellijMetadata(job).catch(() => undefined);
  if (zellij) return zellij;

  const tmux = await inferTmuxMetadata(job).catch(() => undefined);
  if (tmux) return tmux;

  return {
    backend: "logs",
    stdoutLog: logTailCommand(job, "stdout.log"),
    stderrLog: logTailCommand(job, "stderr.log"),
    eventsLog: logTailCommand(job, "events.jsonl"),
    tailCommand: logTailCommand(job),
    inferred: true,
    warnings: [`No Zellij or tmux terminal metadata inferred for workspace ${workspace.root}; using logs fallback.`]
  };
}

export async function tailAgentTerminal(workspace: Pick<Workspace, "root">, job: AgentJobRecord, options: TerminalTailOptions = {}): Promise<TerminalTailResult> {
  await configureTerminalExecForWorkspace(workspace);
  const zellij = await tailZellijJob(job, options.lines);
  if (textHasOutput(zellij)) return zellij;

  const tmux = await tailTmuxJob(job, options.lines);
  if (textHasOutput(tmux)) return tmux;

  const logs = await tailAgentLogs(workspace, job, options.lines);
  if (logs.source !== "none") return logs;

  return {
    ...logs,
    attempted_targets: [...zellij.attempted_targets, ...tmux.attempted_targets, ...logs.attempted_targets],
    error: [zellij.error, tmux.error, logs.error].filter(Boolean).join("\n")
  };
}

export async function listAgentTerminalSessions(workspace: Workspace): Promise<AgentTerminalSession[]> {
  await configureTerminalExecForWorkspace(workspace);
  const sessions: AgentTerminalSession[] = [];
  try {
    sessions.push(...await listZellijTerminalSessions());
  } catch {
    // Zellij is optional.
  }
  try {
    sessions.push(...await listTmuxTerminalSessions());
  } catch {
    // tmux is optional.
  }
  for (const job of await listAgentJobs(workspace)) {
    if (job.terminal?.backend === "zellij" && job.terminal.sessionName) {
      sessions.push({
        backend: "zellij",
        sessionName: job.terminal.sessionName,
        paneId: job.terminal.paneId,
        tabId: job.terminal.tabId,
        tabName: job.terminal.tabName,
        title: job.terminal.paneTitle ?? job.title,
        command: job.terminal.paneCommand,
        cwd: job.terminal.paneCwd ?? job.groundcrew?.worktreeDir,
        attachCommand: job.terminal.attachCommand,
        watchCommand: job.terminal.watchCommand,
        tailCommand: job.terminal.tailCommand,
        source: "job"
      });
    }
    sessions.push(...await tmuxSessionCandidates(job));
    sessions.push(logSessionForJob(job));
  }
  const seen = new Set<string>();
  return sessions.filter((session) => {
    const key = `${session.backend}:${session.sessionName ?? ""}:${session.paneId ?? ""}:${session.cwd ?? ""}:${session.source ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function terminalResolutions(workspace?: Pick<Workspace, "root">): Promise<{ zellij?: TerminalExecResolution; tmux?: TerminalExecResolution }> {
  const runtime = await probeTerminalBackendRuntime(workspace);
  return { zellij: runtime.zellij, tmux: runtime.tmux };
}

export async function attachHintForJob(_workspace: Pick<Workspace, "root">, job: AgentJobRecord): Promise<AttachHintResult> {
  await configureTerminalExecForWorkspace(_workspace);
  const terminal = job.terminal;
  const { zellij: zellijExec, tmux: tmuxExec } = await terminalResolutions(_workspace);
  const attach: string[] = [];
  const watch: string[] = [];
  const tail: string[] = [];
  const warnings: string[] = [];

  const fallback = logFallbackCommands(job);
  const watchFallback = logWatchFallbackCommands(job);

  if (!terminal && !job.groundcrew?.workspaceName && !job.groundcrew?.worktreeDir) {
    warnings.push("No live terminal session is attached; use log fallback commands.");
    attach.push(...watchFallback);
    tail.push(...fallback);
    return {
      job_id: job.jobId,
      task_id: job.taskId,
      backend: "logs",
      terminal,
      attach_commands: [...new Set(attach)],
      watch_commands: [],
      tail_commands: [...new Set(tail)],
      fallback_commands: fallback,
      warnings
    };
  }

  if (terminal?.backend === "logs") {
    attach.push(...watchFallback);
    tail.push(...fallback);
    if (terminal.tailCommand) tail.push(terminal.tailCommand);
    warnings.push("No live terminal session is attached; use log fallback commands.");
  } else {
    if (terminal?.backend === "zellij" && terminal.sessionName) {
      attach.push(terminal.attachCommand ?? zellijAttachCommand(terminal.sessionName, zellijExec));
      watch.push(terminal.watchCommand ?? zellijWatchCommand(terminal.sessionName, zellijExec));
      if (terminal.paneId) {
        tail.push(terminal.tailCommand ?? zellijTailCommand(terminal.sessionName, terminal.paneId, zellijExec));
      }
    }

    if (terminal?.backend === "tmux" && terminal.sessionName) {
      attach.push(terminal.attachCommand ?? tmuxAttachCommand(terminal.sessionName, tmuxExec));
      tail.push(terminal.tailCommand ?? tmuxTailCommand(terminal.sessionName, 200, tmuxExec));
    } else if (terminal?.backend !== "zellij") {
      for (const target of tmuxTargets(job)) {
        attach.push(tmuxAttachCommand(target, tmuxExec));
        tail.push(tmuxTailCommand(target, 200, tmuxExec));
      }
    }

    if (!attach.length && !watch.length) {
      warnings.push("No terminal session metadata is available; use log fallback commands.");
      attach.push(...watchFallback);
    }
    if (!tail.length) tail.push(...fallback);
  }

  return {
    job_id: job.jobId,
    task_id: job.taskId,
    backend: terminal?.backend ?? "logs",
    terminal,
    attach_commands: [...new Set(attach)],
    watch_commands: [...new Set(watch)],
    tail_commands: [...new Set(tail)],
    fallback_commands: fallback,
    warnings
  };
}
