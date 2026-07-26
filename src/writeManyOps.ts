/**
 * Transactional multi-file write: full preflight, temp writes, sequential renames,
 * best-effort rollback. Not a crash-safe multi-file filesystem atomic operation.
 */

import { createHash } from "node:crypto";
import path from "node:path";
import fsp from "node:fs/promises";
import type { LeastConfig } from "./config.js";
import type { Workspace } from "./guard.js";
import { LeastError, PathGuard } from "./guard.js";
import {
  commitPreparedFileTransaction,
  type PreparedFileTransactionChange
} from "./fileTransaction.js";
import {
  computeMutationDiff,
  mapWithConcurrency,
  prepareTextContent,
  type DiffComputeMode
} from "./fsOps.js";
import {
  invalidateFileSnapshot,
  setCachedFileSnapshot
} from "./fileSnapshotCache.js";
import { hasSecretValue } from "./redact.js";
import type { MutationResponseMode } from "./mutationTypes.js";
import {
  combineDiffParts,
  COMPACT_DIFF_MAX_CHARS,
  diffComputeModeFromResponseMode,
  FULL_DIFF_MAX_CHARS,
  maxDiffCharsForMode
} from "./mutationTypes.js";

export interface WriteManyFileInput {
  path: string;
  content: string;
  createDirs?: boolean;
  overwrite?: boolean;
  expectedSha256?: string;
  expectAbsent?: boolean;
}

export interface WriteManyFileResult {
  path: string;
  existed: boolean;
  bytes: number;
  sha256: string;
  additions: number | null;
  deletions: number | null;
}

export interface WriteManyResult {
  changed_files: number;
  created_files: number;
  overwritten_files: number;
  total_bytes: number;
  additions: number | null;
  deletions: number | null;
  diff_stats_computed: boolean;
  files: WriteManyFileResult[];
  response_mode: MutationResponseMode;
  /** Complete (or storage-capped) combined diff for retrieval storage. */
  storageDiff?: string;
  /** Bounded visible preview for structured content only. */
  previewDiff?: string;
  /** True when storageDiff is complete within the storage cap. */
  diffComplete?: boolean;
  /** True when storage or preview was truncated. */
  diffTruncated?: boolean;
  /** Non-fatal warning if post-preflight work partially failed. */
  warning?: string;
  impact: "content" | "structure";
}

export interface WriteManyOptions {
  responseMode?: MutationResponseMode;
  concurrency?: number;
  authorizePath?: (relPath: string) => void;
  atomic?: boolean;
}

type NormalizedItem = {
  index: number;
  input: WriteManyFileInput;
  relPath: string;
  absPath: string;
  prepared: ReturnType<typeof prepareTextContent>;
  createDirs: boolean;
  overwrite: boolean;
  expectAbsent: boolean;
  expectedSha256?: string;
};

type PreparedItem = NormalizedItem & {
  existed: boolean;
  beforeText: string;
  originalBuffer: Buffer | undefined;
  mustNotExist: boolean;
  storageDiff?: string;
  previewDiff?: string;
  additions: number | null;
  deletions: number | null;
  statsComputed: boolean;
  complete?: boolean;
  truncated?: boolean;
};

/**
 * Validate and atomically write many files.
 * No target is mutated until every item passes preflight.
 */
export async function writeManyFiles(
  config: LeastConfig,
  guard: PathGuard,
  workspace: Workspace,
  files: WriteManyFileInput[],
  options: WriteManyOptions = {}
): Promise<WriteManyResult> {
  if (!files.length) {
    throw new LeastError("write_many requires at least one file.");
  }
  if (files.length > config.maxWriteManyFiles) {
    throw new LeastError(
      `write_many supports at most ${config.maxWriteManyFiles} files (got ${files.length}).`
    );
  }

  const responseMode = options.responseMode ?? "summary";
  const diffMode: DiffComputeMode = diffComputeModeFromResponseMode(responseMode);
  const maxDiffChars = maxDiffCharsForMode(responseMode);
  const concurrency = Math.max(1, Math.min(32, options.concurrency ?? 8));
  const atomic = options.atomic !== false;
  const maxBytes = Math.max(config.maxWriteBytes, config.maxReadBytes);

  if (!atomic) {
    throw new LeastError("write_many currently only supports atomic: true.");
  }

  // Stage 1: sequential normalize, path resolve, duplicates, aggregate limits.
  const normalized: NormalizedItem[] = [];
  const seenAbs = new Set<string>();
  let totalBytes = 0;

  for (let index = 0; index < files.length; index += 1) {
    const item = files[index];
    if (!item || typeof item !== "object") {
      throw new LeastError("Each write_many file item must be an object.");
    }
    const filePath = String(item.path ?? "");
    if (!filePath) throw new LeastError("Each write_many item requires path.");
    const content = String(item.content ?? "");
    const resolved = guard.resolve(workspace, filePath, { forWrite: true });
    options.authorizePath?.(resolved.relPath);

    if (seenAbs.has(resolved.absPath)) {
      throw new LeastError(`Duplicate write_many target path: ${resolved.relPath}`);
    }
    seenAbs.add(resolved.absPath);

    const prepared = prepareTextContent(content);
    if (prepared.bytes > config.maxWriteBytes) {
      throw new LeastError(
        `Write content is too large for ${resolved.relPath} (${prepared.bytes} bytes). Limit: ${config.maxWriteBytes} bytes.`
      );
    }
    totalBytes += prepared.bytes;
    if (totalBytes > config.maxWriteManyBytes) {
      throw new LeastError(
        `write_many total content exceeds limit (${totalBytes} bytes > ${config.maxWriteManyBytes}).`
      );
    }
    if (hasSecretValue(prepared.text)) {
      throw new LeastError(
        `Secret-looking content is blocked from write_many (${resolved.relPath}). Use placeholders such as [REDACTED_SECRET].`
      );
    }

    normalized.push({
      index,
      input: item,
      relPath: resolved.relPath,
      absPath: resolved.absPath,
      prepared,
      createDirs: item.createDirs !== false,
      overwrite: item.overwrite !== false,
      expectAbsent: item.expectAbsent === true,
      expectedSha256: item.expectedSha256
    });
  }

  // Stage 2: bounded parallel FS preflight per target (order restored after).
  // Shared original-byte accounting (sync check+add is race-safe on one event loop).
  const originalBudget = { held: 0 };

  const preparedItems = await mapWithConcurrency(normalized, concurrency, async (item) => {
    let existed = false;
    let beforeText = "";
    let originalBuffer: Buffer | undefined;
    let beforeSha: string | undefined;

    // create_dirs=false: parent must already exist before any temp write.
    if (!item.createDirs) {
      const parent = path.dirname(item.absPath);
      try {
        const parentStat = await fsp.stat(parent);
        if (!parentStat.isDirectory()) {
          throw new LeastError(
            `Parent path is not a directory (create_dirs=false): ${path.dirname(item.relPath)}`
          );
        }
      } catch (error) {
        if (error instanceof LeastError) throw error;
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new LeastError(
            `Parent directory does not exist (create_dirs=false): ${path.dirname(item.relPath)}`
          );
        }
        throw error;
      }
    }

    try {
      // Enforce text-file, size, and binary checks before any full content load.
      await guard.assertTextFile(item.absPath, maxBytes);
      existed = true;
      // Prefer raw buffer for rollback. Decode UTF-8 only when diffs need text.
      originalBuffer = await fsp.readFile(item.absPath);
      // No await between check and add — single-threaded reservation.
      if (originalBudget.held + originalBuffer.length > config.maxWriteManyOriginalBytes) {
        throw new LeastError(
          `write_many original content exceeds rollback memory limit ` +
            `(${originalBudget.held + originalBuffer.length} bytes > ${config.maxWriteManyOriginalBytes}). ` +
            `Reduce batch size or raise LEAST_MAX_WRITE_MANY_ORIGINAL_BYTES.`
        );
      }
      originalBudget.held += originalBuffer.length;
      if (item.expectedSha256) {
        beforeSha = createHash("sha256").update(originalBuffer).digest("hex");
      }
      if (diffMode !== "none") {
        beforeText = originalBuffer.toString("utf8");
      }
    } catch (error) {
      if (error instanceof LeastError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        existed = false;
      } else {
        throw error;
      }
    }

    if (item.expectAbsent && existed) {
      throw new LeastError(`expect_absent=true but file exists: ${item.relPath}`);
    }
    if (item.expectedSha256 && !item.expectAbsent) {
      if (!existed) {
        throw new LeastError(`expected_sha256 set but file missing: ${item.relPath}`);
      }
      if (beforeSha !== item.expectedSha256) {
        throw new LeastError(
          `Stale write for ${item.relPath}: expected ${item.expectedSha256}, found ${beforeSha ?? ""}.`
        );
      }
    }
    if (existed && !item.overwrite) {
      throw new LeastError(`File already exists and overwrite=false: ${item.relPath}`);
    }

    // Diffs before commit so a review-output failure cannot mark a successful mutation as failed.
    let additions: number | null = null;
    let deletions: number | null = null;
    let statsComputed = false;
    let storageDiff: string | undefined;
    let previewDiff: string | undefined;
    let complete: boolean | undefined;
    let truncated: boolean | undefined;
    if (diffMode !== "none") {
      const diffMeta = await computeMutationDiff(
        existed ? beforeText : "",
        item.prepared.text,
        item.relPath,
        diffMode,
        maxDiffChars,
        { storageMaxChars: config.outputStoreMaxItemBytes }
      );
      additions = diffMeta.additions;
      deletions = diffMeta.deletions;
      statsComputed = diffMeta.statsComputed;
      storageDiff = diffMeta.storageDiff;
      previewDiff = diffMeta.preview;
      complete = diffMeta.complete;
      truncated = diffMeta.truncated;
    }

    const prepared: PreparedItem = {
      ...item,
      existed,
      beforeText: existed && diffMode !== "none" ? beforeText : "",
      originalBuffer,
      mustNotExist: item.expectAbsent,
      storageDiff,
      previewDiff,
      additions,
      deletions,
      statsComputed,
      complete,
      truncated
    };
    return prepared;
  });

  // Restore request order (mapWithConcurrency preserves index order already).
  preparedItems.sort((a, b) => a.index - b.index);

  let created = 0;
  let overwritten = 0;
  let structureImpact = false;
  for (const item of preparedItems) {
    if (item.existed) overwritten += 1;
    else {
      created += 1;
      structureImpact = true;
    }
  }

  const txChanges: PreparedFileTransactionChange[] = preparedItems.map((item) => ({
    type: "write" as const,
    absPath: item.absPath,
    content: item.prepared.text,
    buffer: item.prepared.buffer,
    original: item.originalBuffer,
    existed: item.existed,
    mustNotExist: item.mustNotExist,
    createDirs: item.createDirs
  }));

  await commitPreparedFileTransaction(txChanges, { concurrency });

  // Snapshot warm after successful commit (best-effort; non-fatal).
  let warning: string | undefined;
  try {
    for (const item of preparedItems) {
      invalidateFileSnapshot(item.absPath);
      try {
        const stat = await fsp.stat(item.absPath);
        setCachedFileSnapshot(item.absPath, stat, item.prepared.text, item.prepared.sha256);
      } catch {
        // best-effort
      }
    }
  } catch (error) {
    warning = `Mutation committed but snapshot warm failed: ${error instanceof Error ? error.message : String(error)}`;
  }

  const statsComputed = preparedItems.some((p) => p.statsComputed);
  let totalAdditions: number | null = null;
  let totalDeletions: number | null = null;
  if (statsComputed) {
    totalAdditions = preparedItems.reduce((sum, p) => sum + (p.additions ?? 0), 0);
    totalDeletions = preparedItems.reduce((sum, p) => sum + (p.deletions ?? 0), 0);
  }

  const storageParts = preparedItems.map((p) => p.storageDiff).filter(Boolean) as string[];
  const previewParts = preparedItems.map((p) => p.previewDiff).filter(Boolean) as string[];
  const anyIncomplete = preparedItems.some((p) => p.complete === false);

  // Global budgets: combined preview and combined storage, not per-file only.
  const previewBudget =
    responseMode === "compact_diff"
      ? Math.min(COMPACT_DIFF_MAX_CHARS, config.maxOutputBytes)
      : Math.min(FULL_DIFF_MAX_CHARS, config.maxOutputBytes);
  // Leave headroom for storeMutationDiff header (tool name + paths).
  const pathMetaBytes = Buffer.byteLength(preparedItems.map((p) => p.relPath).join(", "), "utf8");
  const storageBudget = Math.max(
    1024,
    config.outputStoreMaxItemBytes - 256 - pathMetaBytes - 128
  );

  const combinedPreview = combineDiffParts(previewParts, previewBudget);
  const combinedStorage = combineDiffParts(storageParts, storageBudget);
  const combinedTruncated =
    combinedPreview.truncated || combinedStorage.truncated || anyIncomplete || preparedItems.some((p) => p.truncated);
  // complete only if every individual part was complete AND the combined storage held all parts.
  const combinedComplete =
    storageParts.length > 0 && !anyIncomplete && !combinedStorage.truncated && combinedStorage.omittedParts === 0;

  return {
    changed_files: preparedItems.length,
    created_files: created,
    overwritten_files: overwritten,
    total_bytes: totalBytes,
    additions: totalAdditions,
    deletions: totalDeletions,
    diff_stats_computed: statsComputed,
    files: preparedItems.map((item) => ({
      path: item.relPath,
      existed: item.existed,
      bytes: item.prepared.bytes,
      sha256: item.prepared.sha256,
      additions: item.additions,
      deletions: item.deletions
    })),
    response_mode: responseMode,
    storageDiff: combinedStorage.text || undefined,
    previewDiff: combinedPreview.text || undefined,
    diffComplete: storageParts.length ? combinedComplete : undefined,
    diffTruncated: storageParts.length || previewParts.length ? combinedTruncated : undefined,
    warning,
    impact: structureImpact ? "structure" : "content"
  };
}
