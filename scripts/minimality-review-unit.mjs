import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../dist/config.js";
import { PathGuard, WorkspaceManager } from "../dist/guard.js";
import { reviewMinimality } from "../dist/minimalityOps.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "least-minimality-"));
await fs.mkdir(path.join(root, "src"), { recursive: true });
await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: { uuid: "9.0.0" } }), "utf8");
await fs.writeFile(path.join(root, "src", "big.ts"), `${"export function f() {\n".repeat(40)}}`, "utf8");
spawnSync("git", ["init"], { cwd: root, stdio: "ignore" });
spawnSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
await fs.writeFile(path.join(root, "src", "unused.ts"), `export function UnusedFeature() {\n${"  return 1;\n".repeat(42)}}\n`, "utf8");

const config = loadConfig(["--root", root, "--allow-root", root]);
const guard = new PathGuard(config);
const workspaces = new WorkspaceManager(config);
const workspace = workspaces.openWorkspace(root);

const result = await reviewMinimality(config, guard, workspace, { maxFindings: 5 });
assert.ok(result.findings.length >= 1, "should flag at least one finding");
assert.match(result.text, /Heuristic minimality review/i);
assert.ok(result.findings.some((finding) => finding.title === "New file likely dead-on-arrival"), "should flag unreferenced new exported file");

console.log("minimality-review-unit: ok");
