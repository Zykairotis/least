#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { refreshGroundcrewWindowsPath } from "./ensure-windows-agent-path.mjs";

refreshGroundcrewWindowsPath();

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  console.log(`Least agent CLI bridge

Usage:
  node scripts/least-agent-cli.mjs doctor
  node scripts/least-agent-cli.mjs list
  node scripts/least-agent-cli.mjs plan --agent oh-my-pi --repository least --prompt "Inspect only"
  node scripts/least-agent-cli.mjs start --agent oh-my-pi --repository least --prompt "Inspect only"
  node scripts/least-agent-cli.mjs start --root X:\\SamplePrk --agent oh-my-pi --prompt "Work in this folder"
  node scripts/least-agent-cli.mjs status --job-id <job>
  node scripts/least-agent-cli.mjs tail --job-id <job> --lines 40
  node scripts/least-agent-cli.mjs attach-hint --job-id <job>
  node scripts/least-agent-cli.mjs result --job-id <job> --include-tail --tail-lines 40
  node scripts/least-agent-cli.mjs cleanup --dry-run --older-than 7d

Options:
  --root <dir>              Target workspace root. Default: current directory. Can be outside the Least install.
  --workspace-id <id>       Stable workspace id override. Default: sanitized folder name.
  --repository <name>       Repository label. Default: target folder name. Unregistered labels run as direct-folder jobs.
  --agent <name>            Agent profile name, for example oh-my-pi or grok-build.
  --title <text>            Optional human title for the job.
  --prompt <text>           Agent prompt.
  --task-id <id>            Durable task id.
  --idempotency-key <id>    Durable idempotency key.
  --job-id <id>             Existing job id for status/tail/result/attach-hint/cleanup.
  --lines <n>               Tail line count. Default: 40.
  --tail-lines <n>          Result tail line count. Default: 40.
  --timeout-ms <ms>         Job timeout. Default: 3600000.
  --idle-timeout-ms <ms>    Idle timeout. Default: 900000.
  --startup-wait-ms <ms>    Optional wait-for-launch budget.
  --wait-for-launch         Wait briefly for startup progress before returning.
  --include-tail            Include tail output in result.
  --include-diff            Include diff summary in result.
  --enforce-timeouts        Enforce timeout checks in status.
  --fresh                   Use fresh Groundcrew resume mode.
  --dry-run                 Do not remove anything during cleanup.
  --older-than <value>      Cleanup filter, for example 7d or 2026-06-28T00:00:00Z.
  --format <json|text>      Output format. Default: json.
  --help                    Show this message.
`);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith("--")) {
      out._.push(raw);
      continue;
    }
    const key = raw.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

function requireString(args, key, message) {
  const value = args[key];
  if (typeof value === "string" && value.trim()) return value.trim();
  throw new Error(message);
}

function optionalString(args, key) {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalNumber(args, key) {
  const value = args[key];
  if (value === undefined || value === true) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} must be numeric.`);
  return parsed;
}

function boolFlag(args, key) {
  return args[key] === true;
}

function sanitizeWorkspaceId(root, explicit) {
  if (explicit && explicit.trim()) return explicit.trim();
  const base = path.basename(root).trim() || "workspace";
  return base.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
}

function resolveWorkspace(args) {
  const inputRoot = typeof args.root === "string" ? args.root : process.cwd();
  const root = fs.realpathSync(path.resolve(inputRoot));
  return {
    id: sanitizeWorkspaceId(root, optionalString(args, "workspaceId")),
    root,
    name: path.basename(root) || root,
    createdAt: new Date().toISOString()
  };
}

function defaultRepository(workspace, args) {
  return optionalString(args, "repository") ?? workspace.name;
}

function buildSharedInput(workspace, args) {
  return {
    workspaceId: workspace.id,
    workspaceRoot: workspace.root,
    repository: defaultRepository(workspace, args),
    taskId: optionalString(args, "taskId"),
    idempotencyKey: optionalString(args, "idempotencyKey")
  };
}

function emit(result, format) {
  if (format === "text") {
    console.log(result.text);
    return;
  }
  console.log(JSON.stringify(result, null, 2));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = String(args._[0] ?? "").trim().toLowerCase();
  if (!command || command === "help" || boolFlag(args, "help")) {
    usage();
    return;
  }

  const format = optionalString(args, "format") ?? "json";
  if (!["json", "text"].includes(format)) {
    throw new Error("--format must be json or text.");
  }

  const workspace = resolveWorkspace(args);
  const shared = buildSharedInput(workspace, args);
  const agentOps = await import("../dist/agentOps.js");
  const agentLifecycle = await import("../dist/agentLifecycle.js");

  switch (command) {
    case "doctor":
      emit(await agentOps.agentDoctor(workspace), format);
      return;
    case "list":
      emit(await agentOps.agentList(), format);
      return;
    case "plan": {
      const input = {
        ...shared,
        agent: requireString(args, "agent", "plan requires --agent."),
        title: optionalString(args, "title"),
        prompt: requireString(args, "prompt", "plan requires --prompt."),
        timeoutMs: optionalNumber(args, "timeoutMs"),
        idleTimeoutMs: optionalNumber(args, "idleTimeoutMs")
      };
      emit(agentOps.agentPlan(input), format);
      return;
    }
    case "start": {
      const input = {
        ...shared,
        agent: requireString(args, "agent", "start requires --agent."),
        title: optionalString(args, "title"),
        prompt: requireString(args, "prompt", "start requires --prompt."),
        timeoutMs: optionalNumber(args, "timeoutMs"),
        idleTimeoutMs: optionalNumber(args, "idleTimeoutMs"),
        waitForLaunch: boolFlag(args, "waitForLaunch"),
        startupWaitMs: optionalNumber(args, "startupWaitMs")
      };
      emit(await agentOps.agentStart(workspace, input), format);
      return;
    }
    case "status": {
      const input = {
        ...shared,
        jobId: optionalString(args, "jobId"),
        taskId: optionalString(args, "taskId"),
        enforceTimeouts: boolFlag(args, "enforceTimeouts")
      };
      if (!input.jobId && !input.taskId) throw new Error("status requires --job-id or --task-id.");
      emit(await agentOps.agentStatus(workspace, input), format);
      return;
    }
    case "tail": {
      const input = {
        ...shared,
        jobId: optionalString(args, "jobId"),
        taskId: optionalString(args, "taskId"),
        lines: optionalNumber(args, "lines") ?? 40
      };
      if (!input.jobId && !input.taskId) throw new Error("tail requires --job-id or --task-id.");
      emit(await agentOps.agentTail(workspace, input), format);
      return;
    }
    case "attach-hint":
    case "attach_hint": {
      const input = {
        ...shared,
        jobId: optionalString(args, "jobId"),
        taskId: optionalString(args, "taskId")
      };
      if (!input.jobId && !input.taskId) throw new Error("attach-hint requires --job-id or --task-id.");
      emit(await agentOps.agentAttachHint(workspace, input), format);
      return;
    }
    case "result": {
      const input = {
        ...shared,
        jobId: optionalString(args, "jobId"),
        taskId: optionalString(args, "taskId"),
        includeDiff: boolFlag(args, "includeDiff"),
        includeTail: boolFlag(args, "includeTail"),
        tailLines: optionalNumber(args, "tailLines") ?? 40
      };
      if (!input.jobId && !input.taskId) throw new Error("result requires --job-id or --task-id.");
      emit(await agentOps.agentResult(workspace, input), format);
      return;
    }
    case "cancel": {
      const input = {
        ...shared,
        jobId: optionalString(args, "jobId"),
        taskId: optionalString(args, "taskId")
      };
      if (!input.jobId && !input.taskId) throw new Error("cancel requires --job-id or --task-id.");
      emit(await agentOps.agentCancel(workspace, input), format);
      return;
    }
    case "resume": {
      const input = {
        ...shared,
        jobId: optionalString(args, "jobId"),
        taskId: optionalString(args, "taskId"),
        fresh: boolFlag(args, "fresh")
      };
      if (!input.jobId && !input.taskId) throw new Error("resume requires --job-id or --task-id.");
      emit(await agentLifecycle.agentResume(workspace, input), format);
      return;
    }
    case "cleanup": {
      const input = {
        ...shared,
        jobId: optionalString(args, "jobId"),
        taskId: optionalString(args, "taskId"),
        dryRun: boolFlag(args, "dryRun"),
        olderThan: optionalString(args, "olderThan")
      };
      emit(await agentLifecycle.agentCleanup(workspace, input), format);
      return;
    }
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  if (process.env.LEAST_DEBUG === "1" && error instanceof Error && error.stack) {
    console.error(error.stack);
  }
  process.exit(1);
});
