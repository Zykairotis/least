import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { minimatch } from "minimatch";
import type { LeastConfig } from "./config.js";
import { listFiles, readManyTextFiles } from "./fsOps.js";
import type { Workspace } from "./guard.js";
import { PathGuard } from "./guard.js";
import { runCappedProcess } from "./processRunner.js";
import { redactSensitiveText } from "./redact.js";

export type ReviewFileKind = "source" | "test" | "docs" | "config" | "lockfile" | "generated" | "binary" | "large" | "unknown";
export type ReviewRisk = "low" | "medium" | "high";

export interface DiffSummaryFile {
  path: string;
  status: string;
  additions?: number;
  deletions?: number;
  kind?: ReviewFileKind;
  risk?: ReviewRisk;
}

export interface DiffSummaryResult {
  text: string;
  files: DiffSummaryFile[];
  totals: { files: number; additions: number; deletions: number };
  truncated: boolean;
}

export interface ReadChangedFilesResult {
  text: string;
  files: Array<{
    path: string;
    status: string;
    kind: ReviewFileKind;
    risk: ReviewRisk;
    text?: string;
    reason?: string;
  }>;
  changedFiles: string[];
  skipped: Array<{ path: string; reason: string }>;
  truncated: boolean;
}

export interface ReadChangedFilesOptions {
  includeUntracked?: boolean;
  includeStaged?: boolean;
  includeUnstaged?: boolean;
  globs?: string[];
  excludeGlobs?: string[];
  maxFiles: number;
  maxBytes: number;
  includeLockfiles?: boolean;
  includeGenerated?: boolean;
  signal?: AbortSignal;
}

interface StatusEntry {
  path: string;
  status: string;
  indexStatus: string;
  worktreeStatus: string;
  renamedFrom?: string;
}

async function runGitCapture(workspace: Workspace, args: string[], maxOutputBytes: number): Promise<string> {
  try {
    const result = await runCappedProcess({
      command: "git",
      args,
      cwd: workspace.root,
      maxOutputBytes,
      backend: "git",
      allowNonZeroExit: true
    });
    if (result.code !== 0 || result.timedOut) return "";
    return result.stdout ?? "";
  } catch {
    return "";
  }
}

function trimQuotes(value: string): string {
  if (value.startsWith("\"") && value.endsWith("\"")) return value.slice(1, -1);
  return value;
}

export const REVIEW_GIT_STATUS_OPTIONS = { untrackedMode: "all" as const };

function isUntrackedEntry(entry: StatusEntry): boolean {
  return entry.status === "??" || entry.indexStatus === "?" || entry.worktreeStatus === "?";
}

export async function expandUntrackedDirectoryEntries(
  guard: PathGuard,
  workspace: Workspace,
  entries: StatusEntry[],
  maxFiles = 500
): Promise<StatusEntry[]> {
  const expanded: StatusEntry[] = [];
  for (const entry of entries) {
    if (!isUntrackedEntry(entry)) {
      expanded.push(entry);
      continue;
    }
    try {
      const resolved = guard.resolve(workspace, entry.path);
      const stat = await fsp.stat(resolved.absPath);
      if (!stat.isDirectory()) {
        expanded.push(entry);
        continue;
      }
      const files = await listFiles(guard, workspace, { root: entry.path, maxFiles });
      if (!files.length) {
        expanded.push(entry);
        continue;
      }
      for (const file of files) {
        expanded.push({
          path: file,
          status: "??",
          indexStatus: "?",
          worktreeStatus: "?"
        });
      }
    } catch {
      expanded.push(entry);
    }
  }
  return expanded;
}

export function parseGitStatusEntries(status: string): StatusEntry[] {
  const entries: StatusEntry[] = [];
  for (const rawLine of status.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith("##")) continue;
    const indexStatus = line[0] ?? " ";
    const worktreeStatus = line[1] ?? " ";
    const rawPath = line.slice(3).trim();
    if (!rawPath) continue;
    let relPath = rawPath;
    let renamedFrom: string | undefined;
    if (rawPath.includes(" -> ")) {
      const [from, to] = rawPath.split(" -> ");
      renamedFrom = trimQuotes(from ?? "");
      relPath = trimQuotes(to ?? rawPath);
    } else {
      relPath = trimQuotes(rawPath);
    }
    entries.push({
      path: relPath,
      status: `${indexStatus}${worktreeStatus}`.trim() || "??",
      indexStatus,
      worktreeStatus,
      renamedFrom
    });
  }
  return entries;
}

function matchesAny(relPath: string, globs: string[] | undefined): boolean {
  if (!globs || globs.length === 0) return true;
  return globs.some((glob) => minimatch(relPath, glob, { dot: true }));
}

function excludedBy(relPath: string, globs: string[] | undefined): boolean {
  if (!globs || globs.length === 0) return false;
  return globs.some((glob) => minimatch(relPath, glob, { dot: true }));
}

export function classifyPath(relPath: string): ReviewFileKind {
  const normalized = relPath.replace(/\\/g, "/");
  const base = path.basename(normalized).toLowerCase();
  const ext = path.extname(normalized).toLowerCase();
  if (
    normalized.includes("/dist/") ||
    normalized.includes("/build/") ||
    normalized.includes("/coverage/") ||
    normalized.includes("/.next/") ||
    normalized.includes("/.cache/") ||
    normalized.includes("/.least/") ||
    normalized.startsWith(".least/") ||
    normalized.includes("/generated/") ||
    base.endsWith(".min.js") ||
    base.endsWith(".bundle.js")
  ) {
    return "generated";
  }
  if (
    base === "package-lock.json" ||
    base === "pnpm-lock.yaml" ||
    base === "yarn.lock" ||
    base === "bun.lockb" ||
    base === "cargo.lock"
  ) {
    return "lockfile";
  }
  if (base.endsWith(".test.ts") || base.endsWith(".spec.ts") || base.endsWith(".test.js") || base.endsWith(".spec.js") || normalized.includes("/__tests__/")) {
    return "test";
  }
  if (base === "package.json" || base.startsWith("tsconfig") || base.startsWith("jsconfig") || base.includes("config") || ext === ".json" || ext === ".yaml" || ext === ".yml" || ext === ".toml") {
    return "config";
  }
  if (ext === ".md" || ext === ".mdx" || normalized.startsWith("docs/")) {
    return "docs";
  }
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".cs", ".rb", ".php", ".swift"].includes(ext)) {
    return "source";
  }
  return "unknown";
}

export function riskForPath(relPath: string, kind: ReviewFileKind): ReviewRisk {
  const normalized = relPath.toLowerCase();
  if (kind === "lockfile" || kind === "generated") return "low";
  if (normalized.includes("server") || normalized.includes("config") || normalized.endsWith("package.json") || normalized.endsWith("tsconfig.json")) return "high";
  if (kind === "source" || kind === "test") return "medium";
  return "low";
}

function parseNumstat(output: string): Map<string, { additions?: number; deletions?: number }> {
  const map = new Map<string, { additions?: number; deletions?: number }>();
  for (const line of output.split(/\r?\n/)) {
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const additions = parts[0] === "-" ? undefined : Number(parts[0]);
    const deletions = parts[1] === "-" ? undefined : Number(parts[1]);
    const relPath = parts.slice(2).join("\t").trim();
    if (!relPath) continue;
    map.set(relPath, {
      additions: Number.isFinite(additions) ? additions : undefined,
      deletions: Number.isFinite(deletions) ? deletions : undefined
    });
  }
  return map;
}

export interface UntrackedSummary {
  count: number;
  totalBytesEstimate: number;
  byKind: Record<ReviewFileKind, number>;
  topPaths: Array<{ path: string; kind: ReviewFileKind; sizeBytes?: number }>;
  text: string;
}

export function summarizeUntrackedFiles(
  entries: StatusEntry[],
  sizeByPath?: Map<string, number>,
  maxPaths = 20
): UntrackedSummary {
  const untracked = entries.filter((entry) => entry.status === "??" || entry.indexStatus === "?" || entry.worktreeStatus === "?");
  const byKind: Record<ReviewFileKind, number> = {
    source: 0,
    test: 0,
    docs: 0,
    config: 0,
    lockfile: 0,
    generated: 0,
    binary: 0,
    large: 0,
    unknown: 0
  };
  let totalBytesEstimate = 0;
  const topPaths = untracked.slice(0, maxPaths).map((entry) => {
    const kind = classifyPath(entry.path);
    byKind[kind] += 1;
    const sizeBytes = sizeByPath?.get(entry.path);
    if (sizeBytes) totalBytesEstimate += sizeBytes;
    return { path: entry.path, kind, sizeBytes };
  });
  for (const entry of untracked.slice(maxPaths)) {
    const kind = classifyPath(entry.path);
    byKind[kind] += 1;
    totalBytesEstimate += sizeByPath?.get(entry.path) ?? 0;
  }
  const lines = [
    `Untracked files: ${untracked.length}`,
    `Size estimate (sampled): ${totalBytesEstimate || "unknown"} bytes`,
    `Kinds: ${Object.entries(byKind)
      .filter(([, count]) => count > 0)
      .map(([kind, count]) => `${kind}=${count}`)
      .join(", ")}`,
    topPaths.length ? "Top untracked paths:" : "No untracked files.",
    ...topPaths.map((item) => {
      const size = item.sizeBytes !== undefined ? ` (${item.sizeBytes} bytes)` : "";
      const tag = item.kind === "generated" || item.kind === "lockfile" ? ` [${item.kind}]` : "";
      return `  ? ${item.path}${size}${tag}`;
    })
  ];
  if (untracked.length > maxPaths) {
    lines.push(`  ... +${untracked.length - maxPaths} more untracked files omitted`);
  }
  return { count: untracked.length, totalBytesEstimate, byKind, topPaths, text: lines.join("\n") };
}

export function diffMaxCharsFromTokens(maxTokensEstimate: number | undefined, fallback: number): number {
  if (!Number.isFinite(maxTokensEstimate)) return fallback;
  return Math.max(2_000, Math.floor((maxTokensEstimate as number) * 4));
}

export async function diffSummary(
  config: LeastConfig,
  guard: PathGuard,
  workspace: Workspace,
  status: string,
  options: { staged?: boolean; classify?: boolean; path?: string } = {}
): Promise<DiffSummaryResult> {
  const scopedPath = options.path?.trim();
  const statusEntries = (await expandUntrackedDirectoryEntries(guard, workspace, parseGitStatusEntries(status)))
    .filter((entry) => !scopedPath || entry.path === scopedPath || entry.path.startsWith(`${scopedPath}/`));
  const diffArgs = ["diff", "--numstat", "--no-color", "--no-ext-diff", "--no-textconv"];
  if (options.staged) diffArgs.push("--staged");
  if (scopedPath) diffArgs.push("--", scopedPath);
  const numstat = parseNumstat(await runGitCapture(workspace, diffArgs, config.maxOutputBytes));
  const files = statusEntries.map((entry) => {
    const stats = numstat.get(entry.path);
    const kind = options.classify ? classifyPath(entry.path) : undefined;
    return {
      path: entry.path,
      status: entry.status,
      additions: stats?.additions,
      deletions: stats?.deletions,
      kind,
      risk: kind ? riskForPath(entry.path, kind) : undefined
    };
  });
  const totals = files.reduce(
    (acc, file) => {
      acc.files += 1;
      acc.additions += file.additions ?? 0;
      acc.deletions += file.deletions ?? 0;
      return acc;
    },
    { files: 0, additions: 0, deletions: 0 }
  );
  const text =
    files.length === 0
      ? "No changed files."
      : files
          .map((file) => {
            const stats = file.additions !== undefined || file.deletions !== undefined ? ` +${file.additions ?? 0} -${file.deletions ?? 0}` : "";
            const tags = [file.kind, file.risk].filter(Boolean).join(", ");
            return `${file.status.padEnd(2, " ")} ${file.path}${stats}${tags ? ` [${tags}]` : ""}`;
          })
          .join("\n");
  return { text, files, totals, truncated: false };
}

function shouldIncludeStatusEntry(entry: StatusEntry, options: ReadChangedFilesOptions): boolean {
  const includeUntracked = options.includeUntracked !== false;
  const includeStaged = options.includeStaged !== false;
  const includeUnstaged = options.includeUnstaged !== false;
  const isUntracked = entry.status === "??" || entry.indexStatus === "?" || entry.worktreeStatus === "?";
  const hasStaged = entry.indexStatus !== " " && entry.indexStatus !== "?";
  const hasUnstaged = entry.worktreeStatus !== " ";
  if (isUntracked) return includeUntracked;
  if (hasStaged && includeStaged) return true;
  if (hasUnstaged && includeUnstaged) return true;
  return false;
}

export async function readChangedFiles(
  config: LeastConfig,
  guard: PathGuard,
  workspace: Workspace,
  status: string,
  options: ReadChangedFilesOptions
): Promise<ReadChangedFilesResult> {
  const entries = (await expandUntrackedDirectoryEntries(guard, workspace, parseGitStatusEntries(status)))
    .filter((entry) => shouldIncludeStatusEntry(entry, options))
    .filter((entry) => matchesAny(entry.path, options.globs))
    .filter((entry) => !excludedBy(entry.path, options.excludeGlobs));

  const prioritized = entries
    .map((entry) => ({ ...entry, kind: classifyPath(entry.path), risk: riskForPath(entry.path, classifyPath(entry.path)) }))
    .sort((left, right) => {
      const score = (entry: { kind: ReviewFileKind; risk: ReviewRisk }) => {
        if (entry.kind === "source") return 0;
        if (entry.kind === "test") return 1;
        if (entry.kind === "config") return 2;
        if (entry.kind === "docs") return 3;
        if (entry.kind === "lockfile") return 4;
        if (entry.kind === "generated") return 5;
        return 6;
      };
      return score(left) - score(right) || left.path.localeCompare(right.path);
    });

  const selected = prioritized.slice(0, options.maxFiles);
  const skipped: Array<{ path: string; reason: string }> = [];
  const toRead: Array<{ path: string; startLine?: number; endLine?: number }> = [];
  const selectedMeta = new Map<string, { status: string; kind: ReviewFileKind; risk: ReviewRisk }>();

  for (const entry of selected) {
    if (options.signal?.aborted) break;
    if (!options.includeLockfiles && entry.kind === "lockfile") {
      skipped.push({ path: entry.path, reason: "lockfile skipped" });
      continue;
    }
    if (!options.includeGenerated && entry.kind === "generated") {
      skipped.push({ path: entry.path, reason: "generated file skipped" });
      continue;
    }
    try {
      const resolved = guard.resolve(workspace, entry.path);
      const stat = await fsp.stat(resolved.absPath);
      if (!stat.isFile()) {
        skipped.push({ path: entry.path, reason: "not a file" });
        continue;
      }
      if (stat.size > options.maxBytes) {
        skipped.push({ path: entry.path, reason: `large file (${stat.size} bytes)` });
        continue;
      }
      const handle = await fsp.open(resolved.absPath, "r");
      try {
        const sample = Buffer.alloc(Math.min(1024, stat.size));
        const { bytesRead } = await handle.read(sample, 0, sample.length, 0);
        if (sample.subarray(0, bytesRead).includes(0)) {
          skipped.push({ path: entry.path, reason: "binary file" });
          continue;
        }
      } finally {
        await handle.close();
      }
      toRead.push({ path: entry.path });
      selectedMeta.set(entry.path, { status: entry.status, kind: entry.kind, risk: entry.risk });
    } catch (error) {
      skipped.push({ path: entry.path, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  const read = toRead.length
    ? await readManyTextFiles(config, guard, workspace, toRead, {
        maxTotalBytes: Math.max(options.maxBytes, Math.min(config.maxReadBytes * 3, options.maxBytes * Math.max(1, toRead.length))),
        includeSha256: false,
        includeLineNumbers: true,
        includeTotalLines: false,
        signal: options.signal
      })
    : { files: [], totalBytes: 0, truncated: false, text: "" };

  const files: ReadChangedFilesResult["files"] = [
    ...read.files.map((file) => {
      const meta = selectedMeta.get(file.path);
      return {
        path: file.path,
        status: meta?.status ?? "??",
        kind: meta?.kind ?? classifyPath(file.path),
        risk: meta?.risk ?? riskForPath(file.path, classifyPath(file.path)),
        text: file.text
      };
    }),
    ...skipped.map((item) => {
      const meta = prioritized.find((entry) => entry.path === item.path);
      const kind = meta?.kind ?? classifyPath(item.path);
      return {
        path: item.path,
        status: meta?.status ?? "??",
        kind,
        risk: meta?.risk ?? riskForPath(item.path, kind),
        reason: item.reason
      };
    })
  ];

  const text = files
    .map((file) => {
      if ("text" in file && typeof file.text === "string") {
        return `### ${file.path}\nStatus: ${file.status}\nKind: ${file.kind}\nRisk: ${file.risk}\n\n\`\`\`text\n${redactSensitiveText(file.text)}\n\`\`\``;
      }
      return `### ${file.path}\nStatus: ${file.status}\nKind: ${file.kind}\nRisk: ${file.risk}\nSkipped: ${file.reason}`;
    })
    .join("\n\n");

  return {
    text: text || "No changed files matched the requested filters.",
    files,
    changedFiles: prioritized.map((entry) => entry.path),
    skipped,
    truncated: prioritized.length > options.maxFiles || Boolean(read.truncated)
  };
}
