/**
 * Shared file snapshot cache keyed by realpath + size + mtime.
 * Avoids re-reading/hashing unchanged files across read, stale-check, edit, and project-map paths.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";

export type FileSnapshot = {
  absPath: string;
  size: number;
  mtimeMs: number;
  mtimeNs?: bigint;
  text: string;
  sha256: string;
  cachedAt: number;
};

const cache = new Map<string, FileSnapshot>();
const MAX_ENTRIES = 512;
const MAX_FILE_BYTES = 2_000_000;
const DEFAULT_TTL_MS = 60_000;

function cacheKey(absPath: string): string {
  try {
    return fs.realpathSync(absPath);
  } catch {
    return absPath;
  }
}

function fingerprint(stat: fs.Stats): { size: number; mtimeMs: number; mtimeNs?: bigint } {
  const mtimeNs =
    typeof (stat as fs.Stats & { mtimeNs?: bigint }).mtimeNs === "bigint"
      ? (stat as fs.Stats & { mtimeNs: bigint }).mtimeNs
      : undefined;
  return { size: stat.size, mtimeMs: stat.mtimeMs, mtimeNs };
}

function matchesStat(entry: FileSnapshot, stat: fs.Stats): boolean {
  const fp = fingerprint(stat);
  if (entry.size !== fp.size) return false;
  if (entry.mtimeNs !== undefined && fp.mtimeNs !== undefined) {
    return entry.mtimeNs === fp.mtimeNs;
  }
  return entry.mtimeMs === fp.mtimeMs;
}

function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function pruneIfNeeded(): void {
  if (cache.size <= MAX_ENTRIES) return;
  const excess = cache.size - MAX_ENTRIES;
  let removed = 0;
  for (const key of cache.keys()) {
    cache.delete(key);
    removed += 1;
    if (removed >= excess) break;
  }
}

export function getCachedFileSnapshot(absPath: string, stat: fs.Stats, ttlMs = DEFAULT_TTL_MS): FileSnapshot | undefined {
  const key = cacheKey(absPath);
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.cachedAt > ttlMs) {
    cache.delete(key);
    return undefined;
  }
  if (!matchesStat(entry, stat)) {
    cache.delete(key);
    return undefined;
  }
  return entry;
}

export function setCachedFileSnapshot(absPath: string, stat: fs.Stats, text: string, digest?: string): FileSnapshot {
  const key = cacheKey(absPath);
  const fp = fingerprint(stat);
  const entry: FileSnapshot = {
    absPath: key,
    size: fp.size,
    mtimeMs: fp.mtimeMs,
    mtimeNs: fp.mtimeNs,
    text,
    sha256: digest ?? sha256Text(text),
    cachedAt: Date.now()
  };
  cache.set(key, entry);
  pruneIfNeeded();
  return entry;
}

export function invalidateFileSnapshot(absPath?: string): void {
  if (!absPath) {
    cache.clear();
    return;
  }
  cache.delete(cacheKey(absPath));
}

/** Drop snapshots under a workspace root after structure-changing mutations. */
export function invalidateFileSnapshotsUnder(rootAbsPath: string): void {
  const prefix = rootAbsPath.endsWith("/") || rootAbsPath.endsWith("\\") ? rootAbsPath : `${rootAbsPath}`;
  for (const key of [...cache.keys()]) {
    if (key === prefix || key.startsWith(`${prefix}/`) || key.startsWith(`${prefix}\\`)) {
      cache.delete(key);
    }
  }
}

/**
 * Read text with snapshot cache. Returns text + sha256 + whether it was a cache hit.
 * Skips cache for files larger than MAX_FILE_BYTES.
 * Pass `knownStat` when the caller already stat()ed the file (e.g. guard checks)
 * to avoid a duplicate filesystem stat on mutation paths.
 */
export async function readTextWithSnapshot(
  absPath: string,
  options: { maxBytes?: number; ttlMs?: number; knownStat?: fs.Stats } = {}
): Promise<{ text: string; sha256: string; size: number; cacheHit: boolean; stat: fs.Stats }> {
  const maxBytes = options.maxBytes ?? MAX_FILE_BYTES;
  const stat = options.knownStat ?? (await fsp.stat(absPath));
  if (!stat.isFile()) {
    throw new Error(`Not a file: ${absPath}`);
  }
  if (stat.size > maxBytes) {
    const text = await fsp.readFile(absPath, "utf8");
    return { text, sha256: sha256Text(text), size: stat.size, cacheHit: false, stat };
  }
  const cached = getCachedFileSnapshot(absPath, stat, options.ttlMs);
  if (cached) {
    return { text: cached.text, sha256: cached.sha256, size: stat.size, cacheHit: true, stat };
  }
  const text = await fsp.readFile(absPath, "utf8");
  const entry = setCachedFileSnapshot(absPath, stat, text);
  return { text: entry.text, sha256: entry.sha256, size: stat.size, cacheHit: false, stat };
}

export function getFileSnapshotCacheStats(): Record<string, unknown> {
  let approxBytes = 0;
  for (const entry of cache.values()) {
    approxBytes += Buffer.byteLength(entry.text, "utf8");
  }
  return {
    entries: cache.size,
    approx_bytes: approxBytes,
    max_entries: MAX_ENTRIES
  };
}
