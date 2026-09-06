import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type DurableMcpSession = {
  sessionId: string;
  lockOwnerId: string;
  surfacePath: string;
  createdAt: number;
  lastSeenAt: number;
};

type StoreFile = {
  version: 1;
  sessions: Record<string, DurableMcpSession>;
};

function leastHome(): string {
  return process.env.LEAST_HOME?.trim() || path.join(os.homedir(), ".least");
}

function storePath(surfacePath: string): string {
  const safe = surfacePath.replace(/[^a-zA-Z0-9._-]+/g, "_") || "mcp";
  return path.join(leastHome(), "mcp-sessions", `${safe}.json`);
}

function emptyStore(): StoreFile {
  return { version: 1, sessions: {} };
}

function readStore(filePath: string): StoreFile {
  try {
    if (!fs.existsSync(filePath)) return emptyStore();
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as StoreFile;
    if (!parsed || parsed.version !== 1 || typeof parsed.sessions !== "object" || !parsed.sessions) {
      return emptyStore();
    }
    return parsed;
  } catch {
    return emptyStore();
  }
}

function writeStore(filePath: string, store: StoreFile): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best-effort
  }
}

/**
 * Disk-backed MCP session registry so session IDs survive process restarts.
 * Transport objects stay in memory; this only stores identity + lock owner.
 */
export class McpSessionStore {
  private readonly filePath: string;
  private cache: StoreFile;
  private dirty = false;
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(surfacePath: string) {
    this.filePath = storePath(surfacePath);
    this.cache = readStore(this.filePath);
  }

  get(sessionId: string): DurableMcpSession | undefined {
    return this.cache.sessions[sessionId];
  }

  upsert(session: Omit<DurableMcpSession, "createdAt" | "lastSeenAt"> & { createdAt?: number; lastSeenAt?: number }): DurableMcpSession {
    const now = Date.now();
    const existing = this.cache.sessions[session.sessionId];
    const next: DurableMcpSession = {
      sessionId: session.sessionId,
      lockOwnerId: session.lockOwnerId,
      surfacePath: session.surfacePath,
      createdAt: existing?.createdAt ?? session.createdAt ?? now,
      lastSeenAt: session.lastSeenAt ?? now
    };
    this.cache.sessions[session.sessionId] = next;
    this.scheduleFlush();
    return next;
  }

  touch(sessionId: string): void {
    const existing = this.cache.sessions[sessionId];
    if (!existing) return;
    existing.lastSeenAt = Date.now();
    this.scheduleFlush();
  }

  delete(sessionId: string): void {
    if (!this.cache.sessions[sessionId]) return;
    delete this.cache.sessions[sessionId];
    this.scheduleFlush();
  }

  prune(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    let removed = 0;
    for (const [id, session] of Object.entries(this.cache.sessions)) {
      if (session.lastSeenAt < cutoff) {
        delete this.cache.sessions[id];
        removed += 1;
      }
    }
    if (removed > 0) this.scheduleFlush();
    return removed;
  }

  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.dirty) return;
    this.dirty = false;
    try {
      writeStore(this.filePath, this.cache);
    } catch (error) {
      console.error(
        `[Least] Failed to persist MCP sessions to ${this.filePath}:`,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  private scheduleFlush(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, 250);
    this.flushTimer.unref?.();
  }
}
