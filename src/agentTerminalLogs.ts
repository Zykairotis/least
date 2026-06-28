import fs from "node:fs/promises";
import path from "node:path";
import type { AgentJobRecord } from "./agentTypes.js";
import type { Workspace } from "./guard.js";
import { agentJobDir } from "./agentJobStore.js";
import type { AgentTerminalSession, TerminalTailResult } from "./agentTerminalTypes.js";

const LOG_FILES = ["stdout.log", "stderr.log", "events.jsonl", "result.md"] as const;
const COMPLETION_ARTIFACT_FILES = ["result.md", "stdout.log", "events.jsonl"] as const;
const DEFAULT_LOG_LINES = 200;

function clampLines(value: unknown): number {
  const n = Number(value ?? DEFAULT_LOG_LINES);
  if (!Number.isFinite(n)) return DEFAULT_LOG_LINES;
  return Math.max(20, Math.min(2000, Math.floor(n)));
}

function lastLines(text: string, lines: number): { text: string; truncated: boolean } {
  const all = text.split(/\r?\n/);
  if (all.length <= lines) return { text, truncated: false };
  return { text: all.slice(-lines).join("\n"), truncated: true };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function relativeLogPath(jobId: string, name: string): string {
  return path.join(".ai-bridge", "agent-runs", jobId, name);
}

export function logWatchCommand(job: AgentJobRecord, name = "stdout.log"): string {
  const relative = relativeLogPath(job.jobId, name);
  if (process.platform === "win32") {
    return `Get-Content -Wait ${relative}`;
  }
  return `tail -f ${relative}`;
}

export function logTailCommand(job: AgentJobRecord, name = "stdout.log", lines = DEFAULT_LOG_LINES): string {
  const relative = relativeLogPath(job.jobId, name);
  if (process.platform === "win32") {
    return `Get-Content -Tail ${lines} ${relative}`;
  }
  return `tail -n ${lines} ${relative}`;
}

export function logFallbackCommands(job: AgentJobRecord, lines = DEFAULT_LOG_LINES): string[] {
  return [
    logTailCommand(job, "stdout.log", lines),
    logTailCommand(job, "stderr.log", lines),
    logTailCommand(job, "events.jsonl", lines)
  ];
}

export function logWatchFallbackCommands(job: AgentJobRecord): string[] {
  return [
    logWatchCommand(job, "stdout.log"),
    logWatchCommand(job, "stderr.log"),
    logWatchCommand(job, "events.jsonl")
  ];
}

export interface AgentArtifactWaitResult {
  found: boolean;
  root: string;
  found_files: string[];
  checked_files: string[];
  elapsed_ms: number;
}

function shouldWaitForCompletionArtifacts(job: AgentJobRecord): boolean {
  if (job.state === "completed") return true;
  return job.terminal?.backend === "zellij" && job.terminal.exitStatus === 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function existingArtifactFiles(root: string, names: readonly string[]): Promise<string[]> {
  const found: string[] = [];
  for (const name of names) {
    if (await fileExists(path.join(root, name))) found.push(name);
  }
  return found;
}

export async function waitForAgentArtifacts(
  workspace: Pick<Workspace, "root">,
  job: AgentJobRecord,
  options: { timeoutMs?: number; intervalMs?: number; requiredAnyOf?: readonly string[] } = {}
): Promise<AgentArtifactWaitResult> {
  const timeoutMs = Math.max(0, Math.floor(options.timeoutMs ?? 5_000));
  const intervalMs = Math.max(50, Math.floor(options.intervalMs ?? 250));
  const checked = [...(options.requiredAnyOf ?? COMPLETION_ARTIFACT_FILES)];
  const root = agentJobDir(workspace, job.jobId);
  const started = Date.now();

  while (true) {
    const found = await existingArtifactFiles(root, checked);
    if (found.length > 0) {
      return {
        found: true,
        root,
        found_files: found,
        checked_files: checked,
        elapsed_ms: Date.now() - started
      };
    }
    const elapsed = Date.now() - started;
    if (elapsed >= timeoutMs) {
      return {
        found: false,
        root,
        found_files: [],
        checked_files: checked,
        elapsed_ms: elapsed
      };
    }
    await sleep(Math.min(intervalMs, timeoutMs - elapsed));
  }
}

export async function tailAgentLogs(workspace: Pick<Workspace, "root">, job: AgentJobRecord, linesInput?: number): Promise<TerminalTailResult> {
  const lines = clampLines(linesInput);
  const root = agentJobDir(workspace, job.jobId);
  const attempted = LOG_FILES.map((name) => path.join(root, name));
  const chunks: string[] = [];
  let truncated = false;

  if (shouldWaitForCompletionArtifacts(job)) {
    await waitForAgentArtifacts(workspace, job, { timeoutMs: 5_000, intervalMs: 250 }).catch(() => undefined);
  }

  for (const name of LOG_FILES) {
    const filePath = path.join(root, name);
    if (!(await fileExists(filePath))) continue;
    const raw = await fs.readFile(filePath, "utf8");
    const clipped = lastLines(raw, lines);
    truncated ||= clipped.truncated;
    chunks.push(`===== ${name} =====\n${clipped.text.trimEnd()}`);
  }

  if (!chunks.length) {
    return {
      job_id: job.jobId,
      task_id: job.taskId,
      source: "none",
      text: "",
      lines,
      truncated: false,
      attempted_targets: attempted,
      tail_hint: logTailCommand(job, "stdout.log", lines),
      error: "No terminal backend matched and no agent log files were found."
    };
  }

  return {
    job_id: job.jobId,
    task_id: job.taskId,
    source: "logs",
    text: chunks.join("\n\n"),
    lines,
    truncated,
    target: root,
    attempted_targets: attempted,
    tail_hint: logTailCommand(job, "stdout.log", lines)
  };
}

export function logSessionForJob(job: AgentJobRecord): AgentTerminalSession {
  return {
    backend: "logs",
    sessionName: job.jobId,
    title: job.title,
    command: "log fallback",
    cwd: agentJobDir({ root: job.workspaceRoot }, job.jobId),
    attachCommand: logWatchCommand(job),
    tailCommand: logTailCommand(job),
    source: "logs"
  };
}
