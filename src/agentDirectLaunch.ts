import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { LocalAgentProfile } from "./agentConfig.js";
import type { AgentJobRecord, AgentStartInput } from "./agentTypes.js";
import type { Workspace } from "./guard.js";
import { LeastError } from "./guard.js";
import { agentJobDir, agentJobPath, writeAgentJob } from "./agentJobStore.js";

function repoRootDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function nowIso(): string {
  return new Date().toISOString();
}

function isActive(state: AgentJobRecord["state"]): boolean {
  return state === "accepted" || state === "provisioning" || state === "running" || state === "resumed";
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function appendJsonl(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function commandValue(profile: LocalAgentProfile): string | string[] | undefined {
  return profile.command ?? profile.cmd;
}

function resolveMaybeLocalScript(value: string): string {
  if (path.isAbsolute(value)) return value;
  if (/^[a-zA-Z]:[\\/]/.test(value)) return value;
  if (value.startsWith(".") || value.includes("/") || value.includes("\\")) {
    return path.resolve(repoRootDir(), value);
  }
  return value;
}

function quoteForShell(value: string): string {
  if (process.platform === "win32") {
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function commandParts(profile: LocalAgentProfile, promptText: string, promptFile: string, jobDir: string): { command: string; args: string[] } {
  const command = commandValue(profile);
  const promptArgs = profile.promptVia === "prompt-file"
    ? ["--prompt-file", promptFile]
    : [promptText];
  const outputArgs = profile.provider === "pi" ? ["--output-dir", jobDir] : [];

  if (Array.isArray(command)) {
    if (!command.length) throw new LeastError("Local agent profile has an empty command array.");
    return {
      command: resolveMaybeLocalScript(command[0] ?? ""),
      args: [...command.slice(1), ...outputArgs, ...promptArgs]
    };
  }

  if (typeof command === "string" && command.trim()) {
    const rendered = [command, ...outputArgs.map(quoteForShell), ...promptArgs.map(quoteForShell)].join(" ");
    return process.platform === "win32"
      ? { command: "cmd.exe", args: ["/d", "/s", "/c", rendered] }
      : { command: "sh", args: ["-lc", rendered] };
  }

  throw new LeastError("Local agent profile has no cmd/command.");
}

export async function refreshDirectAgentJobFromArtifacts(workspace: Workspace, job: AgentJobRecord): Promise<AgentJobRecord> {
  if (!isActive(job.state)) return job;
  const runDir = agentJobDir(workspace, job.jobId);
  const completedPath = path.join(runDir, "completed.json");
  const captureErrorPath = path.join(runDir, "capture-error.json");
  if (await fileExists(completedPath)) {
    return await writeAgentJob(workspace, {
      ...job,
      state: "completed",
      detail: undefined,
      launch: {
        ...(job.launch ?? { phase: "accepted", acceptedAt: job.createdAt }),
        phase: "completed",
        setupFinishedAt: job.launch?.setupFinishedAt ?? nowIso(),
        error: undefined
      },
      groundcrew: {
        ...job.groundcrew,
        worktreeDir: job.groundcrew?.worktreeDir ?? workspace.root,
        workspaceName: job.groundcrew?.workspaceName ?? job.taskId,
        runState: {
          ...(job.groundcrew?.runState ?? {}),
          state: "completed",
          worktreeDir: job.groundcrew?.worktreeDir ?? workspace.root,
          workspaceName: job.groundcrew?.workspaceName ?? job.taskId,
          repository: job.repository,
          agent: job.agent
        }
      }
    });
  }
  if (await fileExists(captureErrorPath)) {
    return await writeAgentJob(workspace, {
      ...job,
      state: "failed-to-launch",
      launch: {
        ...(job.launch ?? { phase: "accepted", acceptedAt: job.createdAt }),
        phase: "failed",
        setupFinishedAt: job.launch?.setupFinishedAt ?? nowIso(),
        error: job.detail ?? "Direct local agent launch failed."
      }
    });
  }
  return job;
}

export async function startDirectAgentLaunch(input: {
  workspace: Workspace;
  job: AgentJobRecord;
  profile: LocalAgentProfile;
  startInput: AgentStartInput;
}): Promise<AgentJobRecord> {
  const { workspace, job, profile, startInput } = input;
  const runDir = agentJobDir(workspace, job.jobId);
  await fs.mkdir(runDir, { recursive: true });
  const stdoutPath = path.join(runDir, "stdout.log");
  const stderrPath = path.join(runDir, "stderr.log");
  const eventsPath = path.join(runDir, "events.jsonl");
  const runnerInputPath = path.join(runDir, "direct-runner-input.json");
  const startedAt = nowIso();
  const prompt = startInput.prompt;
  const parts = commandParts(profile, prompt, job.promptFile, runDir);

  await writeJson(path.join(runDir, "started.json"), {
    startedAt,
    cwd: workspace.root,
    taskId: job.taskId,
    agent: job.agent,
    repository: job.repository,
    mode: "direct-folder"
  });
  await appendJsonl(eventsPath, { ts: startedAt, event: "direct_launch_started", cwd: workspace.root, command: parts.command, args: parts.args });
  const runnerJob = {
    ...job,
    state: "running" as const,
    detail: "Direct folder launch: running in the workspace root without a Groundcrew worktree.",
    launch: {
      ...(job.launch ?? { phase: "accepted" as const, acceptedAt: job.createdAt }),
      phase: "running" as const,
      setupStartedAt: job.launch?.setupStartedAt ?? startedAt,
      setupFinishedAt: startedAt,
      error: undefined
    },
    groundcrew: {
      ...job.groundcrew,
      worktreeDir: workspace.root,
      workspaceName: job.taskId,
      runState: { state: "running", worktreeDir: workspace.root, workspaceName: job.taskId, repository: job.repository, agent: job.agent }
    },
    terminal: {
      backend: "logs" as const,
      stdoutLog: stdoutPath,
      stderrLog: stderrPath,
      eventsLog: eventsPath,
      tailCommand: process.platform === "win32" ? `Get-Content -Tail 200 ${stdoutPath}` : `tail -n 200 ${stdoutPath}`,
      watchCommand: process.platform === "win32" ? `Get-Content -Wait ${stdoutPath}` : `tail -f ${stdoutPath}`,
      inferred: true,
      warnings: ["Direct folder launch uses log attach/tail commands instead of a managed Groundcrew terminal session."]
    }
  };
  await fs.writeFile(runnerInputPath, `${JSON.stringify({
    command: parts.command,
    args: parts.args,
    cwd: workspace.root,
    env: {
      GROUNDCREW_TASK_ID: `least:${job.taskId}`,
      LEAST_AGENT_JOB_DIR: runDir,
      LEAST_AGENT_WORKSPACE_ROOT: workspace.root
    },
    runDir,
    jobPath: agentJobPath(workspace, job.jobId),
    job: runnerJob,
    stdoutPath,
    stderrPath,
    eventsPath
  }, null, 2)}\n`, { mode: 0o600 });

  const runnerPath = path.resolve(repoRootDir(), "scripts", "least-direct-agent-runner.mjs");
  const child = spawn(process.execPath, [runnerPath, runnerInputPath], {
    cwd: repoRootDir(),
    windowsHide: true,
    detached: true,
    stdio: "ignore"
  });
  child.unref();

  return await writeAgentJob(workspace, runnerJob);
}
