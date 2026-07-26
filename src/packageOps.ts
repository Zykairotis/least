import path from "node:path";
import fs from "node:fs";
import type { LeastConfig, PackageScriptToolsConfig } from "./config.js";
import { LeastError, type Workspace } from "./guard.js";
import { PathGuard } from "./guard.js";
import { runCappedProcess } from "./processRunner.js";
import { redactSensitiveText } from "./redact.js";

export type PackageManager = "pnpm" | "npm" | "yarn";

export interface RunPackageScriptInput {
  packageManager?: PackageManager;
  filter?: string;
  script: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
}

export interface PackageRunResult {
  command: string;
  argv: string[];
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}

const SCRIPT_NAME_RE = /^[A-Za-z0-9:_@./-]{1,128}$/;
const FILTER_RE = /^[A-Za-z0-9:_@./-]{1,200}$/;
const ARG_RE = /^[A-Za-z0-9_@./:=+,-]{1,500}$/;

export function packageScriptToolsFromConfig(config: LeastConfig): PackageScriptToolsConfig {
  return config.packageScriptTools;
}

export function assertSafeArg(value: string, label: string): string {
  if (value.includes("\0")) {
    throw new LeastError(`${label} contains a null byte.`);
  }
  if (/[\r\n]/.test(value)) {
    throw new LeastError(`${label} cannot contain newlines.`);
  }
  return value;
}

export function buildPackageScriptArgv(input: RunPackageScriptInput, settings: PackageScriptToolsConfig): {
  command: string;
  args: string[];
  display: string;
} {
  const manager = (input.packageManager ?? "pnpm") as PackageManager;
  if (!settings.allowedManagers.includes(manager)) {
    throw new LeastError(
      `Package manager not allowed: ${manager}. Allowed: ${settings.allowedManagers.join(", ")}`
    );
  }

  const script = assertSafeArg(input.script.trim(), "script");
  if (!SCRIPT_NAME_RE.test(script)) {
    throw new LeastError(`Invalid script name: ${JSON.stringify(input.script)}`);
  }

  const filter = input.filter?.trim();
  if (filter) {
    assertSafeArg(filter, "filter");
    if (!FILTER_RE.test(filter)) {
      throw new LeastError(`Invalid filter: ${JSON.stringify(input.filter)}`);
    }
  }

  const extraArgs = (input.args ?? []).map((arg, index) => {
    const value = assertSafeArg(String(arg), `args[${index}]`);
    if (!ARG_RE.test(value) && !value.startsWith("--")) {
      // Allow common flag forms; reject shell metacharacters.
      if (/[;&|<>`$(){}]/.test(value)) {
        throw new LeastError(`Unsafe arg rejected: ${JSON.stringify(arg)}`);
      }
    }
    if (/[;&|<>`$()]/.test(value)) {
      throw new LeastError(`Unsafe arg rejected: ${JSON.stringify(arg)}`);
    }
    return value;
  });

  const args: string[] = [];
  if (manager === "pnpm") {
    if (filter) {
      args.push("--filter", filter, script, ...extraArgs);
    } else {
      args.push("run", script, ...extraArgs);
    }
  } else if (manager === "npm") {
    if (filter) {
      throw new LeastError("npm does not support filter in run_package_script. Use pnpm or yarn workspaces.");
    }
    args.push("run", script, ...extraArgs);
  } else {
    // yarn
    if (filter) {
      args.push("workspace", filter, "run", script, ...extraArgs);
    } else {
      args.push("run", script, ...extraArgs);
    }
  }

  const display = [manager, ...args].join(" ");
  return { command: manager, args, display };
}

export async function runPackageScript(
  config: LeastConfig,
  guard: PathGuard,
  workspace: Workspace,
  input: RunPackageScriptInput
): Promise<PackageRunResult> {
  const settings = packageScriptToolsFromConfig(config);
  if (!settings.enabled) {
    throw new LeastError("Package script tools are disabled.");
  }

  const { command, args, display } = buildPackageScriptArgv(input, settings);
  const cwdRel = input.cwd?.trim() || ".";
  const resolved = guard.resolve(workspace, cwdRel);
  if (!fs.existsSync(resolved.absPath) || !fs.statSync(resolved.absPath).isDirectory()) {
    throw new LeastError(`cwd is not a directory: ${cwdRel}`);
  }

  const timeoutMs = Math.max(1_000, Math.min(input.timeoutMs ?? settings.defaultTimeoutMs, 3_600_000));
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const result = await runCappedProcess({
      command,
      args,
      cwd: resolved.absPath,
      maxOutputBytes: config.maxOutputBytes,
      allowNonZeroExit: true,
      signal: controller.signal,
      backend: "package-script"
    });
    return {
      command: display,
      argv: [command, ...args],
      cwd: resolved.absPath,
      exitCode: result.code,
      signal: result.signal,
      durationMs: Date.now() - started,
      stdout: redactSensitiveText(result.stdout),
      stderr: redactSensitiveText(result.stderr),
      truncated: result.truncated,
      timedOut: result.timedOut || controller.signal.aborted
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new LeastError(`run_package_script failed: ${message}`);
  } finally {
    clearTimeout(timer);
  }
}

export function formatPackageRunText(title: string, result: PackageRunResult): string {
  const combined = `${result.stdout || ""}${result.stderr ? `\n${result.stderr}` : ""}`.trimEnd();
  return [
    `# ${title}`,
    "",
    `\`\`\`bash`,
    `$ ${result.command}`,
    "```",
    "",
    `CWD: ${result.cwd}`,
    `Exit: ${result.exitCode}${result.signal ? ` (${result.signal})` : ""}`,
    `Duration: ${result.durationMs} ms`,
    result.timedOut ? "Timed out: true" : "",
    result.truncated ? "Output truncated: true" : "",
    "",
    "## output",
    "",
    "```text",
    combined || "(empty)",
    "```"
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export function resolveWorkspaceRelative(workspace: Workspace, relPath: string): string {
  return path.resolve(workspace.root, relPath);
}
