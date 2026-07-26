import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import { minimatch } from "minimatch";
import type { LeastConfig } from "./config.js";
import type { Workspace } from "./guard.js";
import { LeastError, displayPath, normalizeRelPath, PathGuard } from "./guard.js";
import {
  COMPACT_DIFF_MAX_CHARS,
  FULL_DIFF_MAX_CHARS,
  STORAGE_DIFF_MAX_CHARS,
  type DiffComputeMode,
  type PreparedTextContent,
  emptyDiffMeta,
  type MutationDiffMeta
} from "./mutationTypes.js";
import { recordCacheOutcome, recordFsTiming, recordGuardTiming, recordPartial } from "./perf.js";
import { hasSecretValue, redactSensitiveText } from "./redact.js";
import { ToolTimeoutError, throwIfAborted } from "./timeout.js";
import { offloadedUnifiedDiff, shouldOffloadUnifiedDiff } from "./workerOps.js";
import {
  getCachedFileSnapshot,
  invalidateFileSnapshot,
  readTextWithSnapshot,
  setCachedFileSnapshot
} from "./fileSnapshotCache.js";

export type { DiffComputeMode, PreparedTextContent, MutationDiffMeta } from "./mutationTypes.js";

/** Encode once, hash once. Reuse buffer + digest across write/cache/response. */
export function prepareTextContent(text: string): PreparedTextContent {
  const buffer = Buffer.from(text, "utf8");
  return {
    text,
    buffer,
    bytes: buffer.length,
    sha256: createHash("sha256").update(buffer).digest("hex")
  };
}

export interface TreeOptions {
  path?: string;
  maxDepth: number;
  includeHidden: boolean;
  maxEntries: number;
}

export interface TreeResult {
  text: string;
  entries: number;
  truncated: boolean;
}

export interface ReadFileResult {
  path: string;
  text: string;
  startLine: number;
  endLine: number;
  totalLines?: number;
  /** Returned model-visible bytes for the selected range. */
  bytes: number;
  /** Full on-disk file bytes. */
  fileBytes?: number;
  /** Alias for bytes — returned range bytes. */
  returnedBytes?: number;
  sha256?: string;
  truncated: boolean;
  partial?: boolean;
  timedOut?: boolean;
}

export interface ReadManyItem {
  path: string;
  startLine?: number;
  endLine?: number;
}

export interface ReadManyResult {
  text: string;
  files: ReadFileResult[];
  totalBytes: number;
  truncated: boolean;
  partial?: boolean;
  timedOut?: boolean;
}

export interface DiffResult {
  diff: string;
  additions: number;
  deletions: number;
  changed: boolean;
  /** Complete (or storage-capped) diff for retrieval storage. */
  storageDiff?: string;
  /** Visible preview text (may equal diff). */
  preview?: string;
  /** False when storageDiff hit the storage cap. */
  complete?: boolean;
  /** Whether line stats were computed (false in summary mode). */
  statsComputed?: boolean;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").split("\n");
}

function withLineNumbers(lines: string[], startLine: number): string {
  const width = String(startLine + lines.length - 1).length;
  return lines.map((line, idx) => `${String(startLine + idx).padStart(width, " ")} | ${line}`).join("\n");
}

export function makeUnifiedDiff(oldText: string, newText: string, relPath: string, maxChars = 60_000): DiffResult {
  if (oldText === newText) {
    return { diff: `No changes in ${relPath}.`, additions: 0, deletions: 0, changed: false };
  }

  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const coreOldStart = prefix;
  const coreOldEnd = oldLines.length - suffix;
  const coreNewStart = prefix;
  const coreNewEnd = newLines.length - suffix;
  const context = 3;
  const oldStart = Math.max(0, coreOldStart - context);
  const oldEnd = Math.min(oldLines.length, coreOldEnd + context);
  const newStart = Math.max(0, coreNewStart - context);
  const newEnd = Math.min(newLines.length, coreNewEnd + context);

  const additions = Math.max(0, coreNewEnd - coreNewStart);
  const deletions = Math.max(0, coreOldEnd - coreOldStart);

  const out: string[] = [`--- a/${relPath}`, `+++ b/${relPath}`, `@@ -${oldStart + 1},${oldEnd - oldStart} +${newStart + 1},${newEnd - newStart} @@`];

  for (let i = oldStart; i < coreOldStart; i += 1) out.push(` ${oldLines[i]}`);
  for (let i = coreOldStart; i < coreOldEnd; i += 1) out.push(`-${oldLines[i]}`);
  for (let i = coreNewStart; i < coreNewEnd; i += 1) out.push(`+${newLines[i]}`);
  for (let i = coreOldEnd; i < oldEnd; i += 1) out.push(` ${oldLines[i]}`);

  let diff = out.join("\n");
  if (diff.length > maxChars) {
    diff = diff.slice(0, maxChars) + `\n...[diff truncated to ${maxChars} chars]`;
  }
  return { diff: redactSensitiveText(diff), additions, deletions, changed: true };
}

export async function makeUnifiedDiffMaybeOffloaded(oldText: string, newText: string, relPath: string, maxChars = 60_000): Promise<DiffResult> {
  if (!shouldOffloadUnifiedDiff(oldText, newText)) {
    return makeUnifiedDiff(oldText, newText, relPath, maxChars);
  }
  const diff = await offloadedUnifiedDiff(oldText, newText, relPath, maxChars);
  return { ...diff, diff: redactSensitiveText(diff.diff) };
}

/**
 * Compute a mutation diff according to response policy.
 *
 * - summary: no unified diff; additions/deletions are null (stats omitted).
 * - compact/full: generate a storage-bound complete diff, then a separate visible preview.
 *   Callers should store `storageDiff` under a retrieval key and put only `preview` in
 *   structured content (never both text and structured).
 */
export async function computeMutationDiff(
  oldText: string,
  newText: string,
  relPath: string,
  mode: DiffComputeMode,
  maxChars?: number,
  options: { storageMaxChars?: number } = {}
): Promise<MutationDiffMeta> {
  if (mode === "none") {
    return emptyDiffMeta();
  }
  const previewLimit =
    maxChars ?? (mode === "compact" ? COMPACT_DIFF_MAX_CHARS : FULL_DIFF_MAX_CHARS);
  const storageLimit = Math.max(
    previewLimit,
    options.storageMaxChars ?? STORAGE_DIFF_MAX_CHARS
  );

  // Complete (or storage-capped) diff first — this is what retrieval keys should hold.
  const complete = await makeUnifiedDiffMaybeOffloaded(oldText, newText, relPath, storageLimit);
  const storageTruncated = complete.diff.includes("[diff truncated");

  let preview = complete.diff;
  let previewTruncated = false;
  if (preview.length > previewLimit) {
    preview = preview.slice(0, previewLimit) + `\n...[diff truncated to ${previewLimit} chars]`;
    previewTruncated = true;
  }

  return {
    additions: complete.additions,
    deletions: complete.deletions,
    changed: complete.changed,
    statsComputed: true,
    storageDiff: complete.diff,
    storageTruncated,
    complete: !storageTruncated,
    preview,
    // legacy alias used by older write/edit return shapes
    diff: preview,
    truncated: previewTruncated || storageTruncated
  };
}

function isHiddenName(name: string): boolean {
  return name.startsWith(".") && name !== "." && name !== "..";
}

async function measureFs<T>(fn: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    return await fn();
  } finally {
    recordFsTiming(performance.now() - started);
  }
}

function measureGuard<T>(fn: () => T): T {
  const started = performance.now();
  try {
    return fn();
  } finally {
    recordGuardTiming(performance.now() - started);
  }
}

function renderedLineBytes(line: string, lineNumber: number, includeLineNumbers: boolean, lineNumberWidth: number): number {
  if (!includeLineNumbers) {
    return Buffer.byteLength(line, "utf8");
  }
  return Buffer.byteLength(`${String(lineNumber).padStart(lineNumberWidth, " ")} | ${line}`, "utf8");
}

async function readRangeFromStream(
  absPath: string,
  startLine: number,
  requestedEndLine: number,
  includeTotalLines: boolean,
  options: {
    signal?: AbortSignal;
    maxReturnedBytes?: number;
    includeLineNumbers?: boolean;
  } = {}
): Promise<{ lines: string[]; totalLines?: number; timedOut: boolean; partial: boolean; truncatedByBudget: boolean }> {
  const lines: string[] = [];
  const stream = fs.createReadStream(absPath, { encoding: "utf8" });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  let totalLines = 0;
  let timedOut = false;
  let partial = false;
  let truncatedByBudget = false;
  const includeLineNumbers = options.includeLineNumbers !== false;
  const lineNumberWidth = String(requestedEndLine).length;
  const maxReturnedBytes = options.maxReturnedBytes;
  let collectedBytes = 0;

  const onAbort = () => {
    timedOut = options.signal?.reason instanceof ToolTimeoutError;
    partial = true;
    reader.close();
    stream.destroy(options.signal?.reason instanceof Error ? options.signal.reason : undefined);
  };

  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for await (const line of reader) {
      totalLines += 1;
      if (totalLines >= startLine && totalLines <= requestedEndLine) {
        const lineBytes = renderedLineBytes(line, totalLines, includeLineNumbers, lineNumberWidth);
        const separatorBytes = lines.length > 0 ? 1 : 0;
        if (maxReturnedBytes !== undefined && collectedBytes + separatorBytes + lineBytes > maxReturnedBytes) {
          truncatedByBudget = true;
          partial = true;
          break;
        }
        lines.push(line);
        collectedBytes += separatorBytes + lineBytes;
      }
      if (!includeTotalLines && totalLines >= requestedEndLine && !truncatedByBudget) {
        break;
      }
      if (options.signal?.aborted) {
        timedOut = options.signal.reason instanceof ToolTimeoutError;
        partial = true;
        break;
      }
      if (truncatedByBudget) break;
    }
  } catch (error) {
    if (!(options.signal?.aborted && options.signal.reason instanceof ToolTimeoutError)) {
      throw error;
    }
    timedOut = true;
    partial = true;
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    reader.close();
    if (!stream.destroyed) stream.destroy();
  }

  if (timedOut || truncatedByBudget) {
    recordPartial();
  }
  return {
    lines,
    totalLines: includeTotalLines ? totalLines : undefined,
    timedOut,
    partial: partial || truncatedByBudget,
    truncatedByBudget
  };
}

export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const concurrency = Math.max(1, Math.min(limit, items.length || 1));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      results[current] = await fn(items[current] as T, current);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

export async function repoTree(config: LeastConfig, guard: PathGuard, workspace: Workspace, options: TreeOptions): Promise<TreeResult> {
  const target = guard.resolve(workspace, options.path ?? ".");
  const stat = await fsp.stat(target.absPath);
  if (!stat.isDirectory()) {
    throw new LeastError(`Not a directory: ${target.relPath}`);
  }

  const lines: string[] = [target.relPath === "." ? "." : `${target.relPath}/`];
  let entries = 0;
  let truncated = false;

  async function walk(absDir: string, relDir: string, depth: number, prefix: string): Promise<void> {
    if (depth >= options.maxDepth || truncated) return;
    let dirents = await fsp.readdir(absDir, { withFileTypes: true });
    dirents = dirents
      .filter((entry) => options.includeHidden || !isHiddenName(entry.name))
      .filter((entry) => !guard.isBlockedRelativePath(normalizeRelPath(path.join(relDir, entry.name))))
      .sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });

    for (let i = 0; i < dirents.length; i += 1) {
      if (entries >= options.maxEntries) {
        truncated = true;
        return;
      }
      const entry = dirents[i];
      const isLast = i === dirents.length - 1;
      const branch = isLast ? "└── " : "├── ";
      const childPrefix = prefix + (isLast ? "    " : "│   ");
      const childAbs = path.join(absDir, entry.name);
      const childRel = normalizeRelPath(path.join(relDir, entry.name));
      const displayName = entry.isDirectory() ? `${entry.name}/` : entry.name;
      lines.push(`${prefix}${branch}${displayName}`);
      entries += 1;
      if (entry.isDirectory()) {
        await walk(childAbs, childRel, depth + 1, childPrefix);
      }
      if (truncated) return;
    }
  }

  await walk(target.absPath, target.relPath === "." ? "" : target.relPath, 0, "");
  if (truncated) lines.push(`...[tree truncated after ${entries} entries]`);
  return { text: lines.join("\n"), entries, truncated };
}

export async function listFiles(
  guard: PathGuard,
  workspace: Workspace,
  options: { root?: string; glob?: string; includeHidden?: boolean; maxFiles: number }
): Promise<string[]> {
  const target = guard.resolve(workspace, options.root ?? ".");
  const stat = await fsp.stat(target.absPath);
  const files: string[] = [];

  async function addFile(absFile: string): Promise<void> {
    const rel = displayPath(absFile, workspace.root);
    if (guard.isBlockedRelativePath(rel)) return;
    if (!options.includeHidden && rel.split("/").some(isHiddenName)) return;
    if (options.glob && !minimatch(rel, options.glob, { dot: true })) return;
    files.push(rel);
  }

  async function walk(absDir: string): Promise<void> {
    if (files.length >= options.maxFiles) return;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= options.maxFiles) return;
      const abs = path.join(absDir, entry.name);
      const rel = displayPath(abs, workspace.root);
      if (guard.isBlockedRelativePath(rel)) continue;
      if (!options.includeHidden && rel.split("/").some(isHiddenName)) continue;
      if (entry.isDirectory()) await walk(abs);
      else if (entry.isFile()) await addFile(abs);
    }
  }

  if (stat.isFile()) await addFile(target.absPath);
  else await walk(target.absPath);
  return files;
}

export async function fileContentSha256(
  config: LeastConfig,
  guard: PathGuard,
  workspace: Workspace,
  filePath: string
): Promise<{ exists: boolean; sha256?: string }> {
  const resolved = guard.resolve(workspace, filePath);
  if (!fs.existsSync(resolved.absPath)) {
    return { exists: false };
  }
  const maxBytes = Math.max(config.maxWriteBytes, config.maxReadBytes);
  const stat = await guard.assertTextFile(resolved.absPath, maxBytes);
  const snapshot = await readTextWithSnapshot(resolved.absPath, { maxBytes, knownStat: stat });
  if (snapshot.cacheHit) recordCacheOutcome(true);
  else recordCacheOutcome(false);
  return { exists: true, sha256: snapshot.sha256 };
}

export async function readManyTextFiles(
  config: LeastConfig,
  guard: PathGuard,
  workspace: Workspace,
  items: ReadManyItem[],
  options: {
    maxTotalBytes?: number;
    concurrency?: number;
    includeSha256?: boolean;
    includeLineNumbers?: boolean;
    includeTotalLines?: boolean;
    signal?: AbortSignal;
  } = {}
): Promise<ReadManyResult> {
  if (!items.length) throw new LeastError("items must include at least one file.");
  const maxTotalBytes = Math.min(options.maxTotalBytes ?? config.maxReadBytes * 3, config.maxReadBytes * 10);
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 8, 16));

  // Deduplicate request list before parallel execution to avoid race-duplicate reads.
  const uniqueItems: ReadManyItem[] = [];
  const seenKeys = new Set<string>();
  for (const item of items) {
    const key = `${item.path}\u0000${item.startLine ?? ""}\u0000${item.endLine ?? ""}\u0000${options.includeSha256 ? "sha" : "no-sha"}\u0000${options.includeLineNumbers === false ? "plain" : "numbered"}\u0000${options.includeTotalLines ? "totals" : "fast"}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    uniqueItems.push(item);
  }

  // Shared atomic-ish budget: stop scheduling new work once exhausted (best-effort across workers).
  let budgetRemaining = maxTotalBytes;
  let budgetExhausted = false;

  const resolved = await mapWithConcurrency(uniqueItems, concurrency, async (item) => {
    if (options.signal?.aborted || budgetExhausted || budgetRemaining <= 0) {
      return undefined;
    }
    const result = await readTextFile(config, guard, workspace, item.path, {
      startLine: item.startLine,
      endLine: item.endLine,
      maxBytes: Math.min(config.maxReadBytes, Math.max(1, budgetRemaining)),
      includeSha256: options.includeSha256,
      includeLineNumbers: options.includeLineNumbers,
      includeTotalLines: options.includeTotalLines,
      signal: options.signal
    });
    const returnedBytes = result.returnedBytes ?? result.bytes;
    if (returnedBytes > budgetRemaining) {
      budgetExhausted = true;
      return undefined;
    }
    budgetRemaining -= returnedBytes;
    if (budgetRemaining <= 0) budgetExhausted = true;
    return result;
  });

  const files: ReadFileResult[] = [];
  let totalBytes = 0;
  let truncated = budgetExhausted;
  let partial = false;
  let timedOut = false;

  for (const result of resolved) {
    if (!result) {
      truncated = true;
      continue;
    }
    if (options.signal?.aborted) {
      partial = true;
      timedOut = options.signal.reason instanceof ToolTimeoutError;
      truncated = true;
      break;
    }
    const returnedBytes = result.returnedBytes ?? result.bytes;
    if (totalBytes + returnedBytes > maxTotalBytes) {
      truncated = true;
      break;
    }
    files.push(result);
    totalBytes += returnedBytes;
    partial = partial || result.partial === true;
    timedOut = timedOut || result.timedOut === true;
    if (result.truncated && result.totalLines !== undefined) {
      truncated = true;
    }
  }

  const text = files
    .map(
      (file) =>
        `### ${file.path}\nLines: ${file.startLine}-${file.endLine}${file.totalLines !== undefined ? ` of ${file.totalLines}` : ""}\n${file.sha256 ? `SHA-256: ${file.sha256}\n` : ""}${file.partial ? "Partial: true\n" : ""}\n\`\`\`text\n${file.text}\n\`\`\``
    )
    .join("\n\n");
  if (partial) recordPartial();
  return { text, files, totalBytes, truncated, partial, timedOut };
}

export async function readTextFile(
  config: LeastConfig,
  guard: PathGuard,
  workspace: Workspace,
  filePath: string,
  options: {
    startLine?: number;
    endLine?: number;
    maxBytes?: number;
    includeSha256?: boolean;
    includeLineNumbers?: boolean;
    includeTotalLines?: boolean;
    signal?: AbortSignal;
  } = {}
): Promise<ReadFileResult> {
  throwIfAborted(options.signal);
  const resolved = measureGuard(() => guard.resolve(workspace, filePath));
  const maxBytes = Math.min(options.maxBytes ?? config.maxReadBytes, config.maxReadBytes);
  const startLine = Math.max(1, Math.floor(options.startLine ?? 1));
  const requestedEndLine = options.endLine !== undefined ? Math.max(1, Math.floor(options.endLine)) : undefined;
  const rangeRequested = options.startLine !== undefined || options.endLine !== undefined;
  const includeSha256 = options.includeSha256 === true;
  const stat = await measureFs(() =>
    rangeRequested && !includeSha256
      ? guard.assertReadableTextFileForRangeRead(resolved.absPath)
      : guard.assertTextFile(resolved.absPath, maxBytes)
  );
  if (requestedEndLine !== undefined && requestedEndLine < startLine) {
    throw new LeastError(`end_line (${requestedEndLine}) must be >= start_line (${startLine}).`);
  }
  const includeLineNumbers = options.includeLineNumbers !== false;
  const shouldReturnTotalLines =
    options.includeTotalLines === true || requestedEndLine === undefined || (startLine === 1 && requestedEndLine === undefined);

  const canUseStreamFastPath = rangeRequested && !includeSha256 && requestedEndLine !== undefined && options.includeTotalLines !== true;
  if (canUseStreamFastPath) {
    // Prefer cached full text for range slices when available (avoids re-streaming cold scans).
    const cached = getCachedFileSnapshot(resolved.absPath, stat);
    if (cached) {
      recordCacheOutcome(true);
      const allLines = splitLines(cached.text);
      const endLine = Math.min(allLines.length, requestedEndLine as number);
      const selected = allLines.slice(startLine - 1, endLine);
      const text = includeLineNumbers ? withLineNumbers(selected, startLine) : selected.join("\n");
      const returnedBytes = Buffer.byteLength(text, "utf8");
      const truncatedByBudget = returnedBytes > maxBytes;
      const finalText = truncatedByBudget ? text.slice(0, maxBytes) : text;
      return {
        path: resolved.relPath,
        text: finalText,
        startLine,
        endLine: Math.max(startLine, endLine),
        totalLines: undefined,
        bytes: Buffer.byteLength(finalText, "utf8"),
        fileBytes: stat.size,
        returnedBytes: Buffer.byteLength(finalText, "utf8"),
        sha256: undefined,
        truncated: truncatedByBudget || endLine < (requestedEndLine as number),
        partial: truncatedByBudget
      };
    }
    recordCacheOutcome(false);
    const streamed = await measureFs(() =>
      readRangeFromStream(resolved.absPath, startLine, requestedEndLine as number, false, {
        signal: options.signal,
        maxReturnedBytes: maxBytes,
        includeLineNumbers
      })
    );
    const text = includeLineNumbers ? withLineNumbers(streamed.lines, startLine) : streamed.lines.join("\n");
    const endLine = streamed.lines.length ? startLine + streamed.lines.length - 1 : startLine;
    const returnedBytes = Buffer.byteLength(text, "utf8");
    const rangeIncomplete = endLine < (requestedEndLine as number);
    return {
      path: resolved.relPath,
      text,
      startLine,
      endLine: Math.max(startLine, endLine),
      totalLines: undefined,
      bytes: returnedBytes,
      fileBytes: stat.size,
      returnedBytes,
      sha256: undefined,
      truncated: streamed.truncatedByBudget || rangeIncomplete,
      partial: streamed.partial,
      timedOut: streamed.timedOut
    };
  }

  // Full-file path: reuse snapshot cache when size/mtime match.
  const snapshot = await measureFs(() => readTextWithSnapshot(resolved.absPath, { maxBytes: Math.max(maxBytes, config.maxReadBytes) }));
  throwIfAborted(options.signal);
  if (snapshot.cacheHit) recordCacheOutcome(true);
  else recordCacheOutcome(false);
  const text = snapshot.text;
  const allLines = splitLines(text);
  const totalLines = allLines.length;
  const endLine = Math.min(totalLines, requestedEndLine ?? totalLines);
  const selected = allLines.slice(startLine - 1, endLine);
  const rendered = includeLineNumbers ? withLineNumbers(selected, startLine) : selected.join("\n");
  const truncated = startLine > 1 || endLine < totalLines;
  const returnedBytes = Buffer.byteLength(rendered, "utf8");
  return {
    path: resolved.relPath,
    text: rendered,
    startLine,
    endLine,
    totalLines: shouldReturnTotalLines ? totalLines : undefined,
    bytes: returnedBytes,
    fileBytes: snapshot.size,
    returnedBytes,
    sha256: includeSha256 ? snapshot.sha256 : undefined,
    truncated
  };
}

export interface WriteTextFileOptions {
  createDirs?: boolean;
  overwrite?: boolean;
  /** Control unified-diff generation. Default: full (backward compatible). */
  diffMode?: DiffComputeMode;
  maxDiffChars?: number;
  /** Precomputed content (encode/hash once). */
  prepared?: PreparedTextContent;
  /** When provided, skip re-reading the original for diff/existence. */
  beforeText?: string;
  existed?: boolean;
}

export async function writeTextFile(
  config: LeastConfig,
  guard: PathGuard,
  workspace: Workspace,
  filePath: string,
  content: string,
  options: WriteTextFileOptions = {}
): Promise<{ path: string; bytes: number; sha256: string; existed: boolean; diff: DiffResult }> {
  const resolved = guard.resolve(workspace, filePath, { forWrite: true });
  const prepared = options.prepared ?? prepareTextContent(content);
  if (prepared.bytes > config.maxWriteBytes) {
    throw new LeastError(`Write content is too large (${prepared.bytes} bytes). Limit: ${config.maxWriteBytes} bytes.`);
  }
  if (hasSecretValue(prepared.text)) {
    throw new LeastError("Secret-looking content is blocked from write. Use placeholders such as [REDACTED_SECRET] in handoff files.");
  }

  const diffMode = options.diffMode ?? "full";
  let oldText = options.beforeText ?? "";
  let existed = options.existed ?? false;
  if (options.beforeText === undefined && options.existed === undefined) {
    // Summary mode without a pre-supplied beforeText only needs existence for overwrite checks.
    // Full content is required when a unified diff will be computed.
    const needsOldContent = diffMode !== "none";
    try {
      if (needsOldContent) {
        const stat = await guard.assertTextFile(resolved.absPath, Math.max(config.maxWriteBytes, config.maxReadBytes));
        const snapshot = await readTextWithSnapshot(resolved.absPath, {
          maxBytes: Math.max(config.maxWriteBytes, config.maxReadBytes),
          knownStat: stat
        });
        if (snapshot.cacheHit) recordCacheOutcome(true);
        else recordCacheOutcome(false);
        oldText = snapshot.text;
        existed = true;
      } else {
        // Existence, type, size, and binary validation in one stat/sample pass.
        await guard.assertTextFile(resolved.absPath, Math.max(config.maxWriteBytes, config.maxReadBytes));
        existed = true;
        oldText = "";
      }
    } catch (error) {
      if (error instanceof LeastError && error.message.startsWith("Not a file")) throw error;
      if (error instanceof LeastError && error.message.startsWith("File is too large")) throw error;
      if (error instanceof LeastError && error.message.includes("binary")) throw error;
      if (error instanceof LeastError && error.message.startsWith("Refusing")) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || !fs.existsSync(resolved.absPath)) {
        existed = false;
        oldText = "";
      } else {
        throw error;
      }
    }
  }

  if (existed && options.overwrite === false) {
    throw new LeastError(`File already exists and overwrite=false: ${resolved.relPath}`);
  }
  if (options.createDirs !== false) {
    await fsp.mkdir(path.dirname(resolved.absPath), { recursive: true });
  } else {
    const parent = path.dirname(resolved.absPath);
    try {
      const parentStat = await fsp.stat(parent);
      if (!parentStat.isDirectory()) {
        throw new LeastError(`Parent path is not a directory (create_dirs=false): ${path.dirname(resolved.relPath)}`);
      }
    } catch (error) {
      if (error instanceof LeastError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new LeastError(`Parent directory does not exist (create_dirs=false): ${path.dirname(resolved.relPath)}`);
      }
      throw error;
    }
  }

  const diffMeta = await computeMutationDiff(oldText, prepared.text, resolved.relPath, diffMode, options.maxDiffChars, {
    storageMaxChars: config.outputStoreMaxItemBytes
  });
  const preview = diffMeta.preview ?? diffMeta.diff ?? `No changes in ${resolved.relPath}.`;
  const diff: DiffResult = {
    diff: preview,
    preview,
    additions: diffMeta.additions ?? 0,
    deletions: diffMeta.deletions ?? 0,
    changed: diffMeta.changed,
    storageDiff: diffMeta.storageDiff,
    complete: diffMeta.complete,
    statsComputed: diffMeta.statsComputed
  };
  await fsp.writeFile(resolved.absPath, prepared.buffer);
  invalidateFileSnapshot(resolved.absPath);
  try {
    const nextStat = await fsp.stat(resolved.absPath);
    setCachedFileSnapshot(resolved.absPath, nextStat, prepared.text, prepared.sha256);
  } catch {
    // Best-effort cache warm after write.
  }
  return { path: resolved.relPath, bytes: prepared.bytes, sha256: prepared.sha256, existed, diff };
}

export interface EditTextFileOptions {
  replaceAll?: boolean;
  expectedReplacements?: number;
  /** Control unified-diff generation. Default: full (backward compatible). */
  diffMode?: DiffComputeMode;
  maxDiffChars?: number;
}

export async function editTextFile(
  config: LeastConfig,
  guard: PathGuard,
  workspace: Workspace,
  filePath: string,
  oldText: string,
  newText: string,
  options: EditTextFileOptions = {}
): Promise<{ path: string; replacements: number; bytes: number; sha256: string; diff: DiffResult }> {
  if (!oldText) throw new LeastError("old_text must not be empty.");
  const resolved = guard.resolve(workspace, filePath, { forWrite: true });
  const maxBytes = Math.max(config.maxWriteBytes, config.maxReadBytes);
  const stat = await guard.assertTextFile(resolved.absPath, maxBytes);
  const snapshot = await readTextWithSnapshot(resolved.absPath, { maxBytes, knownStat: stat });
  if (snapshot.cacheHit) recordCacheOutcome(true);
  else recordCacheOutcome(false);
  const before = snapshot.text;
  const occurrences = countOccurrences(before, oldText);
  if (occurrences === 0) {
    throw new LeastError(`old_text was not found in ${resolved.relPath}. Read the file and retry with an exact snippet.`);
  }

  let replacements: number;
  let after: string;
  if (options.replaceAll) {
    after = replaceAllOccurrences(before, oldText, newText);
    replacements = occurrences;
  } else {
    if (occurrences !== 1) {
      throw new LeastError(`old_text matched ${occurrences} times. Provide a more specific old_text or set replace_all=true.`);
    }
    after = before.replace(oldText, newText);
    replacements = 1;
  }

  if (typeof options.expectedReplacements === "number" && replacements !== options.expectedReplacements) {
    throw new LeastError(`Expected ${options.expectedReplacements} replacements but would perform ${replacements}.`);
  }

  const prepared = prepareTextContent(after);
  if (prepared.bytes > config.maxWriteBytes) {
    throw new LeastError(`Edited file would be too large (${prepared.bytes} bytes). Limit: ${config.maxWriteBytes} bytes.`);
  }
  if (hasSecretValue(prepared.text)) {
    throw new LeastError("Secret-looking content is blocked from edit. Use placeholders such as [REDACTED_SECRET] in handoff files.");
  }

  const diffMode = options.diffMode ?? "full";
  const diffMeta = await computeMutationDiff(before, prepared.text, resolved.relPath, diffMode, options.maxDiffChars, {
    storageMaxChars: config.outputStoreMaxItemBytes
  });
  const preview = diffMeta.preview ?? diffMeta.diff ?? `No changes in ${resolved.relPath}.`;
  const diff: DiffResult = {
    diff: preview,
    preview,
    additions: diffMeta.additions ?? 0,
    deletions: diffMeta.deletions ?? 0,
    changed: diffMeta.changed,
    storageDiff: diffMeta.storageDiff,
    complete: diffMeta.complete,
    statsComputed: diffMeta.statsComputed
  };
  await fsp.writeFile(resolved.absPath, prepared.buffer);
  invalidateFileSnapshot(resolved.absPath);
  try {
    const nextStat = await fsp.stat(resolved.absPath);
    setCachedFileSnapshot(resolved.absPath, nextStat, prepared.text, prepared.sha256);
  } catch {
    // Best-effort cache warm after edit.
  }
  return { path: resolved.relPath, replacements, bytes: prepared.bytes, sha256: prepared.sha256, diff };
}

/** Count non-overlapping occurrences of needle in haystack without allocating split arrays. */
function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while (index <= haystack.length - needle.length) {
    const found = haystack.indexOf(needle, index);
    if (found === -1) break;
    count += 1;
    index = found + needle.length;
  }
  return count;
}

function replaceAllOccurrences(haystack: string, needle: string, replacement: string): string {
  if (!needle) return haystack;
  // Avoid split/join double scan for large files.
  if (!haystack.includes(needle)) return haystack;
  return haystack.split(needle).join(replacement);
}

/**
 * Plan an exact edit against in-memory file text without writing.
 * Used by multi_edit transactional preflight.
 */
export function planTextEdit(
  before: string,
  oldText: string,
  newText: string,
  options: { replaceAll?: boolean; expectedReplacements?: number; relPath?: string } = {}
): { after: string; replacements: number } {
  if (!oldText) throw new LeastError("old_text must not be empty.");
  const label = options.relPath ?? "file";
  const occurrences = countOccurrences(before, oldText);
  if (occurrences === 0) {
    throw new LeastError(`old_text was not found in ${label}. Read the file and retry with an exact snippet.`);
  }
  let replacements: number;
  let after: string;
  if (options.replaceAll) {
    after = replaceAllOccurrences(before, oldText, newText);
    replacements = occurrences;
  } else {
    if (occurrences !== 1) {
      throw new LeastError(`old_text matched ${occurrences} times. Provide a more specific old_text or set replace_all=true.`);
    }
    after = before.replace(oldText, newText);
    replacements = 1;
  }
  if (typeof options.expectedReplacements === "number" && replacements !== options.expectedReplacements) {
    throw new LeastError(`Expected ${options.expectedReplacements} replacements but would perform ${replacements}.`);
  }
  return { after, replacements };
}

export async function ensureAiBridge(config: LeastConfig, guard: PathGuard, workspace: Workspace): Promise<string[]> {
  const files: Record<string, string> = {
    "README.md": `# AI Bridge\n\nShared planning context for ChatGPT, other planning models, Codex, OpenCode, Pi, or another local implementation agent.\n\n- current-plan.md: plan produced by ChatGPT or another planning model for the implementation agent.\n- agent-status.md: generic implementation notes, touched files, test results, blockers, and review notes.\n- implementation-diff.patch: final review diff from the implementation agent when practical.\n- codex-status.md: legacy Codex-specific status file, kept for existing workflows.\n- decisions.md: architectural decisions that should remain stable.\n- open-questions.md: unresolved questions.\n- execution-log.jsonl: append-only generic agent handoff and execution events.\n- session-log.jsonl: append-only legacy session events.\n`,
    "current-plan.md": "# Current Plan\n\nNo plan written yet.\n",
    "agent-status.md": "# Agent Status\n\nNo implementation agent status written yet.\n",
    "implementation-diff.patch": "",
    "codex-status.md": "# Codex Status\n\nNo Codex status written yet.\n",
    "decisions.md": "# Decisions\n\n",
    "open-questions.md": "# Open Questions\n\n",
    "execution-log.jsonl": "",
    "session-log.jsonl": ""
  };
  const created: string[] = [];
  for (const [name, content] of Object.entries(files)) {
    const rel = `${config.contextDir}/${name}`;
    const resolved = guard.resolve(workspace, rel, { forWrite: true });
    if (!fs.existsSync(resolved.absPath)) {
      await fsp.mkdir(path.dirname(resolved.absPath), { recursive: true });
      await fsp.writeFile(resolved.absPath, content, "utf8");
      created.push(rel);
    }
  }
  return created;
}
