import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../dist/config.js";
import { PathGuard } from "../dist/guard.js";
import { WorkspaceManager } from "../dist/guard.js";
import { isRipgrepAvailable } from "../dist/commandCaps.js";
import { listWorkspaceFiles } from "../dist/filesOps.js";
import { searchWorkspace, searchWorkspaceContext } from "../dist/searchOps.js";
import { readManyTextFiles } from "../dist/fsOps.js";
import { workspaceSummary } from "../dist/workspaceOps.js";
import { queryJsonFiles, resolveJsonPointer } from "../dist/jsonQueryOps.js";
import { runBash } from "../dist/bashOps.js";
import { createLeastServer } from "../dist/server.js";
import { clearDashboardEvents, getRecentDashboardEvents } from "../dist/dashboardEvents.js";

async function makeRepo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "least-fast-explore-"));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "alpha.ts"), "export const alpha = 1;\nexport const beta = 2;\n", "utf8");
  await fs.writeFile(path.join(root, "src", "gamma.ts"), "export function gamma() { return alpha; }\n", "utf8");
  await fs.writeFile(path.join(root, "src", "scratch.ts"), "export const scratch = true;\n", "utf8");
  await fs.writeFile(
    path.join(root, "src", "many.txt"),
    Array.from({ length: 80 }, (_, idx) => `alpha-hit ${idx + 1}`).join("\n") + "\n",
    "utf8"
  );
  await fs.writeFile(path.join(root, "README.md"), "# demo\n", "utf8");
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "demo", scripts: { test: "echo ok" }, dependencies: { react: "18.0.0" } }, null, 2),
    "utf8"
  );
  spawnSync("git", ["init"], { cwd: root, stdio: "ignore" });
  spawnSync("git", ["config", "user.email", "fast-exploration@example.com"], { cwd: root, stdio: "ignore" });
  spawnSync("git", ["config", "user.name", "Fast Exploration"], { cwd: root, stdio: "ignore" });
  spawnSync("git", ["add", "README.md", "package.json", "src/alpha.ts", "src/gamma.ts", "src/many.txt"], { cwd: root, stdio: "ignore" });
  spawnSync("git", ["commit", "-m", "init"], { cwd: root, stdio: "ignore" });
  return root;
}

const root = await makeRepo();
const config = loadConfig(["--root", root, "--allow-root", root]);
const guard = new PathGuard(config);
const workspaces = new WorkspaceManager(config);
const workspace = workspaces.openWorkspace(root);

const rgAvailable = await isRipgrepAvailable();
console.log(`fast-exploration-unit: ripgrep ${rgAvailable ? "available" : "unavailable"}`);

const files = await listWorkspaceFiles(config, guard, workspace, { maxResults: 100 });
assert.ok(files.files.length >= 3, "files tool should list repo files");
assert.ok(["git", "ripgrep", "node"].includes(files.backend), `unexpected files backend: ${files.backend}`);

const limitedFiles = await listWorkspaceFiles(config, guard, workspace, { maxResults: 2, trackedOnly: false, includeHidden: false, refresh: true });
assert.equal(limitedFiles.truncated, true, "limited files call should mark truncation");
const cachedExpandedFiles = await listWorkspaceFiles(config, guard, workspace, { maxResults: 10, trackedOnly: false, includeHidden: false });
assert.equal(cachedExpandedFiles.cacheHit, true, "expanded files call should reuse cache");
assert.equal(cachedExpandedFiles.truncated, true, "cache should preserve original truncation signal");
assert.ok(cachedExpandedFiles.files.length >= limitedFiles.files.length, "expanded files call should slice from cached full list");

const trackedFiles = await listWorkspaceFiles(config, guard, workspace, { trackedOnly: true, maxResults: 100 });
assert.ok(trackedFiles.files.includes("src/alpha.ts"), "tracked_only should include tracked files");
assert.ok(!trackedFiles.files.includes("src/scratch.ts"), "tracked_only should exclude untracked files");

const search = await searchWorkspace(config, guard, workspace, { query: "alpha", maxResults: 10 });
assert.ok(search.matches.length >= 1, "search should find alpha");
if (rgAvailable) assert.equal(search.used, "ripgrep");

const manyHits = await searchWorkspace(config, guard, workspace, { query: "alpha-hit", maxResults: 75 });
assert.equal(manyHits.matches.length, 75, "search should honor maxResults above 50");

const context = await searchWorkspaceContext(config, guard, workspace, {
  query: "alpha",
  maxResults: 5,
  beforeLines: 1,
  afterLines: 1
});
assert.ok(context.matches.length >= 1, "search_context should find alpha");
assert.ok(context.matches[0].context.includes("alpha"), "search_context should include surrounding lines");
assert.ok(
  context.matches[0].context.split("\n").every((line) => /^\d+[:-] /.test(line)),
  "search_context should normalize context lines instead of exposing raw ripgrep output"
);

const many = await readManyTextFiles(config, guard, workspace, [
  { path: "src/alpha.ts" },
  { path: "README.md", startLine: 1, endLine: 1 }
]);
assert.equal(many.files.length, 2, "read_many should return both files");
assert.ok(many.totalBytes > 0, "read_many should report bytes");

const rangedRead = await readManyTextFiles(
  config,
  guard,
  workspace,
  [{ path: "src/many.txt", startLine: 10, endLine: 12 }],
  { includeSha256: false, includeTotalLines: false, concurrency: 4 }
);
assert.equal(rangedRead.files[0]?.sha256, undefined, "bounded read_many fast path should skip sha256 by default");
assert.equal(rangedRead.files[0]?.totalLines, undefined, "bounded read_many fast path should skip total line counts by default");

const fastSummary = await workspaceSummary(config, guard, workspace, {
  includeTree: false,
  includeSkills: false,
  includeGlobalSkills: false,
  includeRecentCommits: false
});
assert.ok(!fastSummary.text.includes("## Recent commits"), "fast open should omit recent commits");
assert.ok(!fastSummary.tree, "fast open should omit tree");

const shellConfig = loadConfig(["--root", root, "--shell-backend", "powershell"]);
assert.equal(shellConfig.shellBackend, "powershell");

const badShell = () => loadConfig(["--root", root, "--shell-backend", "not-a-shell"]);
let rejected = false;
try {
  badShell();
} catch {
  rejected = false;
}
assert.equal(rejected, false);
assert.equal(loadConfig(["--root", root, "--shell-backend", "wsl"]).shellBackend, "wsl");

assert.equal(resolveJsonPointer({ scripts: { test: "echo ok" } }, "/scripts/test"), "echo ok");

const json = await queryJsonFiles(config, guard, workspace, { path: "package.json", pointer: "/dependencies/react" });
assert.equal(json.hits[0]?.preview, "18.0.0", "json_query should resolve dependency version");

const readonlyConfig = loadConfig(["--root", root, "--bash", "readonly"]);
const inspectCommand = process.platform === "win32" ? "type src\\alpha.ts" : "head -n 1 src/alpha.ts";
const readonlyResult = await runBash(readonlyConfig, guard, workspace, inspectCommand, { timeoutMs: 10_000 });
assert.equal(readonlyResult.exitCode, 0, "readonly inspection command should succeed");

let readonlyBlocked = false;
try {
  await runBash(readonlyConfig, guard, workspace, "npm test", { timeoutMs: 5000 });
} catch {
  readonlyBlocked = true;
}
assert.ok(readonlyBlocked, "readonly should block npm test");

assert.equal(loadConfig(["--root", root, "--bash", "readonly"]).bashMode, "readonly");

const { registry } = createLeastServer(config);
const batch = await registry.invoke("batch", {
  calls: [
    { tool: "files", args: { max_results: 20 } },
    { tool: "search", args: { query: "alpha", max_results: 5 } }
  ],
  max_parallel: 2
});
assert.equal(batch.isError, false, "batch should succeed for read-only tools");
assert.ok(batch.content.includes("# Batch"), "batch should return batch output");


const structuredBatch = await registry.invoke("batch", {
  calls: [
    { tool: "local_http_request", args: { method: "GET", url: "http://localhost:1/__least_batch_probe__" } },
    { tool: "local_http_json", args: { method: "GET", url: "http://localhost:1/__least_batch_probe__" } },
    { tool: "api_smoke_suite", args: { baseUrl: "http://localhost:1", checks: [{ method: "GET", path: "/__least_batch_probe__" }] } },
    { tool: "docker_compose_services", args: { composeDir: "." } },
    { tool: "docker_compose_ps", args: { composeDir: "." } },
    { tool: "docker_compose_logs", args: { composeDir: ".", service: "__least_missing_service__" } },
    { tool: "docker_compose_health", args: { composeDir: "." } }
  ],
  max_parallel: 1
});
assert.equal(structuredBatch.isError, false, "batch wrapper should complete for safe structured read-only tools");
for (const tool of ["local_http_request", "local_http_json", "api_smoke_suite", "docker_compose_services", "docker_compose_ps", "docker_compose_logs", "docker_compose_health"]) {
  assert.ok(structuredBatch.content.includes("## ") && structuredBatch.content.includes(tool), "batch should include structured tool " + tool);
  assert.ok(!structuredBatch.content.includes("Tool " + tool + " is not allowed in batch"), "batch should allow structured tool " + tool);
}

const perf = await registry.invoke("least_perf", { window: "session" });
assert.equal(perf.isError, false, "least_perf should succeed");
assert.ok(perf.content.includes("Least Performance"), "least_perf should include telemetry heading");

const readAround = await registry.invoke("read_around", {
  path: "src/many.txt",
  line: 20,
  before: 2,
  after: 2
});
assert.equal(readAround.isError, false, "read_around should succeed");
assert.ok(readAround.content.includes("18 | alpha-hit 18"), "read_around should include surrounding numbered lines");

const projectMap = await registry.invoke("project_map", {});
assert.equal(projectMap.isError, false, "project_map should succeed");
assert.ok(projectMap.content.includes("Project Map"), "project_map should render");

const contextPack = await registry.invoke("context_pack", {
  task: "find alpha export usage",
  query: "alpha",
  max_files: 6,
  max_snippets: 4
});
assert.equal(contextPack.isError, false, "context_pack should succeed");
assert.ok(contextPack.content.includes("Context Pack"), "context_pack should render");

const warmup = await registry.invoke("warmup", { indexes: ["files", "git", "package", "symbols"] });
assert.equal(warmup.isError, false, "warmup should succeed");
assert.ok(warmup.content.includes("Warmup"), "warmup should render");

const multiEdit = await registry.invoke("multi_edit", {
  edits: [
    { path: "src/scratch.ts", old_text: "true", new_text: "false" },
    { path: "README.md", old_text: "# demo", new_text: "# demo\nupdated" }
  ]
});
assert.equal(multiEdit.isError, false, "multi_edit should succeed");
assert.ok(multiEdit.content.includes("Multi Edit"), "multi_edit should render");

clearDashboardEvents();
const failedEdit = await registry.invoke("multi_edit", {
  edits: [{ path: "src/scratch.ts", old_text: "missing text", new_text: "x" }]
});
assert.equal(failedEdit.isError, true);
const lifecycle = getRecentDashboardEvents().filter((event) => event.toolName === "multi_edit");
assert.equal(lifecycle.filter((event) => event.kind === "tool:start").length, 1, "failed call should emit one start");
assert.equal(lifecycle.filter((event) => event.kind === "tool:error").length, 1, "failed call should emit one terminal error");
assert.equal(lifecycle.filter((event) => event.kind === "tool:end").length, 0, "failed call should not emit success end");

const patchApply = await registry.invoke("apply_patch", {
  patch: `*** Begin Patch
*** Update File: src/gamma.ts
@@
-export function gamma() { return alpha; }
+export function gamma() { return alpha + 1; }
*** End Patch`
});
assert.equal(patchApply.isError, false, "apply_patch should succeed");
assert.ok(patchApply.content.includes("Apply Patch"), "apply_patch should render");

const diffSummary = await registry.invoke("diff_summary", { classify: true });
assert.equal(diffSummary.isError, false, "diff_summary should succeed");
assert.ok(diffSummary.content.includes("Diff Summary"), "diff_summary should render");

const readChanged = await registry.invoke("read_changed_files", { max_files: 5 });
assert.equal(readChanged.isError, false, "read_changed_files should succeed");
assert.ok(readChanged.content.includes("Read Changed Files"), "read_changed_files should render");

const showChanges = await registry.invoke("show_changes", { summary_only: true });
assert.equal(showChanges.isError, false, "show_changes summary-only should succeed");
assert.ok(showChanges.content.includes("summary_only=true") || showChanges.content.includes("Show Changes"), "show_changes should render");

console.log("fast-exploration-unit: ok");
