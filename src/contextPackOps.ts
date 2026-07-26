import path from "node:path";
import fsp from "node:fs/promises";
import type { LeastConfig } from "./config.js";
import { readManyTextFiles } from "./fsOps.js";
import type { Workspace } from "./guard.js";
import { PathGuard } from "./guard.js";
import { listWorkspaceFiles } from "./filesOps.js";
import { queryJsonFiles } from "./jsonQueryOps.js";
import { searchWorkspaceContext } from "./searchOps.js";
import { gitStatus } from "./gitOps.js";
import { parseGitStatusEntries } from "./reviewOps.js";
import {
  rankContextFiles,
  suggestedNextCalls,
  type ContextProfile,
  type ContextSignalScores
} from "./contextRanker.js";
import { buildProjectMap, importNeighborPaths } from "./projectMapOps.js";
import { memoryPathsForContext, searchProjectMemory } from "./projectMemory.js";

const resultCache = new Map<string, { createdAt: number; value: ContextPackResult }>();
const RESULT_CACHE_TTL_MS = 5_000;

export function invalidateContextPack(workspaceId?: string): void {
  if (!workspaceId) return resultCache.clear();
  for (const key of resultCache.keys()) if (key.startsWith(`${workspaceId}:`)) resultCache.delete(key);
}

export interface ContextPackSnippet {
  path: string;
  startLine: number;
  endLine: number;
  reason: string;
  text: string;
  score?: number;
  scoreBreakdown?: Partial<ContextSignalScores>;
}

export interface ContextPackResult {
  text: string;
  summary: string;
  task: string;
  profile: ContextProfile;
  candidateFiles: string[];
  selectedFiles?: Array<{
    path: string;
    reason: string;
    score: number;
    scoreBreakdown: Partial<ContextSignalScores>;
    snippets: Array<{ startLine: number; endLine: number; text: string }>;
  }>;
  snippets: ContextPackSnippet[];
  skipped: Array<{ path: string; reason: string }>;
  omitted?: { files: number; snippets: number; reasons: string[] };
  packageContext?: Record<string, unknown>;
  git?: { branch?: string; statusSummary?: string };
  suggestedNextCalls?: string[];
  rawRetrievalKey?: string;
  truncated: boolean;
}

export interface ContextPackOptions {
  task: string;
  query?: string;
  profile?: ContextProfile;
  explain?: boolean;
  paths?: string[];
  globs?: string[];
  maxFiles: number;
  maxSnippets: number;
  maxBytes: number;
  maxTokensEstimate?: number;
  includeGitStatus?: boolean;
  includePackageContext?: boolean;
  /** Force import-neighbor project map. Default: only when query/paths signal need it. */
  includeImportNeighbors?: boolean;
  signal?: AbortSignal;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function summarizePackageContext(packageHit: { value: unknown } | undefined): Record<string, unknown> | undefined {
  if (!packageHit || !packageHit.value || typeof packageHit.value !== "object") return undefined;
  const value = packageHit.value as Record<string, unknown>;
  return {
    name: value.name,
    scripts: value.scripts,
    dependencies: value.dependencies ? Object.keys(value.dependencies as Record<string, unknown>).slice(0, 15) : undefined,
    devDependencies: value.devDependencies ? Object.keys(value.devDependencies as Record<string, unknown>).slice(0, 15) : undefined
  };
}

function linesFromContext(context: string): { startLine: number; endLine: number } {
  const lines = context.split("\n").map((line) => Number(line.match(/^(\d+)/)?.[1] ?? 0)).filter((n) => n > 0);
  return {
    startLine: lines[0] ?? 1,
    endLine: lines[lines.length - 1] ?? 1
  };
}

function branchFromStatus(status: string | undefined): string | undefined {
  if (!status) return undefined;
  const line = status.split("\n").find((row) => row.startsWith("##"));
  if (!line) return undefined;
  return line.replace("##", "").trim();
}

/**
 * Build import neighbors only when the request signals they help ranking.
 * Cold project-map can parse up to 1,000 files — skip for broad listing-only packs.
 */
function shouldBuildImportNeighbors(options: ContextPackOptions, seedPaths: string[]): boolean {
  if (options.includeImportNeighbors === false) return false;
  if (options.includeImportNeighbors === true) return seedPaths.length > 0;
  if (seedPaths.length === 0) return false;
  const profile = options.profile ?? "edit";
  // Explore/review packs usually need files + git, not a full import graph rebuild.
  if (profile === "explore" || profile === "review") {
    const query = (options.query ?? "").toLowerCase();
    const task = options.task.toLowerCase();
    return /\b(import|exports?|module|symbol|callers?|callees?|dependency|dependencies|refactor)\b/.test(`${query} ${task}`);
  }
  const query = (options.query ?? "").toLowerCase();
  const task = options.task.toLowerCase();
  const importSignal =
    Boolean(options.query) ||
    Boolean(options.paths?.length) ||
    /\b(import|exports?|module|symbol|callers?|callees?|dependency|dependencies|refactor)\b/.test(`${query} ${task}`);
  return importSignal || profile === "edit" || profile === "debug";
}

export async function contextPack(
  config: LeastConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: ContextPackOptions
): Promise<ContextPackResult> {
  const profile = options.profile ?? "edit";
  const maxBytes = Math.min(options.maxBytes, options.maxTokensEstimate ? options.maxTokensEstimate * 4 : options.maxBytes);
  const candidateFiles: string[] = [];
  const snippets: ContextPackSnippet[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];

  for (const relPath of options.paths ?? []) candidateFiles.push(relPath);

  // Run independent discovery work concurrently: globs, query search, git, memory, optional package.
  const globPromise = Promise.all(
    (options.globs ?? []).map(async (glob) => {
      const files = await listWorkspaceFiles(config, guard, workspace, {
        glob,
        maxResults: options.maxFiles,
        trackedOnly: false,
        includeHidden: false
      });
      return files.files;
    })
  );

  const searchPromise = options.query
    ? searchWorkspaceContext(config, guard, workspace, {
        query: options.query,
        maxResults: options.maxSnippets,
        beforeLines: 3,
        afterLines: 6,
        signal: options.signal
      })
    : Promise.resolve(undefined);

  const gitPromise = options.includeGitStatus ? gitStatus(config, workspace) : Promise.resolve(undefined);
  const memoryPathsPromise = memoryPathsForContext(config, workspace, options.task);
  const memoryRecordsPromise = config.projectMemory
    ? searchProjectMemory(workspace, options.task, { maxResults: 6 })
    : Promise.resolve([]);
  const packagePromise = options.includePackageContext
    ? queryJsonFiles(config, guard, workspace, { path: "package.json", pointer: "/", maxResults: 1 }).catch(() => undefined)
    : Promise.resolve(undefined);

  const [globResults, search, gitStatusText, memoryPaths, memoryRecords, packageResult] = await Promise.all([
    globPromise,
    searchPromise,
    gitPromise,
    memoryPathsPromise,
    memoryRecordsPromise,
    packagePromise
  ]);

  for (const files of globResults) candidateFiles.push(...files);

  if (search) {
    for (const match of search.matches.slice(0, options.maxSnippets)) {
      const { startLine, endLine } = linesFromContext(match.context);
      snippets.push({
        path: match.path,
        startLine,
        endLine,
        reason: `Matched query: ${options.query}`,
        text: match.context
      });
      candidateFiles.push(match.path);
    }
  }

  if (candidateFiles.length < options.maxFiles) {
    const listed = await listWorkspaceFiles(config, guard, workspace, {
      maxResults: Math.max(options.maxFiles * 3, 40),
      trackedOnly: false,
      includeHidden: false
    });
    candidateFiles.push(...listed.files);
  }

  const changedFiles = gitStatusText ? parseGitStatusEntries(gitStatusText).map((entry) => entry.path) : [];
  const candidateState = await Promise.all(unique(candidateFiles).map(async (relPath) => {
    try {
      const stat = await fsp.stat(guard.resolve(workspace, relPath).absPath, { bigint: true });
      return `${relPath}:${stat.size}:${stat.mtimeNs}`;
    } catch {
      return `${relPath}:missing`;
    }
  }));
  const stateKey = `${workspace.id}:${JSON.stringify({ options: { ...options, signal: undefined }, candidateState, gitStatusText })}`;
  const cached = resultCache.get(stateKey);
  if (cached && Date.now() - cached.createdAt < RESULT_CACHE_TTL_MS) return cached.value;
  const seedForImports = unique([...candidateFiles, ...changedFiles]).slice(0, 12);

  let importNeighbors: string[] = [];
  if (shouldBuildImportNeighbors(options, seedForImports)) {
    try {
      const projectMap = await buildProjectMap(config, guard, workspace, { includeImports: true, includeTests: false });
      importNeighbors = importNeighborPaths(projectMap.symbols, seedForImports);
    } catch {
      importNeighbors = [];
    }
  }

  const ranked = rankContextFiles({
    task: options.task,
    query: options.query,
    profile,
    candidates: unique([...candidateFiles, ...importNeighbors]),
    changedFiles,
    memoryPaths,
    importNeighbors
  });
  const uniqueCandidates = ranked.slice(0, options.maxFiles).map((item) => item.path);

  // Reuse search snippets instead of re-reading matched files.
  const filesToRead = uniqueCandidates
    .filter((file) => !snippets.some((snippet) => snippet.path === file))
    .map((file) => ({ path: file }));
  const read = filesToRead.length
    ? await readManyTextFiles(config, guard, workspace, filesToRead, {
        maxTotalBytes: maxBytes,
        includeSha256: false,
        includeLineNumbers: true,
        includeTotalLines: false,
        concurrency: 8,
        signal: options.signal
      })
    : { files: [], truncated: false, text: "" };

  for (const file of read.files) {
    const rank = ranked.find((item) => item.path === file.path);
    snippets.push({
      path: file.path,
      startLine: file.startLine,
      endLine: file.endLine,
      reason: rank?.reason ?? "High-ranked candidate file",
      text: file.text,
      score: rank?.score,
      scoreBreakdown: rank?.scoreBreakdown
    });
  }

  const missing = uniqueCandidates.filter((candidate) => !snippets.some((snippet) => snippet.path === candidate));
  for (const file of missing) skipped.push({ path: file, reason: "excluded by byte budget or read truncation" });

  let packageContext = summarizePackageContext(packageResult?.hits[0]);
  if (options.includePackageContext && !packageContext) {
    const packageJsonPath = uniqueCandidates.find((file) => path.basename(file) === "package.json") ?? "package.json";
    const pkg = await queryJsonFiles(config, guard, workspace, { path: packageJsonPath, pointer: "/", maxResults: 1 });
    packageContext = summarizePackageContext(pkg.hits[0]);
  }

  const selectedFiles = ranked.slice(0, options.maxFiles).map((item) => ({
    path: item.path,
    reason: item.reason,
    score: item.score,
    scoreBreakdown: item.scoreBreakdown,
    snippets: snippets
      .filter((snippet) => snippet.path === item.path)
      .map((snippet) => ({ startLine: snippet.startLine, endLine: snippet.endLine, text: snippet.text }))
  }));

  const nextCalls = suggestedNextCalls(profile, ranked);
  const summaryParts = [
    `Task: ${options.task}`,
    `Profile: ${profile}`,
    `Selected files: ${uniqueCandidates.length}`,
    `Snippets: ${snippets.length}`,
    importNeighbors.length ? `Import neighbors: ${importNeighbors.length}.` : undefined,
    memoryRecords.length ? `Project memory hits: ${memoryRecords.length}.` : undefined,
    gitStatusText ? "Included git status." : undefined,
    packageContext ? "Included package context." : undefined
  ].filter(Boolean);

  const explainBlocks = options.explain
    ? selectedFiles.map((file) => `- ${file.path} (score ${file.score}): ${file.reason}`).join("\n")
    : uniqueCandidates.map((file) => `- ${file}`).join("\n");

  const textParts = [
    "# Context Pack",
    "",
    summaryParts.join("\n"),
    gitStatusText ? `\n## Git Status\n\n\`\`\`text\n${gitStatusText}\n\`\`\`` : "",
    packageContext ? `\n## Package Context\n\n\`\`\`json\n${JSON.stringify(packageContext, null, 2)}\n\`\`\`` : "",
    memoryRecords.length ? `\n## Project Memory\n\n${memoryRecords.map((record) => `- [${record.kind}] ${record.text}`).join("\n")}` : "",
    "\n## Selected Files\n",
    explainBlocks || "None",
    "\n## Snippets\n",
    snippets
      .slice(0, options.maxSnippets)
      .map(
        (snippet) =>
          `### ${snippet.path}:${snippet.startLine}-${snippet.endLine}\nReason: ${snippet.reason}${snippet.score !== undefined ? ` (score ${snippet.score})` : ""}\n\n\`\`\`text\n${snippet.text}\n\`\`\``
      )
      .join("\n\n"),
    `\n## Suggested Next Calls\n${nextCalls.map((call) => `- ${call}`).join("\n")}`,
    skipped.length ? `\n## Skipped\n\n${skipped.map((item) => `- ${item.path}: ${item.reason}`).join("\n")}` : ""
  ];

  const result: ContextPackResult = {
    text: textParts.join("\n"),
    summary: summaryParts.join(" "),
    task: options.task,
    profile,
    candidateFiles: uniqueCandidates,
    selectedFiles,
    snippets: snippets.slice(0, options.maxSnippets),
    skipped,
    omitted: {
      files: Math.max(0, ranked.length - uniqueCandidates.length),
      snippets: Math.max(0, snippets.length - options.maxSnippets),
      reasons: skipped.map((item) => item.reason)
    },
    packageContext,
    git: gitStatusText ? { branch: branchFromStatus(gitStatusText), statusSummary: gitStatusText.split("\n").slice(0, 6).join("\n") } : undefined,
    suggestedNextCalls: nextCalls,
    truncated: Boolean(read.truncated) || snippets.length > options.maxSnippets
  };
  resultCache.set(stateKey, { createdAt: Date.now(), value: result });
  if (resultCache.size > 32) resultCache.delete(resultCache.keys().next().value!);
  return result;
}
