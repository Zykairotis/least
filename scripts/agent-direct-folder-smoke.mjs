import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "least-direct-folder-"));
const home = await fs.mkdtemp(path.join(os.tmpdir(), "least-direct-home-"));
const agentScript = path.join(root, "direct-agent.mjs");
await fs.mkdir(path.join(root, ".least"), { recursive: true });
await fs.writeFile(agentScript, [
  "import fs from 'node:fs/promises';",
  "import path from 'node:path';",
  "const prompt = process.argv.slice(2).join(' ');",
  "await fs.writeFile(path.join(process.cwd(), 'direct-agent-output.txt'), prompt + '\\n', 'utf8');",
  "console.log('DIRECT_FOLDER_SMOKE_OK');"
].join("\n"), "utf8");
await fs.writeFile(path.join(root, ".least", "agents.local.jsonc"), JSON.stringify({
  agents: {
    "direct-smoke": {
      provider: "custom",
      command: ["node", agentScript],
      promptVia: "positional",
      enabled: true
    }
  }
}, null, 2), "utf8");

function runCli(args) {
  const result = spawnSync(process.execPath, ["scripts/least-agent-cli.mjs", ...args], {
    cwd: path.resolve("."),
    env: { ...process.env, LEAST_HOME: home },
    encoding: "utf8",
    timeout: 30_000
  });
  if (result.status !== 0) {
    throw new Error(`agent CLI failed: node scripts/least-agent-cli.mjs ${args.join(" ")}\nstatus: ${result.status}\nerror: ${result.error?.message ?? "(none)"}\nstdout:\n${result.stdout ?? ""}\nstderr:\n${result.stderr ?? ""}`);
  }
  const parsed = JSON.parse(result.stdout);
  return parsed.structured ?? parsed;
}

const start = runCli([
  "start",
  "--root",
  root,
  "--agent",
  "direct-smoke",
  "--prompt",
  "write into the target folder",
  "--wait-for-launch",
  "--startup-wait-ms",
  "2000"
]);

if (start.repository !== path.basename(root)) {
  throw new Error(`expected repository to default to target folder name, got ${start.repository}`);
}
if (start.worktree_dir !== root) {
  throw new Error(`expected direct launch worktree_dir to be target root, got ${start.worktree_dir}`);
}
if (start.state !== "running" && start.state !== "completed") {
  throw new Error(`expected direct launch running/completed, got ${start.state}`);
}

let status;
for (let i = 0; i < 20; i += 1) {
  status = runCli(["status", "--root", root, "--job-id", start.job_id]);
  if (status.state === "completed") break;
  await new Promise((resolve) => setTimeout(resolve, 250));
}

if (status?.state !== "completed") {
  throw new Error(`direct folder job did not complete: ${JSON.stringify(status, null, 2)}`);
}

const output = await fs.readFile(path.join(root, "direct-agent-output.txt"), "utf8");
if (!output.includes("write into the target folder")) {
  throw new Error(`direct agent did not run in target folder; output was ${output}`);
}

const result = runCli(["result", "--root", root, "--job-id", start.job_id, "--include-tail"]);
if (!JSON.stringify(result).includes("DIRECT_FOLDER_SMOKE_OK")) {
  throw new Error(`direct folder result did not include captured output: ${JSON.stringify(result, null, 2)}`);
}

console.log("agent direct folder smoke test passed");
