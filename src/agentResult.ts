import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentJobRecord } from "./agentTypes.js";
import { LeastError } from "./guard.js";
import { tailAgentJob, type AgentTailResult } from "./agentTail.js";

const execFileAsync = promisify(execFile);

export interface AgentResultOptions {
  includeDiff?: boolean;
  includeTail?: boolean;
  diffMaxChars?: number;
  tailLines?: number;
}

export interface AgentResultGitSummary {
  worktree_dir?: string;
  available: boolean;
  dirty: boolean;
  changed_files: string[];
  status_porcelain: string;
  diff_stat: string;
  diff?: string;
  diff_truncated: boolean;
  error?: string;
}

export interface AgentResultSummary {
  job_id: string;
  task_id: string;
  state: string;
  agent: string;
  repository: string;
  branch_name?: string;
  worktree_dir?: string;
  git: AgentResultGitSummary;
  tail?: AgentTailResult;
  conclusion: "ready-for-review" | "still-running" | "failed" | "no-changes" | "unknown";
  warnings: string[];
}

function clampMaxChars(value: unknown): number {
  const n = Number(value ?? 60_000);
  if (!Number.isFinite(n)) return 60_000;
  return Math.max(1_000, Math.min(500_000, Math.floor(n)));
}

async function git(worktreeDir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", worktreeDir, ...args], { timeout: 15_000, maxBuffer: 5_000_000 });
  return stdout;
}

function changedFilesFromStatus(status: string): string[] {
  return status
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return {
    text: `${text.slice(0, maxChars)}\n\n[diff truncated at ${maxChars} characters]`,
    truncated: true
  };
}

async function summarizeGit(job: AgentJobRecord, options: AgentResultOptions): Promise<AgentResultGitSummary> {
  const worktreeDir = job.groundcrew?.worktreeDir;
  if (!worktreeDir) {
    return {
      worktree_dir: worktreeDir,
      available: false,
      dirty: false,
      changed_files: [],
      status_porcelain: "",
      diff_stat: "",
      diff_truncated: false,
      error: "Groundcrew run state does not include worktreeDir yet."
    };
  }

  if (!fs.existsSync(worktreeDir)) {
    return {
      worktree_dir: worktreeDir,
      available: false,
      dirty: false,
      changed_files: [],
      status_porcelain: "",
      diff_stat: "",
      diff_truncated: false,
      error: `Worktree directory does not exist: ${worktreeDir}`
    };
  }

  try {
    const status = await git(worktreeDir, ["status", "--porcelain=v1"]);
    const diffStat = await git(worktreeDir, ["diff", "--stat"]);
    const changedFiles = changedFilesFromStatus(status);
    const includeDiff = options.includeDiff ?? false;
    const maxChars = clampMaxChars(options.diffMaxChars);
    let diff: string | undefined;
    let diffTruncated = false;
    if (includeDiff) {
      const fullDiff = await git(worktreeDir, ["diff", "--"]);
      const truncated = truncateText(fullDiff, maxChars);
      diff = truncated.text;
      diffTruncated = truncated.truncated;
    }
    return {
      worktree_dir: worktreeDir,
      available: true,
      dirty: changedFiles.length > 0,
      changed_files: changedFiles,
      status_porcelain: status,
      diff_stat: diffStat,
      ...(diff === undefined ? {} : { diff }),
      diff_truncated: diffTruncated
    };
  } catch (error) {
    return {
      worktree_dir: worktreeDir,
      available: false,
      dirty: false,
      changed_files: [],
      status_porcelain: "",
      diff_stat: "",
      diff_truncated: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function conclusionFor(job: AgentJobRecord, gitSummary: AgentResultGitSummary): AgentResultSummary["conclusion"] {
  if (job.state === "failed-to-launch") return "failed";
  if (job.state === "accepted" || job.state === "running" || job.state === "provisioning" || job.state === "resumed") return "still-running";
  if (!gitSummary.available) return "unknown";
  if (gitSummary.dirty) return "ready-for-review";
  return "no-changes";
}

export async function summarizeAgentResult(workspace: { root: string }, job: AgentJobRecord, options: AgentResultOptions = {}): Promise<AgentResultSummary> {
  const gitSummary = await summarizeGit(job, options);
  const tail = options.includeTail ? await tailAgentJob(workspace, job, { lines: options.tailLines }) : undefined;
  const warnings: string[] = [];
  if (!gitSummary.available && gitSummary.error) warnings.push(gitSummary.error);
  if (job.detail) warnings.push(job.detail);
  if (tail?.error) warnings.push(tail.error);
  return {
    job_id: job.jobId,
    task_id: job.taskId,
    state: job.state,
    agent: job.agent,
    repository: job.repository,
    branch_name: job.groundcrew?.branchName,
    worktree_dir: job.groundcrew?.worktreeDir,
    git: gitSummary,
    ...(tail === undefined ? {} : { tail }),
    conclusion: conclusionFor(job, gitSummary),
    warnings
  };
}

export function requireWorktreeForResult(job: AgentJobRecord): void {
  if (!job.groundcrew?.worktreeDir) {
    throw new LeastError("Agent job has no Groundcrew worktreeDir yet. Run agent_status first or wait for Groundcrew setup to finish.");
  }
}
