import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../dist/config.js";
import { WorkspaceManager } from "../dist/guard.js";
import { saveProjectMemory, searchProjectMemory, updateProjectMemory } from "../dist/projectMemory.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "least-memory-"));
const config = loadConfig(["--root", root, "--allow-root", root]);
const workspaces = new WorkspaceManager(config);
const workspace = workspaces.openWorkspace(root);

const saved = await saveProjectMemory(workspace, {
  kind: "command",
  text: "Smoke command is npm run smoke",
  paths: ["package.json"]
});
assert.ok(saved.id);

const hits = await searchProjectMemory(workspace, "smoke", { maxResults: 5 });
assert.equal(hits.length, 1);

const updated = await updateProjectMemory(workspace, saved.id, "Smoke command is npm run build", false);
assert.equal(updated.text, "Smoke command is npm run build");
const afterUpdate = await searchProjectMemory(workspace, "build", { maxResults: 5 });
assert.equal(afterUpdate.length, 1, "in-place update should keep one active record");
assert.equal(afterUpdate[0]?.id, saved.id);

const superseded = await updateProjectMemory(workspace, saved.id, "Preferred smoke command is npm run smoke", true);
assert.notEqual(superseded.id, saved.id);
const afterSupersede = await searchProjectMemory(workspace, "smoke", { maxResults: 5 });
assert.equal(afterSupersede.length, 1);
assert.equal(afterSupersede[0]?.id, superseded.id);
assert.equal(afterSupersede[0]?.text, "Preferred smoke command is npm run smoke");

console.log("project-memory-unit: ok");