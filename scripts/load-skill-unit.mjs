import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../dist/config.js";
import { WorkspaceManager } from "../dist/guard.js";
import { loadSkill } from "../dist/capabilitiesOps.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "least-load-skill-"));
const skillDir = path.join(root, "skills", "demo");
await fs.mkdir(skillDir, { recursive: true });
await fs.writeFile(path.join(skillDir, "SKILL.md"), "# Demo\n\nname: demo\ndescription: test skill\n", "utf8");

const config = loadConfig(["--root", root, "--allow-root", root]);
const workspace = new WorkspaceManager(config).openWorkspace(root);

const byDir = await loadSkill(workspace, config, { name: "demo", path: path.join(skillDir) });
assert.equal(byDir.skill.name, "demo");

const slashPath = path.join(skillDir, "SKILL.md").replace(/\\/g, "/");
const bySlashPath = await loadSkill(workspace, config, { name: "demo", path: slashPath });
assert.equal(bySlashPath.skill.path, "$WORKSPACE/skills/demo/SKILL.md");

console.log("load-skill-unit: ok");
