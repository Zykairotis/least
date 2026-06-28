import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../dist/config.js";
import { PathGuard, WorkspaceManager } from "../dist/guard.js";
import { runBash } from "../dist/bashOps.js";

function wslAvailable() {
  if (process.platform !== "win32") return false;
  const result = spawnSync("wsl.exe", ["--status"], { encoding: "utf8" });
  return result.status === 0 || result.status === 50;
}

async function makeWorkspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "least-shell-backend-"));
  await fs.writeFile(path.join(root, "marker.txt"), "least-shell-backend-ok\n", "utf8");
  return root;
}

const root = await makeWorkspace();
const guard = new PathGuard(loadConfig(["--root", root, "--allow-root", root]));
const workspaces = new WorkspaceManager(loadConfig(["--root", root, "--allow-root", root]));
const workspace = workspaces.openWorkspace(root);

const marker = "least-shell-backend-ok";
const cases = [];

if (process.platform === "win32") {
  cases.push({ backend: "cmd", command: `echo ${marker}` });
  cases.push({ backend: "powershell", command: `Write-Output ${marker}` });
  if (wslAvailable()) {
    cases.push({ backend: "wsl", command: `echo ${marker}` });
  }
} else {
  cases.push({ backend: "bash", command: `echo ${marker}` });
}

for (const testCase of cases) {
  const config = loadConfig(["--root", root, "--allow-root", root, "--shell-backend", testCase.backend, "--bash", "full"]);
  const result = await runBash(config, guard, workspace, testCase.command, { timeoutMs: 15_000 });
  assert.equal(result.exitCode, 0, `${testCase.backend} exit code`);
  assert.ok(result.stdout.includes(marker), `${testCase.backend} stdout missing marker: ${result.stdout}`);
  console.log(`shell-backend-smoke: ${testCase.backend} ok (${result.durationMs}ms)`);
}

const readonlyConfig = loadConfig(["--root", root, "--allow-root", root, "--bash", "readonly"]);
const allowed = await runBash(readonlyConfig, guard, workspace, process.platform === "win32" ? "type marker.txt" : "cat marker.txt", {
  timeoutMs: 10_000
});
assert.ok(allowed.stdout.includes(marker), "readonly cat/type should work");

let blocked = false;
try {
  await runBash(readonlyConfig, guard, workspace, "npm test", { timeoutMs: 5000 });
} catch {
  blocked = true;
}
assert.ok(blocked, "readonly should block npm test");

console.log("shell-backend-smoke: ok");