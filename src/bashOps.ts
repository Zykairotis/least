import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { LeastConfig, ShellBackend } from "./config.js";
import { resolvePowerShellCommand } from "./commandCaps.js";
import type { Workspace } from "./guard.js";
import { LeastError, PathGuard } from "./guard.js";
import { redactSensitiveText } from "./redact.js";

export interface BashResult {
  command: string;
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}

const SAFE_ALLOWED_PREFIXES = [
  "pwd",
  "ls",
  "find",
  "git status",
  "git diff",
  "git log",
  "git show",
  "git branch",
  "git rev-parse",
  "git ls-files",
  "npm test",
  "npm run test",
  "npm run typecheck",
  "npm run lint",
  "npm run build",
  "npm run check",
  "pnpm test",
  "pnpm run test",
  "pnpm run typecheck",
  "pnpm run lint",
  "pnpm run build",
  "pnpm run check",
  "yarn test",
  "yarn run test",
  "yarn run typecheck",
  "yarn run lint",
  "yarn run build",
  "yarn run check",
  "bun test",
  "bun run test",
  "bun run typecheck",
  "bun run lint",
  "bun run build",
  "pytest",
  "python -m pytest",
  "python3 -m pytest",
  "uv run pytest",
  "go test",
  "cargo test",
  "cargo check",
  "cargo clippy",
  "tsc",
  "npx tsc",
  "eslint",
  "npx eslint",
  "biome check",
  "npx biome check"
];

const READONLY_ALLOWED_PREFIXES = [
  "pwd",
  "ls",
  "find",
  "git status",
  "git diff",
  "git log",
  "git show",
  "git branch",
  "git rev-parse",
  "git ls-files",
  "cat",
  "type",
  "grep",
  "rg",
  "fd",
  "jq",
  "yq",
  "head",
  "tail",
  "wc",
  "sed",
  "awk",
  "bat",
  "tree",
  "node -v",
  "node --version",
  "npm -v",
  "npm --version",
  "pnpm -v",
  "pnpm --version",
  "yarn -v",
  "yarn --version",
  "python --version",
  "python3 --version"
];

const READONLY_BLOCKED_PATTERNS = [
  /(^|\s)rm\s+/,
  /(^|\s)mv\s+/,
  /(^|\s)cp\s+/,
  /(^|\s)dd\s+/,
  /(^|\s)sudo\s+/,
  /(^|\s)chmod\s+/,
  /(^|\s)chown\s+/,
  /(^|\s)kill\s+/,
  /(^|\s)pkill\s+/,
  /(^|\s)curl\s+/,
  /(^|\s)wget\s+/,
  /(^|\s)ssh\s+/,
  /(^|\s)scp\s+/,
  /(^|\s)rsync\s+/,
  /(^|\s)docker\s+/,
  /(^|\s)podman\s+/,
  /(^|\s)git\s+push\b/,
  /(^|\s)git\s+reset\b/,
  /(^|\s)git\s+clean\b/,
  /(^|\s)git\s+checkout\b/,
  /(^|\s)git\s+switch\b/,
  /(^|\s)git\s+restore\b/,
  /(^|\s)(npm|pnpm|yarn|bun)\s+/,
  /(^|\s)pytest\b/,
  /(^|\s)python\s+-m\s+pytest\b/,
  /(^|\s)go\s+test\b/,
  /(^|\s)cargo\s+/,
  /(^|\s)tsc\b/,
  /(^|\s)eslint\b/,
  /(^|\s)--no-index\b/,
  /(^|\s)--fix\b/,
  /(^|\s)(\/|~(?:\/|\s|$))/,
  /(^|\s)\.\.(?:\/|\s|$)/,
  /\$(?:[A-Za-z_][A-Za-z0-9_]*|\{|\[)/,
  /(^|[\s:])(?:\.env(?:[./\s:]|$)|\.git(?:[\/\s:]|$)|node_modules(?:[\/\s:]|$)|\.ssh(?:[\/\s:]|$)|id_rsa(?:[.\s:]|$)|id_ed25519(?:[.\s:]|$)|[^\s:]*\.(?:pem|key)(?:[\s:]|$))/,
  /(^|\s)-exec\b/,
  /(^|\s)-execdir\b/,
  /(^|\s)-delete\b/,
  /(^|\s)-ok\b/,
  /(^|\s)-okdir\b/,
  /(^|\s)-fprint\b/,
  /(^|\s)-fprintf\b/,
  /(^|\s)-fls\b/,
  /(^|\s)(sed|perl)\s+.*(^|\s)-i(\s|$)/,
  /[;&|<>`]/,
  /\$\(/,
  /\n/
];

const SAFE_BLOCKED_PATTERNS = [
  /(^|\s)rm\s+/,
  /(^|\s)mv\s+/,
  /(^|\s)cp\s+/,
  /(^|\s)dd\s+/,
  /(^|\s)sudo\s+/,
  /(^|\s)chmod\s+/,
  /(^|\s)chown\s+/,
  /(^|\s)kill\s+/,
  /(^|\s)pkill\s+/,
  /(^|\s)curl\s+/,
  /(^|\s)wget\s+/,
  /(^|\s)ssh\s+/,
  /(^|\s)scp\s+/,
  /(^|\s)rsync\s+/,
  /(^|\s)docker\s+/,
  /(^|\s)podman\s+/,
  /(^|\s)git\s+push\b/,
  /(^|\s)git\s+reset\b/,
  /(^|\s)git\s+clean\b/,
  /(^|\s)git\s+checkout\b/,
  /(^|\s)git\s+switch\b/,
  /(^|\s)git\s+restore\b/,
  /(^|\s)(npm|pnpm|yarn)\s+publish\b/,
  /(^|\s)--no-index\b/,
  /(^|\s)--fix\b/,
  /(^|\s)(\/|~(?:\/|\s|$))/,
  /(^|\s)\.\.(?:\/|\s|$)/,
  /\$(?:[A-Za-z_][A-Za-z0-9_]*|\{|\[)/,
  /(^|[\s:])(?:\.env(?:[./\s:]|$)|\.git(?:[\/\s:]|$)|node_modules(?:[\/\s:]|$)|\.ssh(?:[\/\s:]|$)|id_rsa(?:[.\s:]|$)|id_ed25519(?:[.\s:]|$)|[^\s:]*\.(?:pem|key)(?:[\s:]|$))/,
  /(^|\s)-exec\b/,
  /(^|\s)-execdir\b/,
  /(^|\s)-delete\b/,
  /(^|\s)-ok\b/,
  /(^|\s)-okdir\b/,
  /(^|\s)-fprint\b/,
  /(^|\s)-fprintf\b/,
  /(^|\s)-fls\b/,
  /(^|\s)(sed|perl)\s+.*(^|\s)-i(\s|$)/,
  /(^|\s)(cat|grep|rg|head|tail|wc)\s+/,
  /[;&|<>`]/,
  /\$\(/,
  /\n/
];

function compact(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

const BASH_READ_ONLY_PREFIXES = [
  "pwd",
  "ls",
  "find",
  "git status",
  "git diff",
  "git log",
  "git show",
  "git branch",
  "git rev-parse",
  "git ls-files"
];

/** Whether bash requires workspace mutation lock under lease concurrency mode. */
export function bashRequiresMutationLock(config: LeastConfig, command: string): boolean {
  if (config.bashMode === "off") return false;
  const normalized = compact(command);
  if (config.bashMode === "readonly" || config.bashMode === "full") {
    const readonlyPrefix = READONLY_ALLOWED_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix} `));
    const blockedReadonlyShape = READONLY_BLOCKED_PATTERNS.some((pattern) => pattern.test(normalized));
    return !readonlyPrefix || blockedReadonlyShape;
  }
  return !BASH_READ_ONLY_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix} `));
}

function startsWithAllowedPrefix(command: string, config: LeastConfig): boolean {
  const normalized = compact(command);
  const effectiveMode = config.yoloMode ? "full" : config.bashMode;
  if (effectiveMode === "readonly") {
    return READONLY_ALLOWED_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix} `));
  }
  return isAllowedPackageScript(normalized) || SAFE_ALLOWED_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix} `));
}

function isAllowedPackageScript(command: string): boolean {
  const packageScriptPattern =
    /^(?:npm|pnpm|yarn|bun)\s+run\s+(?:test|typecheck|lint|build|check)(?::[A-Za-z0-9._-]+)*(?:\s+--\s+[A-Za-z0-9._:= -]+)?$/;
  return packageScriptPattern.test(command);
}

function assertSafeCommand(config: LeastConfig, command: string): void {
  if (config.bashMode === "off") {
    throw new LeastError(
      "bash tool is disabled. Start with LEAST_BASH_MODE=safe, LEAST_BASH_MODE=readonly, or LEAST_BASH_MODE=full to enable it."
    );
  }
  const effectiveMode = config.yoloMode ? "full" : config.bashMode;
  if (effectiveMode === "full") return;

  const normalized = compact(command);
  const blockedPatterns = effectiveMode === "readonly" ? READONLY_BLOCKED_PATTERNS : SAFE_BLOCKED_PATTERNS;
  for (const pattern of blockedPatterns) {
    if (pattern.test(normalized)) {
      throw new LeastError(
        `Command is blocked in LEAST_BASH_MODE=${effectiveMode}: ${normalized}\n` +
          (effectiveMode === "readonly"
            ? "Readonly bash allows inspection commands only. Use LEAST_BASH_MODE=safe for test/build scripts or LEAST_BASH_MODE=full for trusted automation."
            : "Use separate read/search/git tools, or restart with LEAST_BASH_MODE=readonly or LEAST_BASH_MODE=full only for trusted repos.")
      );
    }
  }
  if (!startsWithAllowedPrefix(normalized, config)) {
    throw new LeastError(
      effectiveMode === "readonly"
        ? `Command is not in the readonly bash allowlist: ${normalized}\n` +
            "Allowed examples: ls, find, git status, git diff, git ls-files, rg, head, tail, cat, grep. Use LEAST_BASH_MODE=safe for test/build scripts or LEAST_BASH_MODE=full for trusted automation."
        : `Command is not in the safe bash allowlist: ${normalized}\n` +
            "Allowed examples: ls, find, git status, git diff, npm test, npm run typecheck, npm run build:clients, pytest, go test, cargo test. Use read/search tools for file contents. " +
            "Use LEAST_BASH_MODE=readonly for terminal-style inspection or LEAST_BASH_MODE=full for trusted local automation."
    );
  }
}

function makeEnv(config: LeastConfig): NodeJS.ProcessEnv {
  if (config.inheritEnv) {
    return { ...process.env, NO_COLOR: "1", CI: process.env.CI ?? "1" };
  }
  if (process.platform === "win32") {
    return {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? process.env.USERPROFILE ?? "",
      USERPROFILE: process.env.USERPROFILE ?? "",
      SystemRoot: process.env.SystemRoot ?? "",
      ComSpec: process.env.ComSpec ?? "cmd.exe",
      PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
      TEMP: process.env.TEMP ?? process.env.TMP ?? "",
      TMP: process.env.TMP ?? process.env.TEMP ?? "",
      NO_COLOR: "1",
      CI: "1"
    };
  }
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME ?? "",
    USER: process.env.USER ?? "",
    SHELL: process.env.SHELL ?? "/bin/bash",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    TERM: "dumb",
    NO_COLOR: "1",
    CI: "1"
  };
}

function windowsPathToWsl(winPath: string): string {
  const normalized = path.resolve(winPath).replace(/\\/g, "/");
  const match = normalized.match(/^([A-Za-z]):\/(.*)$/);
  if (!match) return normalized.replace(/'/g, `'\\''`);
  const drive = match[1].toLowerCase();
  const rest = match[2];
  return `/mnt/${drive}/${rest}`.replace(/'/g, `'\\''`);
}

async function shellSpec(config: LeastConfig, cwd?: string): Promise<{ command: string; args: string[]; wrapCommand?: (command: string) => string }> {
  const backend: ShellBackend =
    config.shellBackend === "auto" ? (process.platform === "win32" ? "cmd" : "bash") : config.shellBackend;

  switch (backend) {
    case "powershell": {
      const ps = await resolvePowerShellCommand();
      return {
        command: ps,
        args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]
      };
    }
    case "cmd":
      return { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c"] };
    case "bash":
      return { command: fs.existsSync("/bin/bash") ? "/bin/bash" : "bash", args: ["-lc"] };
    case "wsl": {
      const wslCwd = cwd ? windowsPathToWsl(cwd) : undefined;
      return {
        command: "wsl.exe",
        args: ["bash", "-lc"],
        wrapCommand: (command: string) => (wslCwd ? `cd '${wslCwd}' && ${command}` : command)
      };
    }
    default:
      return { command: fs.existsSync("/bin/bash") ? "/bin/bash" : "bash", args: ["-lc"] };
  }
}

function trimOutput(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= maxBytes) return { value, truncated: false };
  const sliced = buffer.subarray(0, maxBytes).toString("utf8");
  return { value: `${sliced}\n...[output truncated to ${maxBytes} bytes]`, truncated: true };
}

export async function runBash(
  config: LeastConfig,
  guard: PathGuard,
  workspace: Workspace,
  command: string,
  options: { cwd?: string; timeoutMs?: number } = {}
): Promise<BashResult> {
  if (!command?.trim()) throw new LeastError("command is required.");
  assertSafeCommand(config, command);
  const cwdResolved = guard.resolve(workspace, options.cwd ?? ".");
  const cwd = cwdResolved.absPath;
  const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? 30_000, 180_000));
  const start = Date.now();

  return new Promise((resolve, reject) => {
    void (async () => {
    const shell = await shellSpec(config, cwd);
    const effectiveCommand = shell.wrapCommand ? shell.wrapCommand(command) : command;
    const child = spawn(shell.command, [...shell.args, effectiveCommand], {
      cwd,
      env: makeEnv(config),
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let killedByTimeout = false;

    const timer = setTimeout(() => {
      killedByTimeout = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 1_500).unref();
    }, timeoutMs);
    timer.unref();

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (Buffer.byteLength(stdout, "utf8") > config.maxOutputBytes * 2) child.kill("SIGTERM");
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      if (Buffer.byteLength(stderr, "utf8") > config.maxOutputBytes * 2) child.kill("SIGTERM");
    });
    child.on("error", reject);
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      if (killedByTimeout) {
        stderr += `\n[least] Command timed out after ${timeoutMs} ms.`;
      }
      const out = trimOutput(redactSensitiveText(stdout), config.maxOutputBytes);
      const err = trimOutput(redactSensitiveText(stderr), config.maxOutputBytes);
      resolve({
        command,
        cwd: path.relative(workspace.root, cwd) || ".",
        exitCode,
        signal,
        durationMs: Date.now() - start,
        stdout: out.value,
        stderr: err.value,
        truncated: out.truncated || err.truncated,
        timedOut: killedByTimeout
      });
    });
    })().catch(reject);
  });
}
