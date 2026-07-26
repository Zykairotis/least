#!/usr/bin/env node

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

function nowIso() {
  return new Date().toISOString();
}

async function writeJson(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fsp.rename(tmp, filePath);
}

async function appendJsonl(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.appendFile(filePath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

async function fileExists(filePath) {
  try {
    const stat = await fsp.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function copyStdoutToResultIfNeeded(runDir) {
  const resultPath = path.join(runDir, "result.md");
  if (await fileExists(resultPath)) return;
  const stdoutPath = path.join(runDir, "stdout.log");
  if (!(await fileExists(stdoutPath))) return;
  await fsp.copyFile(stdoutPath, resultPath);
}

function updateJob(job, patch) {
  const updatedAt = nowIso();
  return {
    ...job,
    ...patch,
    updatedAt,
    launch: patch.launch === undefined
      ? job.launch
      : {
          ...(job.launch ?? { phase: "accepted", acceptedAt: job.createdAt }),
          ...patch.launch,
          lastUpdateAt: updatedAt
        }
  };
}

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) throw new Error("least-direct-agent-runner requires an input JSON path.");
  const input = JSON.parse(await fsp.readFile(inputPath, "utf8"));
  const {
    command,
    args,
    cwd,
    env,
    runDir,
    jobPath,
    job,
    stdoutPath,
    stderrPath,
    eventsPath
  } = input;

  await appendJsonl(eventsPath, { ts: nowIso(), event: "runner_started", command, args, cwd });
  const stdout = fs.createWriteStream(stdoutPath, { flags: "a" });
  const stderr = fs.createWriteStream(stderrPath, { flags: "a" });
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);

  const exit = await new Promise((resolve) => {
    child.once("error", (error) => resolve({ code: null, signal: null, error: error.message }));
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  await new Promise((resolve) => stdout.end(resolve));
  await new Promise((resolve) => stderr.end(resolve));

  const finishedAt = nowIso();
  await appendJsonl(eventsPath, { ts: finishedAt, event: "runner_exited", ...exit });

  if (exit.code === 0) {
    await copyStdoutToResultIfNeeded(runDir);
    await writeJson(path.join(runDir, "completed.json"), {
      completedAt: finishedAt,
      cwd,
      taskId: job.taskId,
      exitCode: exit.code
    });
    await writeJson(jobPath, updateJob(job, {
      state: "completed",
      detail: undefined,
      launch: { phase: "completed", setupFinishedAt: finishedAt, error: undefined },
      groundcrew: {
        ...(job.groundcrew ?? {}),
        worktreeDir: cwd,
        workspaceName: job.taskId,
        runState: { state: "completed", worktreeDir: cwd, workspaceName: job.taskId, repository: job.repository, agent: job.agent }
      }
    }));
    return;
  }

  const reason = exit.error ?? `Direct local agent exited with ${exit.code === null ? `signal ${exit.signal ?? "unknown"}` : `code ${exit.code}`}.`;
  await writeJson(path.join(runDir, "capture-error.json"), {
    failedAt: finishedAt,
    cwd,
    taskId: job.taskId,
    reason,
    exitCode: exit.code,
    signal: exit.signal
  });
  await writeJson(jobPath, updateJob(job, {
    state: "failed-to-launch",
    detail: reason,
    launch: { phase: "failed", setupFinishedAt: finishedAt, error: reason }
  }));
}

main().catch(async (error) => {
  const message = error instanceof Error ? error.message : String(error);
  try {
    const inputPath = process.argv[2];
    if (inputPath) {
      const input = JSON.parse(await fsp.readFile(inputPath, "utf8"));
      await appendJsonl(input.eventsPath, { ts: nowIso(), event: "runner_failed", error: message });
      await writeJson(path.join(input.runDir, "capture-error.json"), { failedAt: nowIso(), reason: message });
    }
  } catch {
    // Last-ditch failure reporting only.
  }
  process.exit(1);
});
