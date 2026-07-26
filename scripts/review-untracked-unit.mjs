import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../dist/config.js";
import { gitStatus } from "../dist/gitOps.js";
import { PathGuard, WorkspaceManager } from "../dist/guard.js";
import { REVIEW_GIT_STATUS_OPTIONS, expandUntrackedDirectoryEntries, parseGitStatusEntries, readChangedFiles } from "../dist/reviewOps.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "least-review-untracked-"));
await fs.mkdir(path.join(root, "newdir", "nested"), { recursive: true });
await fs.writeFile(path.join(root, "newdir", "a.ts"), "export const a = 1;\n", "utf8");
await fs.writeFile(path.join(root, "newdir", "b.ts"), "export const b = 2;\n", "utf8");
await fs.writeFile(path.join(root, "newdir", "nested", "c.ts"), "export const c = 3;\n", "utf8");
spawnSync("git", ["init"], { cwd: root, stdio: "ignore" });

const config = loadConfig(["--root", root, "--allow-root", root]);
const guard = new PathGuard(config);
const workspaces = new WorkspaceManager(config);
const workspace = workspaces.openWorkspace(root);

const status = await gitStatus(config, workspace, guard, undefined, REVIEW_GIT_STATUS_OPTIONS);
const expanded = await expandUntrackedDirectoryEntries(guard, workspace, parseGitStatusEntries(status));
const paths = expanded.map((entry) => entry.path.replace(/\\/g, "/"));
assert.ok(paths.includes("newdir/a.ts"), `expected newdir/a.ts in expanded status, got ${paths.join(", ")}`);
assert.ok(paths.includes("newdir/b.ts"), `expected newdir/b.ts in expanded status, got ${paths.join(", ")}`);
assert.ok(paths.includes("newdir/nested/c.ts"), `expected nested file in expanded status, got ${paths.join(", ")}`);

const result = await readChangedFiles(config, guard, workspace, status, {
  includeUntracked: true,
  includeStaged: true,
  includeUnstaged: true,
  maxFiles: 20,
  maxBytes: config.maxReadBytes
});
const changed = result.changedFiles.map((p) => p.replace(/\\/g, "/"));
assert.ok(changed.some((p) => p.endsWith("newdir/a.ts")), "read_changed_files should include untracked directory files");
assert.ok(result.files.some((file) => "text" in file && file.path.replace(/\\/g, "/").endsWith("newdir/a.ts")), "read_changed_files should read untracked file contents");

console.log("review-untracked-unit: ok");