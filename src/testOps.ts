import type { LeastConfig } from "./config.js";
import { LeastError, PathGuard, type Workspace } from "./guard.js";
import { packageScriptToolsFromConfig, type PackageRunResult } from "./packageOps.js";
import { runCappedProcess } from "./processRunner.js";
import { redactSensitiveText } from "./redact.js";

export interface RunVitestInput {
  packageFilter?: string;
  files?: string[];
  testNamePattern?: string;
  run?: boolean;
  timeoutMs?: number;
  cwd?: string;
}

const FILE_RE = /^[A-Za-z0-9_@./\\-]{1,400}$/;
const FILTER_RE = /^[A-Za-z0-9:_@./-]{1,200}$/;

export function buildVitestArgv(input: RunVitestInput): { command: string; args: string[]; display: string } {
  const filter = input.packageFilter?.trim();
  if (filter) {
    if (!FILTER_RE.test(filter) || /[;&|<>`$()]/.test(filter)) {
      throw new LeastError(`Invalid packageFilter: ${JSON.stringify(input.packageFilter)}`);
    }
  }

  const files = (input.files ?? []).map((file, index) => {
    const value = String(file).trim();
    if (!value || value.includes("\0") || /[\r\n]/.test(value)) {
      throw new LeastError(`Invalid files[${index}]`);
    }
    if (value.startsWith("-") || !FILE_RE.test(value.replace(/\\/g, "/"))) {
      throw new LeastError(`Unsafe or invalid test file path: ${JSON.stringify(file)}`);
    }
    if (value.includes("..")) {
      throw new LeastError(`Test file path must not contain '..': ${JSON.stringify(file)}`);
    }
    return value.replace(/\\/g, "/");
  });

  const args: string[] = [];
  if (filter) {
    args.push("--filter", filter, "exec", "vitest");
  } else {
    args.push("exec", "vitest");
  }

  const shouldRun = input.run !== false;
  if (shouldRun) args.push("run");

  if (input.testNamePattern?.trim()) {
    const pattern = input.testNamePattern.trim();
    if (pattern.includes("\0") || /[\r\n]/.test(pattern) || pattern.length > 200) {
      throw new LeastError("Invalid testNamePattern.");
    }
    args.push("--testNamePattern", pattern);
  }

  args.push(...files);

  const display = ["pnpm", ...args].join(" ");
  return { command: "pnpm", args, display };
}

export async function runVitest(
  config: LeastConfig,
  guard: PathGuard,
  workspace: Workspace,
  input: RunVitestInput
): Promise<PackageRunResult> {
  const settings = packageScriptToolsFromConfig(config);
  if (!settings.enabled) {
    throw new LeastError("Package/test tools are disabled.");
  }
  if (!settings.allowedManagers.includes("pnpm")) {
    throw new LeastError("run_vitest requires pnpm in packageScripts.allowedManagers.");
  }

  const { command, args, display } = buildVitestArgv(input);
  const cwdRel = input.cwd?.trim() || ".";
  const resolved = guard.resolve(workspace, cwdRel);

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
      backend: "vitest"
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
    throw new LeastError(`run_vitest failed: ${message}`);
  } finally {
    clearTimeout(timer);
  }
}
