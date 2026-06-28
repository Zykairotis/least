import type { LeastConfig } from "./config.js";
import { randomBytes } from "node:crypto";
import { emitDashboardEvent } from "./dashboardEvents.js";

export type WorkspaceLock = {
  workspaceId: string;
  ownerSessionId: string;
  leaseToken: string;
  ownerLabel?: string;
  acquiredAt: string;
  expiresAt: string;
  lastRenewedAt: string;
  mode: "exclusive";
};

export type LockAcquireResult =
  | { ok: true; lock: WorkspaceLock; alreadyOwned: boolean }
  | { ok: false; reason: "owned_by_other"; lock: WorkspaceLock };

export type WorkspaceLockStatus = {
  locked: boolean;
  owner_session_id?: string;
  owner_label?: string;
  acquired_at?: string;
  expires_at?: string;
  seconds_remaining?: number;
};

const managers = new Map<number, WorkspaceLockManager>();

function managerKey(config: LeastConfig): number {
  return config.lockLeaseMs;
}

export function getSharedWorkspaceLockManager(config: LeastConfig): WorkspaceLockManager {
  const key = managerKey(config);
  const existing = managers.get(key);
  if (existing) return existing;
  const manager = new WorkspaceLockManager(config.lockLeaseMs);
  managers.set(key, manager);
  return manager;
}

export class WorkspaceLockManager {
  private readonly locks = new Map<string, WorkspaceLock>();
  private readonly pruneTimer: NodeJS.Timeout;

  constructor(private readonly leaseMs: number) {
    this.pruneTimer = setInterval(() => this.prune(), Math.min(this.leaseMs, 30_000));
    this.pruneTimer.unref();
  }

  private isExpired(lock: WorkspaceLock): boolean {
    return Date.now() >= new Date(lock.expiresAt).getTime();
  }

  private createLock(workspaceId: string, ownerSessionId: string, ownerLabel?: string): WorkspaceLock {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.leaseMs);
    return {
      workspaceId,
      ownerSessionId,
      leaseToken: randomBytes(24).toString("hex"),
      ownerLabel: ownerLabel?.trim() || undefined,
      acquiredAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      lastRenewedAt: now.toISOString(),
      mode: "exclusive"
    };
  }

  private renewLock(lock: WorkspaceLock): WorkspaceLock {
    const now = new Date();
    const renewed: WorkspaceLock = {
      ...lock,
      expiresAt: new Date(now.getTime() + this.leaseMs).toISOString(),
      lastRenewedAt: now.toISOString()
    };
    this.locks.set(lock.workspaceId, renewed);
    return renewed;
  }

  get(workspaceId: string): WorkspaceLock | undefined {
    this.prune();
    const lock = this.locks.get(workspaceId);
    if (!lock || this.isExpired(lock)) return undefined;
    return lock;
  }

  acquire(workspaceId: string, ownerSessionId: string, ownerLabel?: string): LockAcquireResult {
    this.prune();
    const existing = this.locks.get(workspaceId);
    if (existing && !this.isExpired(existing)) {
      if (existing.ownerSessionId === ownerSessionId) {
        emitDashboardEvent({ kind: "lock:renewed", payload: { workspaceId, ownerSessionId: redactSessionId(ownerSessionId) } });
        return { ok: true, lock: this.renewLock(existing), alreadyOwned: true };
      }
      emitDashboardEvent({ kind: "lock:blocked", payload: { workspaceId, ownerSessionId: redactSessionId(ownerSessionId) } });
      return { ok: false, reason: "owned_by_other", lock: existing };
    }
    const lock = this.createLock(workspaceId, ownerSessionId, ownerLabel);
    this.locks.set(workspaceId, lock);
    emitDashboardEvent({ kind: "lock:acquired", payload: { workspaceId, ownerSessionId: redactSessionId(ownerSessionId) } });
    return { ok: true, lock, alreadyOwned: false };
  }

  private isOwner(lock: WorkspaceLock, ownerSessionId: string, leaseToken?: string): boolean {
    return lock.ownerSessionId === ownerSessionId || Boolean(leaseToken && lock.leaseToken === leaseToken);
  }

  renew(workspaceId: string, ownerSessionId: string, leaseToken?: string): WorkspaceLock | undefined {
    this.prune();
    const existing = this.locks.get(workspaceId);
    if (!existing || this.isExpired(existing)) return undefined;
    if (!this.isOwner(existing, ownerSessionId, leaseToken)) return undefined;
    return this.renewLock(existing);
  }

  release(
    workspaceId: string,
    ownerSessionId: string,
    leaseToken?: string
  ): { released: true } | { released: false; reason: "no_lock" | "not_owner" } {
    this.prune();
    const existing = this.locks.get(workspaceId);
    if (!existing || this.isExpired(existing)) {
      return { released: false, reason: "no_lock" };
    }
    if (!this.isOwner(existing, ownerSessionId, leaseToken)) {
      return { released: false, reason: "not_owner" };
    }
    this.locks.delete(workspaceId);
    emitDashboardEvent({ kind: "lock:released", payload: { workspaceId, ownerSessionId: redactSessionId(ownerSessionId) } });
    return { released: true };
  }

  requireOwner(workspaceId: string, ownerSessionId: string, leaseToken?: string): WorkspaceLock {
    this.prune();
    const existing = this.locks.get(workspaceId);
    if (!existing || this.isExpired(existing)) {
      throw new WorkspaceLockedError(workspaceId, undefined);
    }
    if (!this.isOwner(existing, ownerSessionId, leaseToken)) {
      throw new WorkspaceLockedError(workspaceId, existing);
    }
    return existing;
  }

  status(workspaceId: string): WorkspaceLockStatus {
    const lock = this.get(workspaceId);
    if (!lock) return { locked: false };
    const secondsRemaining = Math.max(0, Math.ceil((new Date(lock.expiresAt).getTime() - Date.now()) / 1000));
    return {
      locked: true,
      owner_session_id: redactSessionId(lock.ownerSessionId),
      owner_label: lock.ownerLabel,
      acquired_at: lock.acquiredAt,
      expires_at: lock.expiresAt,
      seconds_remaining: secondsRemaining
    };
  }

  prune(): void {
    for (const [workspaceId, lock] of this.locks) {
      if (this.isExpired(lock)) this.locks.delete(workspaceId);
    }
  }
}

export function redactSessionId(sessionId: string): string {
  if (sessionId.length <= 12) return sessionId;
  return `${sessionId.slice(0, 8)}…${sessionId.slice(-4)}`;
}

export function lockSecondsRemaining(lock: WorkspaceLock): number {
  return Math.max(0, Math.ceil((new Date(lock.expiresAt).getTime() - Date.now()) / 1000));
}

export class WorkspaceLockedError extends Error {
  readonly code = "workspace_locked";

  constructor(
    public readonly workspaceId: string,
    public readonly lock: WorkspaceLock | undefined
  ) {
    const ownerLabel = lock?.ownerLabel;
    const seconds = lock ? lockSecondsRemaining(lock) : undefined;
    const message = ownerLabel
      ? `Workspace is locked by another session (${ownerLabel}). Lease expires in ${seconds ?? 0}s. Call workspace_lock_status or wait for expiry, then acquire_workspace_lock.`
      : `Workspace is locked by another session. Acquire the workspace lock with acquire_workspace_lock before mutating.`;
    super(message);
    this.name = "WorkspaceLockedError";
  }

  toStructured(): Record<string, unknown> {
    const base: Record<string, unknown> = {
      error: this.code,
      message: this.message,
      workspace_id: this.workspaceId
    };
    if (this.lock) {
      base.owner_label = this.lock.ownerLabel;
      base.expires_at = this.lock.expiresAt;
      base.seconds_remaining = lockSecondsRemaining(this.lock);
    }
    return base;
  }
}

export class StaleFileStateError extends Error {
  readonly code = "stale_file_state";

  constructor(
    public readonly relPath: string,
    public readonly expectedSha256: string,
    public readonly actualSha256: string
  ) {
    super(
      `Refusing to modify ${relPath} because it changed since the caller last read it. ` +
        `Re-read the file and retry with the current sha256.`
    );
    this.name = "StaleFileStateError";
  }

  toStructured(): Record<string, unknown> {
    return {
      error: this.code,
      message: this.message,
      path: this.relPath,
      expected_sha256: this.expectedSha256,
      actual_sha256: this.actualSha256
    };
  }
}
