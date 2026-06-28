#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = process.cwd();

function utf8(text) {
  return text;
}

async function writeStatus(jobDir, taskId) {
  await fs.mkdir(jobDir, { recursive: true });
  await fs.writeFile(
    path.join(jobDir, "status.json"),
    JSON.stringify({ jobId: path.basename(jobDir), taskId }, null, 2) + "\n",
    "utf8"
  );
}

async function buildFixture(name) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `least-omp-${name}-`));
  const runsRoot = path.join(root, ".ai-bridge", "agent-runs");
  const worktreeDir = path.join(root, "worktree");
  const jobDir = path.join(runsRoot, `agent_${name}`);
  const promptFile = path.join(jobDir, "prompt.md");
  const taskId = `least-agent-${name}-${Date.now()}`;
  await fs.mkdir(worktreeDir, { recursive: true });
  await writeStatus(jobDir, taskId);
  await fs.writeFile(promptFile, "Inspect only. Do not modify files.\n", "utf8");
  return { root, runsRoot, worktreeDir, jobDir, promptFile, taskId };
}

async function makeFakeOmp(root, fileName, body) {
  const scriptPath = path.join(root, fileName);
  await fs.writeFile(scriptPath, body, "utf8");
  return scriptPath;
}

function fakeEnv(fakeScript) {
  return {
    ...process.env,
    GROUNDCREW_TASK_ID: undefined,
    LEAST_OMP_EXECUTABLE: "powershell.exe",
    LEAST_OMP_EXECUTABLE_ARGS_JSON: JSON.stringify([
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      fakeScript
    ])
  };
}

async function assertArtifacts(jobDir, extra = []) {
  for (const name of ["stdout.log", "stderr.log", "result.md", "started.json", "completed.json", ...extra]) {
    const stat = await fs.stat(path.join(jobDir, name));
    assert.ok(stat.isFile(), `${name} should exist`);
  }
}

async function runPs1Wrapper() {
  const fixture = await buildFixture("ps1");
  const fakeScript = await makeFakeOmp(
    fixture.root,
    "fake-omp-success.ps1",
    "Write-Output 'fake summary from ps1 smoke'\nWrite-Error 'fake stderr'\nexit 0\n"
  );
  const wrapper = path.join(repoRoot, "scripts", "least-omp-headless.ps1");
  const env = { ...fakeEnv(fakeScript), GROUNDCREW_TASK_ID: `least:${fixture.taskId}` };
  await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", wrapper, "--prompt-file", fixture.promptFile, "--output-dir", fixture.jobDir],
    { cwd: fixture.worktreeDir, env, windowsHide: true, timeout: 30_000, maxBuffer: 2_000_000 }
  );
  await assertArtifacts(fixture.jobDir, ["launch-debug.jsonl"]);
  const stdout = await fs.readFile(path.join(fixture.jobDir, "stdout.log"), "utf8");
  assert.match(stdout, /fake summary from ps1 smoke/);
  await fs.rm(fixture.root, { recursive: true, force: true });
}

async function runCmdWrapper() {
  const fixture = await buildFixture("cmd");
  const fakeScript = await makeFakeOmp(
    fixture.root,
    "fake-omp-success.ps1",
    "Write-Output 'fake summary from cmd smoke'\nexit 0\n"
  );
  const wrapper = path.join(repoRoot, "scripts", "least-omp-headless.cmd");
  const env = { ...fakeEnv(fakeScript), GROUNDCREW_TASK_ID: `least:${fixture.taskId}` };
  await execFileAsync(
    "cmd.exe",
    ["/d", "/s", "/c", wrapper, "Prompt from cmd wrapper"],
    { cwd: fixture.worktreeDir, env, windowsHide: true, timeout: 30_000, maxBuffer: 2_000_000 }
  );
  await assertArtifacts(fixture.jobDir, ["launch-debug.jsonl"]);
  const result = await fs.readFile(path.join(fixture.jobDir, "result.md"), "utf8");
  assert.match(result, /fake summary from cmd smoke/);
  await fs.rm(fixture.root, { recursive: true, force: true });
}

async function runShCmdWrapper() {
  const fixture = await buildFixture("shcmd");
  const fakeScript = await makeFakeOmp(
    fixture.root,
    "fake-omp-success.ps1",
    "Write-Output 'fake summary from sh cmd smoke'\nexit 0\n"
  );
  const promptDir = await fs.mkdtemp(path.join(os.tmpdir(), "least-groundcrew-prompt-"));
  const promptFile = path.join(promptDir, "prompt.txt");
  await fs.writeFile(promptFile, "Inspect the repo.\nReturn a short summary only.\n", "utf8");
  const wrapperCmd = path.join(repoRoot, "scripts", "least-omp-headless.cmd");
  const launchScript = path.join(promptDir, "launch.sh");
  const fakeScriptJson = JSON.stringify([
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    fakeScript
  ]);
  const launchText = [
    "#!/usr/bin/env bash",
    `trap 'rm -rf '\\''${promptDir}'\\''' EXIT && cd '${fixture.worktreeDir}' && (true); prepare_status=$?; if [ "$prepare_status" -ne 0 ]; then echo "groundcrew prepareWorktree hook exited with status $prepare_status; continuing to agent." >&2; fi && export GROUNDCREW_TASK_ID='least:${fixture.taskId}' && export LEAST_OMP_EXECUTABLE='powershell.exe' && export LEAST_OMP_EXECUTABLE_ARGS_JSON='${fakeScriptJson}' && _p=$(cat '${promptFile}') && rm -rf '${promptDir}' && exec cmd.exe /c "${wrapperCmd}" "$_p"`
  ].join("\n");
  await fs.writeFile(launchScript, utf8(launchText), "utf8");

  const shCmd = path.join(repoRoot, "scripts", "groundcrew-bin", "sh.cmd");
  const shCommandLine = `${shCmd} -c trap 'touch ${path.join(promptDir, "pane-exit.marker")}' EXIT; bash '${launchScript}'`;
  await execFileAsync(
    "cmd.exe",
    ["/d", "/s", "/c", shCommandLine],
    {
      cwd: fixture.worktreeDir,
      env: {
        ...process.env,
        LEAST_OMP_EXECUTABLE: "powershell.exe",
        LEAST_OMP_EXECUTABLE_ARGS_JSON: fakeScriptJson
      },
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 2_000_000
    }
  );

  await assertArtifacts(fixture.jobDir, ["launch-debug.jsonl"]);
  const debug = await fs.readFile(path.join(fixture.jobDir, "launch-debug.jsonl"), "utf8");
  assert.match(debug, /"mode":"native-omp-relay"/);
  await assert.rejects(fs.stat(promptDir));
  await fs.rm(fixture.root, { recursive: true, force: true });
}

async function runEmptyOutputFailure() {
  const fixture = await buildFixture("empty");
  const fakeScript = await makeFakeOmp(
    fixture.root,
    "fake-omp-empty.ps1",
    "exit 0\n"
  );
  const wrapper = path.join(repoRoot, "scripts", "least-omp-headless.ps1");
  const env = { ...fakeEnv(fakeScript), GROUNDCREW_TASK_ID: `least:${fixture.taskId}` };
  let failed = false;
  try {
    await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", wrapper, "--prompt-file", fixture.promptFile, "--output-dir", fixture.jobDir],
      { cwd: fixture.worktreeDir, env, windowsHide: true, timeout: 30_000, maxBuffer: 2_000_000 }
    );
  } catch (error) {
    failed = true;
    assert.equal(error.code, 1);
  }
  assert.equal(failed, true, "empty output should fail");
  const captureError = await fs.readFile(path.join(fixture.jobDir, "capture-error.json"), "utf8");
  assert.match(captureError, /produced no output/);
  await fs.rm(fixture.root, { recursive: true, force: true });
}

if (process.platform !== "win32") {
  console.log("agent-omp-windows-smoke: skipped (not Windows)");
  process.exit(0);
}

await runPs1Wrapper();
console.log("agent-omp-windows-smoke: ps1 wrapper ok");

await runCmdWrapper();
console.log("agent-omp-windows-smoke: cmd wrapper ok");

await runShCmdWrapper();
console.log("agent-omp-windows-smoke: sh.cmd launch path ok");

await runEmptyOutputFailure();
console.log("agent-omp-windows-smoke: empty-output failure path ok");

console.log("agent-omp-windows-smoke: ok");
