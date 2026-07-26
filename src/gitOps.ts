import type { LeastConfig } from "./config.js";
import type { Workspace } from "./guard.js";
import { PathGuard } from "./guard.js";
import { recordBackend, recordCacheOutcome } from "./perf.js";
import { runCappedProcess } from "./processRunner.js";
import { redactSensitiveText } from "./redact.js";
import { getCachedGitValue, setCachedGitValue } from "./workspaceCache.js";

async function runGit(workspace: Workspace, args: string[], maxOutputBytes: number): Promise<string> {
  try {
    const result = await runCappedProcess({
      command: "git",
      args,
      cwd: workspace.root,
      maxOutputBytes,
      backend: "git",
      allowNonZeroExit: true
    });
    if (result.code !== 0 && !result.timedOut) {
      const stderr = result.stderr.trim();
      const stdout = result.stdout.trim();
      return stderr || stdout || `git exited with status ${result.code}`;
    }
    return redactSensitiveText(result.stdout.trim() || "(no output)");
  } catch (error) {
    return `git unavailable or failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export interface GitStatusOptions {
  /** Use -uall so review tools see files inside untracked directories. */
  untrackedMode?: "normal" | "all";
}

export async function gitStatus(
  config: LeastConfig,
  workspace: Workspace,
  guard?: PathGuard,
  filePath?: string,
  options: GitStatusOptions = {}
): Promise<string> {
  const scope = filePath?.trim() ? `:${filePath.trim()}` : "";
  const untrackedSuffix = options.untrackedMode === "all" ? ":uall" : "";
  const cacheKey = `status${scope}${untrackedSuffix}`;
  const cached = getCachedGitValue(workspace.id, cacheKey);
  if (cached) {
    recordCacheOutcome(true);
    recordBackend("cache");
    return cached.value;
  }
  recordCacheOutcome(false);
  const args = ["status", "--short", "--branch"];
  if (options.untrackedMode === "all") args.push("-uall");
  if (filePath?.trim()) {
    if (!guard) return "path-scoped git status requires a path guard";
    const resolved = guard.resolve(workspace, filePath);
    args.push("--", resolved.relPath);
  }
  const value = await runGit(workspace, args, config.maxOutputBytes);
  // Longer than typical model reasoning pauses so related status/diff calls hit cache.
  setCachedGitValue(workspace.id, cacheKey, value, 10_000);
  return value;
}

export async function gitDiff(config: LeastConfig, guard: PathGuard, workspace: Workspace, filePath?: string, staged = false): Promise<string> {
  const scope = filePath?.trim() ? `:${filePath.trim()}` : "";
  const cacheKey = `diff:${staged ? "staged" : "unstaged"}${scope}`;
  const cached = getCachedGitValue(workspace.id, cacheKey);
  if (cached) {
    recordCacheOutcome(true);
    recordBackend("cache");
    return cached.value;
  }
  recordCacheOutcome(false);
  const args = ["diff", "--no-color", "--no-ext-diff", "--no-textconv"];
  if (staged) args.push("--staged");
  if (filePath?.trim()) {
    const resolved = guard.resolve(workspace, filePath);
    args.push("--", resolved.relPath);
  }
  const value = await runGit(workspace, args, config.maxOutputBytes);
  setCachedGitValue(workspace.id, cacheKey, value, 10_000);
  return value;
}
// ponytail: a single shared grep helper is enough; if we need regex/word flags, add opts then.
export async function gitGrepList(
  workspace: Workspace,
  pattern: string,
  maxOutputBytes: number,
  options: { word?: boolean; filesOnly?: boolean; pathspec?: string } = {}
): Promise<string> {
  const args = ["grep", "--color=never", "-n"];
  if (options.filesOnly) args.push("-l");
  if (options.word) args.push("-w");
  args.push("--", pattern);
  if (options.pathspec) args.push(options.pathspec);
  try {
    const result = await runCappedProcess({ command: "git", args, cwd: workspace.root, maxOutputBytes, backend: "git", allowNonZeroExit: true });
    if (result.code === 1 && !result.stdout.trim() && !result.stderr.trim()) return "";
    if (result.code !== 0 && !result.timedOut) return result.stderr.trim() || result.stdout.trim() || `git exited with status ${result.code}`;
    return redactSensitiveText(result.stdout.trim());
  } catch (error) {
    return `git unavailable or failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function gitLog(config: LeastConfig, workspace: Workspace, maxCount = 8): Promise<string> {
  const count = Math.max(1, Math.min(Math.floor(maxCount), 30));
  const cacheKey = `log:${count}`;
  const cached = getCachedGitValue(workspace.id, cacheKey);
  if (cached) {
    recordCacheOutcome(true);
    recordBackend("cache");
    return cached.value;
  }
  recordCacheOutcome(false);
  const value = await runGit(workspace, ["log", `--max-count=${count}`, "--oneline", "--decorate"], config.maxOutputBytes);
  setCachedGitValue(workspace.id, cacheKey, value, 5_000);
  return value;
}

export function assertGitCleanEnoughForWrite(_workspace: Workspace): void {
  // Reserved for future policy hooks. The first version allows writes and returns diffs.
  return;
}
