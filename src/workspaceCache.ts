import type { FilesBackend } from "./filesOps.js";

interface CachedFileList {
  workspaceId: string;
  key: string;
  backend: FilesBackend;
  files: string[];
  createdAt: number;
  expiresAt: number;
  truncated: boolean;
}

interface CachedGitValue {
  workspaceId: string;
  key: string;
  value: string;
  createdAt: number;
  expiresAt: number;
}

const fileListCache = new Map<string, CachedFileList>();
const gitCache = new Map<string, CachedGitValue>();

function now(): number {
  return Date.now();
}

function estimateStringArrayBytes(items: string[]): number {
  return items.reduce((sum, item) => sum + Buffer.byteLength(item, "utf8"), 0);
}

function estimateGitBytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function getCachedFileList(workspaceId: string, key: string): CachedFileList | undefined {
  const entry = fileListCache.get(`${workspaceId}:${key}`);
  if (!entry) return undefined;
  if (entry.expiresAt <= now()) {
    fileListCache.delete(`${workspaceId}:${key}`);
    return undefined;
  }
  return entry;
}

export function setCachedFileList(
  workspaceId: string,
  key: string,
  backend: FilesBackend,
  files: string[],
  truncated: boolean,
  ttlMs: number
): CachedFileList {
  const timestamp = now();
  const entry: CachedFileList = {
    workspaceId,
    key,
    backend,
    files: [...files],
    createdAt: timestamp,
    expiresAt: timestamp + ttlMs,
    truncated
  };
  fileListCache.set(`${workspaceId}:${key}`, entry);
  return entry;
}

export function getCachedGitValue(workspaceId: string, key: string): CachedGitValue | undefined {
  const entry = gitCache.get(`${workspaceId}:${key}`);
  if (!entry) return undefined;
  if (entry.expiresAt <= now()) {
    gitCache.delete(`${workspaceId}:${key}`);
    return undefined;
  }
  return entry;
}

export function setCachedGitValue(workspaceId: string, key: string, value: string, ttlMs: number): CachedGitValue {
  const entry: CachedGitValue = {
    workspaceId,
    key,
    value,
    createdAt: now(),
    expiresAt: now() + ttlMs
  };
  gitCache.set(`${workspaceId}:${key}`, entry);
  return entry;
}

export function invalidateWorkspaceCaches(workspaceId?: string): void {
  if (!workspaceId) {
    fileListCache.clear();
    gitCache.clear();
    return;
  }
  for (const key of [...fileListCache.keys()]) {
    if (key.startsWith(`${workspaceId}:`)) fileListCache.delete(key);
  }
  for (const key of [...gitCache.keys()]) {
    if (key.startsWith(`${workspaceId}:`)) gitCache.delete(key);
  }
}

export function getWorkspaceCacheStats(): Record<string, unknown> {
  const fileEntries = [...fileListCache.values()];
  const gitEntries = [...gitCache.values()];
  return {
    file_list_cache: {
      entries: fileEntries.length,
      approx_bytes: fileEntries.reduce((sum, entry) => sum + estimateStringArrayBytes(entry.files), 0)
    },
    git_cache: {
      entries: gitEntries.length,
      approx_bytes: gitEntries.reduce((sum, entry) => sum + estimateGitBytes(entry.value), 0)
    }
  };
}
