import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import type { LeastConfig } from "./config.js";
import { mapWithConcurrency } from "./fsOps.js";
import type { Workspace } from "./guard.js";
import { LeastError, PathGuard } from "./guard.js";
import { listFiles } from "./fsOps.js";
import {
  recordBackend,
  recordChildProcessSpawn,
  recordChildProcessTiming,
  recordFsTiming,
  recordGuardTiming,
  recordPartial,
  recordTimedOut
} from "./perf.js";
import { redactSensitiveText } from "./redact.js";
import { isRipgrepAvailable } from "./commandCaps.js";
import { ToolTimeoutError } from "./timeout.js";

export interface SearchOptions {
  query: string;
  regex: boolean;
  root?: string;
  glob?: string;
  includeHidden: boolean;
  maxResults: number;
  signal?: AbortSignal;
}

export interface SearchResult {
  text: string;
  matches: Array<{ path: string; line: number; text: string }>;
  truncated: boolean;
  used: "ripgrep" | "node";
  partial?: boolean;
  timedOut?: boolean;
  killedAfterMaxResults?: boolean;
}

export interface SearchContextOptions extends SearchOptions {
  beforeLines: number;
  afterLines: number;
}

export interface SearchContextMatch {
  path: string;
  line: number;
  text: string;
  context: string;
}

export interface SearchContextResult {
  text: string;
  matches: SearchContextMatch[];
  truncated: boolean;
  used: "ripgrep" | "node";
  partial?: boolean;
  timedOut?: boolean;
  killedAfterMaxResults?: boolean;
}

interface ParsedRipgrepEvent {
  kind: "match" | "context";
  path: string;
  line: number;
  text: string;
}

interface NodeFileLines {
  path: string;
  lines: string[];
}

const NODE_SEARCH_CONCURRENCY = 8;

function truncateLine(line: string, max = 400): string {
  const normalized = line.replace(/\r?\n$/, "");
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max)}…`;
}

function ripgrepArgs(
  config: LeastConfig,
  options: SearchOptions,
  targetAbs: string,
  context?: { beforeLines: number; afterLines: number }
): string[] {
  const args = ["--json", "--line-number", "--color=never", "--max-columns", "500"];
  if (!options.regex) args.push("--fixed-strings");
  if (!options.includeHidden) args.push("--hidden", "-g", "!.*", "-g", "!**/.*");
  for (const glob of config.blockedGlobs) args.push("-g", `!${glob}`);
  if (options.glob) args.push("-g", options.glob);
  if (context) {
    if (context.beforeLines > 0) args.push("-B", String(context.beforeLines));
    if (context.afterLines > 0) args.push("-A", String(context.afterLines));
  }
  args.push(options.query, targetAbs);
  return args;
}

function normalizeRipgrepPath(workspace: Workspace, rawPath: string, guard: PathGuard): string | undefined {
  if (!rawPath) return undefined;
  const absPath = path.isAbsolute(rawPath) ? rawPath : path.join(workspace.root, rawPath);
  const rel = path.relative(workspace.root, absPath).split(path.sep).join("/");
  if (rel.startsWith("..")) return undefined;
  if (guard.isBlockedRelativePath(rel)) return undefined;
  return rel || ".";
}

function parseRipgrepJsonLine(line: string, workspace: Workspace, guard: PathGuard): ParsedRipgrepEvent | null {
  if (!line.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  const type = record.type;
  if (type !== "match" && type !== "context") return null;
  const data = record.data;
  if (!data || typeof data !== "object") return null;
  const shape = data as Record<string, unknown>;
  const pathValue = shape.path && typeof shape.path === "object" ? (shape.path as Record<string, unknown>).text : undefined;
  const textValue = shape.lines && typeof shape.lines === "object" ? (shape.lines as Record<string, unknown>).text : undefined;
  const lineNumber = shape.line_number;
  if (typeof pathValue !== "string" || typeof textValue !== "string" || typeof lineNumber !== "number") return null;
  const rel = normalizeRipgrepPath(workspace, pathValue, guard);
  if (!rel) return null;
  return {
    kind: type,
    path: rel,
    line: lineNumber,
    text: redactSensitiveText(truncateLine(textValue))
  };
}

function renderSearchText(matches: Array<{ path: string; line: number; text: string }>): string {
  return matches.map((match) => `${match.path}:${match.line}: ${match.text}`).join("\n") || "No matches.";
}

function renderContextText(matches: SearchContextMatch[]): string {
  return matches.map((match) => `### ${match.path}:${match.line}\n${match.context}`).join("\n\n---\n\n") || "No matches.";
}

function finalizeContextBlocks(events: ParsedRipgrepEvent[], maxMatches: number): SearchContextMatch[] {
  const matches: SearchContextMatch[] = [];
  let block: ParsedRipgrepEvent[] = [];

  const flush = () => {
    if (!block.length || matches.length >= maxMatches) {
      block = [];
      return;
    }
    const context = block.map((entry) => `${entry.line}${entry.kind === "match" ? ":" : "-"} ${entry.text}`).join("\n");
    for (const entry of block) {
      if (entry.kind !== "match") continue;
      matches.push({ path: entry.path, line: entry.line, text: entry.text, context });
      if (matches.length >= maxMatches) break;
    }
    block = [];
  };

  for (const event of events) {
    const last = block.at(-1);
    if (!last) {
      block.push(event);
      continue;
    }
    const adjacent = event.path === last.path && event.line <= last.line + 1 && event.line >= last.line;
    if (!adjacent) flush();
    block.push(event);
  }
  flush();
  return matches;
}

async function runRipgrepSearch(
  config: LeastConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: SearchOptions
): Promise<SearchResult> {
  const guardStarted = performance.now();
  const target = guard.resolve(workspace, options.root ?? ".");
  recordGuardTiming(performance.now() - guardStarted);
  const args = ripgrepArgs(config, options, target.absPath);
  recordChildProcessSpawn("ripgrep");
  recordBackend("ripgrep");

  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn("rg", args, { cwd: workspace.root, env: { ...process.env, NO_COLOR: "1" } });
    let stderr = "";
    let buffer = "";
    let settled = false;
    let killedAfterMaxResults = false;
    let outputTruncated = false;
    const matches: Array<{ path: string; line: number; text: string }> = [];

    const finalize = (code: number | null) => {
      if (settled) return;
      settled = true;
      recordChildProcessTiming(performance.now() - started);
      const timedOut = options.signal?.aborted && options.signal.reason instanceof ToolTimeoutError;
      const partial = timedOut || killedAfterMaxResults || outputTruncated;
      if (timedOut) recordTimedOut();
      if (partial) recordPartial();
      const intentionalStop = timedOut || killedAfterMaxResults || outputTruncated;
      if (!intentionalStop && code && code > 1) {
        reject(new LeastError(stderr.trim() || `ripgrep failed with exit code ${code}`));
        return;
      }
      resolve({
        text: renderSearchText(matches.slice(0, options.maxResults)),
        matches: matches.slice(0, options.maxResults),
        truncated: partial,
        used: "ripgrep",
        partial,
        timedOut,
        killedAfterMaxResults
      });
    };

    const onAbort = () => child.kill("SIGTERM");
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk) => {
      if (killedAfterMaxResults) return;
      buffer += String(chunk);
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        if (matches.length >= options.maxResults) {
          killedAfterMaxResults = true;
          child.kill("SIGTERM");
          break;
        }
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        const event = parseRipgrepJsonLine(line, workspace, guard);
        if (event?.kind === "match") {
          matches.push({ path: event.path, line: event.line, text: event.text });
          if (matches.length >= options.maxResults) {
            killedAfterMaxResults = true;
            child.kill("SIGTERM");
            break;
          }
        }
        newlineIndex = buffer.indexOf("\n");
      }
      if (matches.length >= options.maxResults) return;
      if (Buffer.byteLength(buffer, "utf8") > config.maxOutputBytes) {
        outputTruncated = true;
        child.kill("SIGTERM");
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      options.signal?.removeEventListener("abort", onAbort);
      finalize(code);
    });
  });
}

async function runRipgrepContext(
  config: LeastConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: SearchContextOptions
): Promise<SearchContextResult> {
  const guardStarted = performance.now();
  const target = guard.resolve(workspace, options.root ?? ".");
  recordGuardTiming(performance.now() - guardStarted);
  const args = ripgrepArgs(config, options, target.absPath, {
    beforeLines: options.beforeLines,
    afterLines: options.afterLines
  });
  recordChildProcessSpawn("ripgrep");
  recordBackend("ripgrep");

  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn("rg", args, { cwd: workspace.root, env: { ...process.env, NO_COLOR: "1" } });
    let stderr = "";
    let buffer = "";
    let settled = false;
    let killedAfterMaxResults = false;
    let outputTruncated = false;
    const events: ParsedRipgrepEvent[] = [];
    let matchEventCount = 0;

    const finalize = (code: number | null) => {
      if (settled) return;
      settled = true;
      recordChildProcessTiming(performance.now() - started);
      const matches = finalizeContextBlocks(events, options.maxResults);
      const timedOut = options.signal?.aborted && options.signal.reason instanceof ToolTimeoutError;
      const partial = timedOut || killedAfterMaxResults || outputTruncated;
      if (timedOut) recordTimedOut();
      if (partial) recordPartial();
      const intentionalStop = timedOut || killedAfterMaxResults || outputTruncated;
      if (!intentionalStop && code && code > 1) {
        reject(new LeastError(stderr.trim() || `ripgrep failed with exit code ${code}`));
        return;
      }
      resolve({
        text: renderContextText(matches),
        matches: matches.slice(0, options.maxResults),
        truncated: partial,
        used: "ripgrep",
        partial,
        timedOut,
        killedAfterMaxResults
      });
    };

    const onAbort = () => child.kill("SIGTERM");
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk) => {
      if (killedAfterMaxResults) return;
      buffer += String(chunk);
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        if (matchEventCount >= options.maxResults) {
          killedAfterMaxResults = true;
          child.kill("SIGTERM");
          break;
        }
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        const event = parseRipgrepJsonLine(line, workspace, guard);
        if (event) {
          events.push(event);
          if (event.kind === "match") {
            matchEventCount += 1;
          }
          if (matchEventCount >= options.maxResults) {
            killedAfterMaxResults = true;
            child.kill("SIGTERM");
            break;
          }
        }
        newlineIndex = buffer.indexOf("\n");
      }
      if (Buffer.byteLength(buffer, "utf8") > config.maxOutputBytes) {
        outputTruncated = true;
        child.kill("SIGTERM");
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      options.signal?.removeEventListener("abort", onAbort);
      finalize(code);
    });
  });
}

async function runNodeSearch(config: LeastConfig, guard: PathGuard, workspace: Workspace, options: SearchOptions): Promise<SearchResult> {
  const fsStarted = performance.now();
  const files = await listFiles(guard, workspace, {
    root: options.root,
    glob: options.glob,
    includeHidden: options.includeHidden,
    maxFiles: 20_000
  });
  recordFsTiming(performance.now() - fsStarted);
  recordBackend("node");
  const matches: Array<{ path: string; line: number; text: string }> = [];
  const matcher = options.regex ? new RegExp(options.query) : undefined;
  let timedOut = false;
  const matchedFiles = await mapWithConcurrency(
    files,
    Math.min(16, NODE_SEARCH_CONCURRENCY),
    async (rel): Promise<NodeFileLines | undefined> => {
      if (options.signal?.aborted || matches.length >= options.maxResults) return undefined;
      const resolved = guard.resolve(workspace, rel);
      try {
        const statStarted = performance.now();
        const stat = await fsp.stat(resolved.absPath);
        recordFsTiming(performance.now() - statStarted);
        if (!stat.isFile() || stat.size > config.maxReadBytes) return undefined;
        const readStarted = performance.now();
        const buffer = await fsp.readFile(resolved.absPath);
        recordFsTiming(performance.now() - readStarted);
        if (buffer.includes(0)) return undefined;
        return { path: rel, lines: buffer.toString("utf8").split(/\r?\n/) };
      } catch {
        return undefined;
      }
    }
  );

  for (const file of matchedFiles) {
    if (!file) continue;
    if (matches.length >= options.maxResults) break;
    if (options.signal?.aborted) {
      timedOut = options.signal.reason instanceof ToolTimeoutError;
      break;
    }
    for (let i = 0; i < file.lines.length; i += 1) {
      const line = file.lines[i] as string;
      if (matcher) matcher.lastIndex = 0;
      const hit = matcher ? matcher.test(line) : line.includes(options.query);
      if (!hit) continue;
      matches.push({ path: file.path, line: i + 1, text: redactSensitiveText(truncateLine(line)) });
      if (matches.length >= options.maxResults) break;
    }
  }

  if (timedOut) {
    recordTimedOut();
    recordPartial();
  }
  return {
    text: renderSearchText(matches),
    matches,
    truncated: matches.length >= options.maxResults || timedOut,
    used: "node",
    partial: timedOut,
    timedOut
  };
}

async function runNodeSearchContext(
  config: LeastConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: SearchContextOptions
): Promise<SearchContextResult> {
  const base = await runNodeSearch(config, guard, workspace, options);
  const matches: SearchContextMatch[] = [];
  let timedOut = base.timedOut === true;
  const lineCache = new Map<string, string[]>();
  for (const hit of base.matches) {
    if (matches.length >= options.maxResults) break;
    if (options.signal?.aborted) {
      timedOut = options.signal.reason instanceof ToolTimeoutError;
      break;
    }
    const resolved = guard.resolve(workspace, hit.path);
    try {
      let lines = lineCache.get(hit.path);
      if (!lines) {
        const started = performance.now();
        const buffer = await fsp.readFile(resolved.absPath);
        recordFsTiming(performance.now() - started);
        lines = buffer.toString("utf8").split(/\r?\n/);
        lineCache.set(hit.path, lines);
      }
      const start = Math.max(0, hit.line - 1 - options.beforeLines);
      const end = Math.min(lines.length, hit.line + options.afterLines);
      const context = lines
        .slice(start, end)
        .map((line, idx) => {
          const lineNo = start + idx + 1;
          const marker = lineNo === hit.line ? ":" : "-";
          return `${lineNo}${marker} ${redactSensitiveText(truncateLine(line))}`;
        })
        .join("\n");
      matches.push({ path: hit.path, line: hit.line, text: hit.text, context });
    } catch {
      matches.push({ path: hit.path, line: hit.line, text: hit.text, context: hit.text });
    }
  }
  if (timedOut) {
    recordTimedOut();
    recordPartial();
  }
  return {
    text: renderContextText(matches),
    matches,
    truncated: base.truncated || timedOut,
    used: "node",
    partial: timedOut,
    timedOut
  };
}

function validateRegex(query: string, regex: boolean): void {
  if (!regex) return;
  try {
    new RegExp(query);
  } catch (error) {
    throw new LeastError(`Invalid regex: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function searchWorkspace(config: LeastConfig, guard: PathGuard, workspace: Workspace, rawOptions: Partial<SearchOptions>): Promise<SearchResult> {
  const query = rawOptions.query?.toString() ?? "";
  if (!query) throw new LeastError("query is required.");
  const options: SearchOptions = {
    query,
    regex: Boolean(rawOptions.regex),
    root: rawOptions.root,
    glob: rawOptions.glob,
    includeHidden: Boolean(rawOptions.includeHidden),
    maxResults: Math.max(1, Math.min(rawOptions.maxResults ?? config.maxSearchResults, config.maxSearchResults)),
    signal: rawOptions.signal
  };
  validateRegex(options.query, options.regex);

  if (await isRipgrepAvailable()) {
    return runRipgrepSearch(config, guard, workspace, options);
  }
  return runNodeSearch(config, guard, workspace, options);
}

export async function searchWorkspaceContext(
  config: LeastConfig,
  guard: PathGuard,
  workspace: Workspace,
  rawOptions: Partial<SearchContextOptions>
): Promise<SearchContextResult> {
  const query = rawOptions.query?.toString() ?? "";
  if (!query) throw new LeastError("query is required.");
  const options: SearchContextOptions = {
    query,
    regex: Boolean(rawOptions.regex),
    root: rawOptions.root,
    glob: rawOptions.glob,
    includeHidden: Boolean(rawOptions.includeHidden),
    maxResults: Math.max(1, Math.min(rawOptions.maxResults ?? config.maxSearchResults, config.maxSearchResults)),
    beforeLines: Math.max(0, Math.min(rawOptions.beforeLines ?? 2, 20)),
    afterLines: Math.max(0, Math.min(rawOptions.afterLines ?? 2, 20)),
    signal: rawOptions.signal
  };
  validateRegex(options.query, options.regex);

  if (await isRipgrepAvailable()) {
    return runRipgrepContext(config, guard, workspace, options);
  }
  return runNodeSearchContext(config, guard, workspace, options);
}
