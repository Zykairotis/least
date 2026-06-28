import type { AgentJobRecord, AgentTerminalMetadata } from "./agentTypes.js";
import type { AgentTerminalSession, TerminalBackendDetection, TerminalTailResult } from "./agentTerminalTypes.js";
import {
  describeTerminalExec,
  execTerminalFile,
  formatTerminalCliCommand,
  getTerminalExec,
  type TerminalExecOptions,
  type TerminalExecResolution
} from "./agentTerminalExec.js";

let execOptions: TerminalExecOptions = {};

export function configureTmuxTerminalExec(options: TerminalExecOptions): void {
  execOptions = options;
}

function clampLines(value: unknown): number {
  const n = Number(value ?? 200);
  if (!Number.isFinite(n)) return 200;
  return Math.max(20, Math.min(2000, Math.floor(n)));
}

export function tmuxTargets(job: AgentJobRecord): string[] {
  const workspaceName = job.groundcrew?.workspaceName;
  const sessionName = job.terminal?.sessionName;
  const taskId = job.taskId;
  const targets = [
    ...(sessionName ? [sessionName] : []),
    ...(workspaceName ? [workspaceName] : []),
    `groundcrew:${taskId}`,
    taskId
  ];
  return [...new Set(targets.filter((target) => target.trim().length > 0))];
}

export function tmuxAttachCommand(target: string, resolution?: TerminalExecResolution): string {
  return formatTerminalCliCommand(resolution, `tmux attach -t ${target}`);
}

export function tmuxTailCommand(target: string, lines = 200, resolution?: TerminalExecResolution): string {
  return formatTerminalCliCommand(resolution, `tmux capture-pane -p -t ${target} -S -${lines}`);
}

async function tmuxResolution(): Promise<TerminalExecResolution | undefined> {
  return await getTerminalExec("tmux", execOptions);
}

export async function detectTmuxBackend(): Promise<TerminalBackendDetection> {
  try {
    const resolution = await tmuxResolution();
    if (!resolution) {
      return {
        backend: "tmux",
        available: false,
        detail: "tmux was not found on PATH (native or WSL)",
        warnings: []
      };
    }
    const stdout = await execTerminalFile(resolution, ["-V"], { timeout: 5_000, maxBuffer: 100_000 });
    const via = describeTerminalExec(resolution);
    return {
      backend: "tmux",
      available: true,
      version: stdout.trim(),
      detail: via ? `via ${via}` : undefined,
      warnings: [],
      capabilities: { capturePane: true, attach: true }
    };
  } catch (error) {
    return {
      backend: "tmux",
      available: false,
      detail: error instanceof Error ? error.message : String(error),
      warnings: []
    };
  }
}

async function captureTmuxTarget(target: string, lines: number): Promise<string> {
  const resolution = await tmuxResolution();
  if (!resolution) throw new Error("tmux is not available");
  return await execTerminalFile(
    resolution,
    ["capture-pane", "-p", "-t", target, "-S", `-${lines}`],
    { timeout: 5_000, maxBuffer: 2_000_000 }
  );
}

export async function tailTmuxJob(job: AgentJobRecord, linesInput?: number): Promise<TerminalTailResult> {
  const lines = clampLines(linesInput);
  const attemptedTargets = tmuxTargets(job);
  const resolution = await tmuxResolution();
  const errors: string[] = [];

  for (const target of attemptedTargets) {
    try {
      const text = await captureTmuxTarget(target, lines);
      return {
        job_id: job.jobId,
        task_id: job.taskId,
        source: "tmux",
        text,
        lines,
        truncated: false,
        target,
        attempted_targets: attemptedTargets,
        attach_hint: tmuxAttachCommand(target, resolution),
        tail_hint: tmuxTailCommand(target, lines, resolution)
      };
    } catch (error) {
      errors.push(`${target}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    job_id: job.jobId,
    task_id: job.taskId,
    source: "none",
    text: "",
    lines,
    truncated: false,
    attempted_targets: attemptedTargets,
    error: errors.length ? errors.join("\n") : "No tmux targets were available for this job."
  };
}

export async function tmuxSessionCandidates(job: AgentJobRecord): Promise<AgentTerminalSession[]> {
  const resolution = await tmuxResolution();
  return tmuxTargets(job).map((target) => ({
    backend: "tmux",
    sessionName: target,
    title: job.title,
    command: "tmux session candidate",
    cwd: job.groundcrew?.worktreeDir,
    attachCommand: tmuxAttachCommand(target, resolution),
    tailCommand: tmuxTailCommand(target, 200, resolution),
    source: "job"
  }));
}

export async function listTmuxTerminalSessions(): Promise<AgentTerminalSession[]> {
  const resolution = await tmuxResolution();
  if (!resolution) return [];
  try {
    const stdout = await execTerminalFile(
      resolution,
      ["list-sessions", "-F", "#{session_name}"],
      { timeout: 5_000, maxBuffer: 200_000 }
    );
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((sessionName) => ({
        backend: "tmux" as const,
        sessionName,
        attachCommand: tmuxAttachCommand(sessionName, resolution),
        tailCommand: tmuxTailCommand(sessionName, 200, resolution),
        source: "discovered" as const
      }));
  } catch {
    return [];
  }
}

export async function inferTmuxMetadata(job: AgentJobRecord): Promise<AgentTerminalMetadata | undefined> {
  const resolution = await tmuxResolution();
  if (!resolution) return undefined;
  for (const target of tmuxTargets(job)) {
    try {
      await execTerminalFile(resolution, ["has-session", "-t", target], { timeout: 3_000, maxBuffer: 50_000 });
      return {
        backend: "tmux",
        sessionName: target,
        attachCommand: tmuxAttachCommand(target, resolution),
        tailCommand: tmuxTailCommand(target, 200, resolution),
        inferred: true
      };
    } catch {
      // Try the next candidate target.
    }
  }
  return undefined;
}