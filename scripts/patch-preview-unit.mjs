import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../dist/config.js";
import { PathGuard, WorkspaceManager } from "../dist/guard.js";
import { applyWorkspacePatch, previewWorkspacePatch } from "../dist/patchOps.js";
import { commitFileTransaction } from "../dist/fileTransaction.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "least-patch-preview-"));
await fs.writeFile(path.join(root, "a.txt"), "one\ntwo\nthree\n", "utf8");

const config = loadConfig(["--root", root, "--allow-root", root]);
const guard = new PathGuard(config);
const workspace = new WorkspaceManager(config).openWorkspace(root);

const valid = await previewWorkspacePatch(config, guard, workspace, `*** Begin Patch
*** Update File: a.txt
@@
 one
-two
+TWO
 three
*** End Patch`);

assert.deepEqual(valid.changedFiles, ["a.txt"]);
assert.equal(valid.preview["a.txt"], "one\nTWO\nthree\n");
assert.deepEqual(valid.conflicts, []);
assert.equal(await fs.readFile(path.join(root, "a.txt"), "utf8"), "one\ntwo\nthree\n");

await fs.writeFile(path.join(root, "repeated.txt"), "section one\ntarget\nkeep\nsection two\ntarget\nkeep\n", "utf8");
const ambiguous = await previewWorkspacePatch(config, guard, workspace, `*** Begin Patch
*** Update File: repeated.txt
@@
-target
+CHANGED
 keep
*** End Patch`);
assert.equal(ambiguous.changedFiles.length, 0, "ambiguous hunk must not select the first match");
assert.match(ambiguous.conflicts[0] ?? "", /ambiguous/);

const disambiguated = await previewWorkspacePatch(config, guard, workspace, `*** Begin Patch
*** Update File: repeated.txt
@@
 section two
-target
+CHANGED
 keep
*** End Patch`);
assert.equal(disambiguated.preview["repeated.txt"], "section one\ntarget\nkeep\nsection two\nCHANGED\nkeep\n");

const oversized = path.join(root, "oversized.txt");
await fs.writeFile(oversized, "x".repeat(config.maxWriteBytes + 1), "utf8");
await assert.rejects(
  applyWorkspacePatch(config, guard, workspace, `*** Begin Patch
*** Delete File: oversized.txt
*** End Patch`, { checkOnly: true, diffMode: "none" }),
  /too large/
);
assert.equal((await fs.stat(oversized)).size, config.maxWriteBytes + 1);
const oversizedPreview = await previewWorkspacePatch(config, guard, workspace, `*** Begin Patch
*** Update File: oversized.txt
@@
-x
+y
*** End Patch`);
assert.equal(oversizedPreview.changedFiles.length, 0);
assert.match(oversizedPreview.conflicts[0] ?? "", /too large/);

const bad = await previewWorkspacePatch(config, guard, workspace, `*** Begin Patch
*** Update File: a.txt
@@
 missing
-two
+TWO
*** End Patch`);

assert.equal(bad.changedFiles.length, 0);
assert.equal(bad.conflicts.length, 1);

await assert.rejects(
  applyWorkspacePatch(config, guard, workspace, `*** Begin Patch
*** Add File: a.txt
+overwrite
*** End Patch`),
  /overwrite existing/
);
assert.equal(await fs.readFile(path.join(root, "a.txt"), "utf8"), "one\ntwo\nthree\n");

const first = path.join(root, "first.txt");
const invalidTarget = path.join(root, "missing", "second.txt");
await fs.writeFile(first, "before\n", "utf8");
await fs.mkdir(path.dirname(invalidTarget), { recursive: true });
await fs.mkdir(invalidTarget);
await assert.rejects(commitFileTransaction([
  { type: "write", absPath: first, content: "after\n" },
  { type: "write", absPath: invalidTarget, content: "fail\n" }
]));
assert.equal(await fs.readFile(first, "utf8"), "before\n", "failed transaction must not alter files");

console.log("patch-preview-unit: ok");
