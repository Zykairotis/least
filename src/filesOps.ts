import path from "node:path";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { minimatch } from "minimatch";
import type { LeastConfig } from "./config.js";
import type { Workspace } from "./guard.js";
import { LeastError, PathGuard } from "./guard.js";
import { listFiles } from "./fsOps.js";
import { isGitAvailable, isRipgrepAvailable } from "./commandCaps.js";
import {
  recordBackend,
  recordCacheOutcome,
  recordChildProcessSpawn,
  recordChildProcessTiming,
  recordFsTiming,
  recordGuardTiming,
  recordPartial,
  recordTimedOut
} from "./perf.js";
import { streamProcessLines } from "./processRunner.js";
import { ToolTimeoutError } from "./timeout.js";
import { getCachedFileList, setCachedFileList } from "./workspaceCache.js";

export type FilesBackend = "git" | "ripgrep" | "node";

export interface FilesOptions {
  root?: string;
  glob?: string;
  trackedOnly: boolean;
  includeHidden: boolean;
  maxResults: number;
}

export interface FilesResult {
  text: string;
  files: string[];
  count: number;
  truncated: boolean;
  backend: FilesBackend;
  partial?: boolean;
  timedOut?: boolean;
  cacheHit?: boolean;
}

const FILE_LIST_CACHE_TTL_MS = 30_000;

function renderFilesText(files: string[], truncated: boolean, totalCount: number): string {
  if (!files.length) return "No files matched.";
  if (files.length <= 40) {
    return `${files.join("\n")}${truncated ? `\n...[${Math.max(0, totalCount - files.length)} more files omitted]` : ""}`;
  }
  const grouped = new Map<string, string[]>();
  for (const file of files) {
    const slash = file.lastIndexOf("/");
    const dir = slash >= 0 ? file.slice(0, slash) : ".";
    const base = slash >= 0 ? file.slice(slash + 1) : file;
    const bucket = grouped.get(dir) ?? [];
    bucket.push(base);
    grouped.set(dir, bucket);
  }
  const extCounts = new Map<string, number>();
  for (const file of files) {
    const ext = path.extname(file).toLowerCase() || "[no-ext]";
    extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1);
  }
  const lines = [`Files: ${totalCount}`];
  lines.push(
    `Extensions: ${[...extCounts.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(0, 8)
      .map(([ext, count]) => `${ext}=${count}`)
      .join(", ")}`
  );
  for (const dir of [...grouped.keys()].sort((a, b) => a.localeCompare(b))) {
    const entries = (grouped.get(dir) ?? []).sort((a, b) => a.localeCompare(b));
    const shown = entries.slice(0, 6);
    lines.push(`${dir}/ ${shown.join(", ")}${entries.length > shown.length ? `, +${entries.length - shown.length} more` : ""}`);
  }
  if (truncated) lines.push(`+${Math.max(0, totalCount - files.length)} more files omitted`);
  return lines.join("\n");
}

function normalizeRel(workspace: Workspace, raw: string): string {
  const abs = path.isAbsolute(raw) ? raw : path.join(workspace.root, raw);
  const rel = path.relative(workspace.root, abs).split(path.sep).join("/");
  if (rel.startsWith("..")) return "";
  return rel || ".";
}

function matchesFilters(
  guard: PathGuard,
  rel: string,
  options: FilesOptions
): boolean {
  if (!rel || rel === ".") return false;
  if (guard.isBlockedRelativePath(rel)) return false;
  if (!options.includeHidden && rel.split("/").some((part) => part.startsWith(".") && part !== "." && part !== "..")) {
    return false;
  }
  if (options.glob && !minimatch(rel, options.glob, { dot: true })) return false;
  return true;
}

async function runGitLsFiles(workspace: Workspace, rootRel: string): Promise<string[]> {
  const started = performance.now();
  recordChildProcessSpawn("git");
  const args = ["ls-files"];
  if (rootRel && rootRel !== ".") args.push("--", rootRel);
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd: workspace.root, env: { ...process.env, NO_COLOR: "1" } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      recordChildProcessTiming(performance.now() - started);
      if (code !== 0) {
        reject(new LeastError(stderr.trim() || `git ls-files failed with exit code ${code}`));
        return;
      }
      resolve(stdout.split("\n").map((line) => line.trim()).filter(Boolean));
    });
  });
}

async function runRipgrepFiles(
  config: LeastConfig,
  workspace: Workspace,
  targetAbs: string,
  options: FilesOptions,
  signal?: AbortSignal
): Promise<{ lines: string[]; truncated: boolean }> {
  const args = ["--files", "--color=never"];
  if (!options.includeHidden) args.push("--hidden", "-g", "!.*", "-g", "!**/.*");
  for (const glob of config.blockedGlobs) args.push("-g", `!${glob}`);
  if (options.glob) args.push("-g", options.glob);
  args.push(targetAbs);

  const streamed = await streamProcessLines({
    command: "rg",
    args,
    cwd: workspace.root,
    maxLines: options.maxResults,
    bufferLines: 8,
    signal,
    backend: "ripgrep"
  });
  if (!streamed.timedOut && streamed.code !== null && streamed.code > 1) {
    throw new LeastError(`ripgrep --files failed with exit code ${streamed.code}`);
  }
  return { lines: streamed.lines, truncated: streamed.truncated };
}

export async function listWorkspaceFiles(
  config: LeastConfig,
  guard: PathGuard,
  workspace: Workspace,
  rawOptions: Partial<FilesOptions> & { signal?: AbortSignal; refresh?: boolean }
): Promise<FilesResult> {
  const options: FilesOptions = {
    root: rawOptions.root,
    glob: rawOptions.glob,
    trackedOnly: Boolean(rawOptions.trackedOnly),
    includeHidden: Boolean(rawOptions.includeHidden),
    maxResults: Math.max(1, Math.min(rawOptions.maxResults ?? 5000, 20_000))
  };
  const guardStarted = performance.now();
  const target = guard.resolve(workspace, options.root ?? ".");
  recordGuardTiming(performance.now() - guardStarted);
  const cacheKey = JSON.stringify({
    root: target.relPath,
    glob: options.glob ?? "",
    trackedOnly: options.trackedOnly,
    includeHidden: options.includeHidden
  });
  if (!rawOptions.refresh) {
    const cached = getCachedFileList(workspace.id, cacheKey);
    if (cached) {
      recordCacheOutcome(true);
      recordBackend(cached.backend);
      const files = cached.files.slice(0, options.maxResults);
      return {
        text: renderFilesText(files, cached.truncated || cached.files.length > options.maxResults, cached.files.length),
        files,
        count: files.length,
        truncated: cached.truncated || cached.files.length > options.maxResults,
        backend: cached.backend,
        cacheHit: true
      };
    }
  }
  recordCacheOutcome(false);
  const collect = (rawLines: string[]): { files: string[]; truncated: boolean } => {
    const collected: string[] = [];
    let hitLimit = false;
    for (const line of rawLines) {
      const rel = normalizeRel(workspace, line);
      if (!matchesFilters(guard, rel, options)) continue;
      collected.push(rel);
    }
    if (collected.length > options.maxResults) hitLimit = true;
    return { files: collected, truncated: hitLimit };
  };
  const finalize = (files: string[], truncated: boolean, backend: FilesBackend): FilesResult => {
    const unique = [...new Set(files)].sort((a, b) => a.localeCompare(b));
    setCachedFileList(workspace.id, cacheKey, backend, unique, truncated, FILE_LIST_CACHE_TTL_MS);
    const sliced = unique.slice(0, options.maxResults);
    recordBackend(backend);
    const finalTruncated = truncated || unique.length > options.maxResults;
    const text = renderFilesText(sliced, finalTruncated, unique.length);
    return { text, files: sliced, count: sliced.length, truncated: finalTruncated, backend, cacheHit: false };
  };

  if (options.trackedOnly && (await isGitAvailable())) {
    try {
      const raw = await runGitLsFiles(workspace, target.relPath === "." ? "" : target.relPath);
      const { files, truncated } = collect(raw);
      return finalize(files, truncated, "git");
    } catch {
      // Fall through to ripgrep or node.
    }
  }

  if (!options.trackedOnly && (await isRipgrepAvailable())) {
    try {
      const rgResult = await runRipgrepFiles(config, workspace, target.absPath, options, rawOptions.signal);
      if (rawOptions.signal?.aborted) {
        recordTimedOut();
        recordPartial();
      }
      const { files, truncated } = collect(rgResult.lines);
      return {
        ...finalize(files, truncated || rgResult.truncated || rawOptions.signal?.aborted === true, "ripgrep"),
        partial: rawOptions.signal?.aborted,
        timedOut: rawOptions.signal?.reason instanceof ToolTimeoutError
      };
    } catch {
      // Fall through to node.
    }
  }

  const fsStarted = performance.now();
  const walked = await listFiles(guard, workspace, {
    root: options.root,
    glob: options.glob,
    includeHidden: options.includeHidden,
    maxFiles: 20_000
  });
  recordFsTiming(performance.now() - fsStarted);
  const truncated = walked.length > options.maxResults;
  return finalize(walked.slice(0, options.maxResults), truncated, "node");
}
