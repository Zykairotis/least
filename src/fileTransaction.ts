import fsp from "node:fs/promises";
import path from "node:path";
import { mapWithConcurrency } from "./fsOps.js";

export type FileTransactionChange =
  | { type: "write"; absPath: string; content: string; mustNotExist?: boolean; createDirs?: boolean }
  | { type: "delete"; absPath: string };

/**
 * Preflight-prepared change: originals and buffers already captured so the
 * transaction does not re-read target files.
 */
export type PreparedFileTransactionChange =
  | {
      type: "write";
      absPath: string;
      content: string;
      buffer: Buffer;
      original: Buffer | undefined;
      existed: boolean;
      mustNotExist?: boolean;
      /** When false, parent must already exist (validated in preflight). Default true. */
      createDirs?: boolean;
    }
  | {
      type: "delete";
      absPath: string;
      original: Buffer;
    };

export interface CommitPreparedOptions {
  /** Bounded concurrency for temp-file writes and mkdir. Default 8, clamp 1–32. */
  concurrency?: number;
  signal?: AbortSignal;
  /**
   * Test-only failure injection. Throws during the named stage when the
   * 0-based index matches (or is undefined for any).
   */
  injectFailure?: {
    stage: "mkdir" | "temp_write" | "rename" | "unlink";
    index?: number;
  };
}

function clampConcurrency(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 8;
  return Math.max(1, Math.min(32, Math.floor(value)));
}

function makeUniqueTempPath(absPath: string): string {
  return path.join(
    path.dirname(absPath),
    `.${path.basename(absPath)}.least-${process.pid}-${Math.random().toString(16).slice(2)}.tmp`
  );
}

function maybeInject(
  inject: CommitPreparedOptions["injectFailure"],
  stage: NonNullable<CommitPreparedOptions["injectFailure"]>["stage"],
  index: number
): void {
  if (!inject || inject.stage !== stage) return;
  if (inject.index !== undefined && inject.index !== index) return;
  throw new Error(`Injected transaction failure at ${stage} index=${index}`);
}

/**
 * Commit prepared file changes with bounded parallel temp writes.
 * Deterministic rename/commit order; rollback restores originals on failure.
 */
export async function commitPreparedFileTransaction(
  changes: PreparedFileTransactionChange[],
  options: CommitPreparedOptions = {}
): Promise<void> {
  if (!changes.length) return;

  const uniqueAbs = new Set<string>();
  for (const change of changes) {
    if (uniqueAbs.has(change.absPath)) {
      throw new Error(`Duplicate transaction target: ${change.absPath}`);
    }
    uniqueAbs.add(change.absPath);
  }

  const concurrency = clampConcurrency(options.concurrency);
  const temps = new Map<string, string>();
  const committed: Array<{ absPath: string; original: Buffer | undefined; type: "write" | "delete" }> = [];

  try {
    for (const change of changes) {
      if (change.type === "write" && change.mustNotExist && change.existed) {
        throw new Error(`Refusing to overwrite existing file: ${change.absPath}`);
      }
      if (change.type === "delete" && change.original === undefined) {
        throw new Error(`Cannot delete missing file: ${change.absPath}`);
      }
    }

    const writeChanges = changes.filter(
      (c): c is Extract<PreparedFileTransactionChange, { type: "write" }> => c.type === "write"
    );

    // Only create parents for writes that allow createDirs (default true).
    // createDirs=false parents were validated during preflight.
    const parentDirs = [
      ...new Set(
        writeChanges
          .filter((c) => c.createDirs !== false)
          .map((c) => path.dirname(c.absPath))
      )
    ];
    await mapWithConcurrency(parentDirs, concurrency, async (dir, index) => {
      options.signal?.throwIfAborted?.();
      maybeInject(options.injectFailure, "mkdir", index);
      await fsp.mkdir(dir, { recursive: true });
    });

    // Temp files for createDirs=false still need a writable parent (already exists).
    await mapWithConcurrency(writeChanges, concurrency, async (change, index) => {
      options.signal?.throwIfAborted?.();
      maybeInject(options.injectFailure, "temp_write", index);
      const temp = makeUniqueTempPath(change.absPath);
      await fsp.writeFile(temp, change.buffer, { flag: "wx" });
      temps.set(change.absPath, temp);
    });

    for (let i = 0; i < changes.length; i += 1) {
      const change = changes[i]!;
      options.signal?.throwIfAborted?.();
      if (change.type === "write") {
        maybeInject(options.injectFailure, "rename", i);
        const temp = temps.get(change.absPath);
        if (!temp) throw new Error(`Missing temp file for ${change.absPath}`);
        await fsp.rename(temp, change.absPath);
        temps.delete(change.absPath);
        committed.push({ absPath: change.absPath, original: change.original, type: "write" });
      } else {
        maybeInject(options.injectFailure, "unlink", i);
        await fsp.unlink(change.absPath);
        committed.push({ absPath: change.absPath, original: change.original, type: "delete" });
      }
    }
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (let i = committed.length - 1; i >= 0; i -= 1) {
      const item = committed[i]!;
      try {
        if (item.original === undefined) {
          await fsp.unlink(item.absPath).catch(() => undefined);
        } else {
          await fsp.mkdir(path.dirname(item.absPath), { recursive: true });
          await fsp.writeFile(item.absPath, item.original);
        }
      } catch (rollbackError) {
        rollbackErrors.push(
          `${item.absPath}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
        );
      }
    }
    await Promise.allSettled([...temps.values()].map((temp) => fsp.unlink(temp)));
    if (rollbackErrors.length) {
      const primary = error instanceof Error ? error.message : String(error);
      throw new Error(`${primary} (rollback issues: ${rollbackErrors.join("; ")})`);
    }
    throw error;
  } finally {
    await Promise.allSettled([...temps.values()].map((temp) => fsp.unlink(temp)));
  }
}

/**
 * Compatibility wrapper: reads originals, then commits via prepared path.
 * Prefer commitPreparedFileTransaction when originals are already known.
 */
export async function commitFileTransaction(
  changes: FileTransactionChange[],
  options: CommitPreparedOptions = {}
): Promise<void> {
  if (!changes.length) return;

  const unique = new Map(changes.map((change) => [change.absPath, change]));
  const prepared: PreparedFileTransactionChange[] = [];

  for (const change of unique.values()) {
    const original = await fsp.readFile(change.absPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (change.type === "write") {
      prepared.push({
        type: "write",
        absPath: change.absPath,
        content: change.content,
        buffer: Buffer.from(change.content, "utf8"),
        original,
        existed: original !== undefined,
        mustNotExist: change.mustNotExist,
        createDirs: change.createDirs
      });
    } else {
      if (original === undefined) {
        throw new Error(`Cannot delete missing file: ${change.absPath}`);
      }
      prepared.push({
        type: "delete",
        absPath: change.absPath,
        original
      });
    }
  }

  const ordered = changes.map((c) => {
    const match = prepared.find((p) => p.absPath === c.absPath && p.type === c.type);
    if (!match) throw new Error(`Missing prepared change for ${c.absPath}`);
    return match;
  });

  const seenKeys = new Set<string>();
  const finalOrdered: PreparedFileTransactionChange[] = [];
  for (const item of ordered) {
    const key = `${item.type}:${item.absPath}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    finalOrdered.push(item);
  }

  await commitPreparedFileTransaction(finalOrdered, options);
}
