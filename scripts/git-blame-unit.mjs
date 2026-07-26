import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../dist/config.js";
import { PathGuard, WorkspaceManager } from "../dist/guard.js";
import { formatBlameBlock, gitBlameForRange } from "../dist/gitBlameOps.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "least-blame-"));
await fs.writeFile(path.join(root, "a.txt"), "one\ntwo\nthree\n", "utf8");
spawnSync("git", ["init"], { cwd: root, stdio: "ignore" });
spawnSync("git", ["config", "user.email", "least@example.test"], { cwd: root, stdio: "ignore" });
spawnSync("git", ["config", "user.name", "Least Test"], { cwd: root, stdio: "ignore" });
spawnSync("git", ["add", "a.txt"], { cwd: root, stdio: "ignore" });
spawnSync("git", ["commit", "-m", "initial"], { cwd: root, stdio: "ignore" });

const config = loadConfig(["--root", root, "--allow-root", root]);
const guard = new PathGuard(config);
const workspace = new WorkspaceManager(config).openWorkspace(root);
const blame = await gitBlameForRange(config, guard, workspace, "a.txt", 1, 3);

assert.equal(blame.length, 3);
assert.ok(blame.every((line) => /^[0-9a-f]{8}$/i.test(line.sha)));
assert.match(formatBlameBlock(blame), /blame:/);

console.log("git-blame-unit: ok");
