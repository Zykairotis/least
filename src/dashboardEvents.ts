import type { DashboardEvent, DashboardEventKind, DashboardEventLevel } from "./dashboardTypes.js";
import { redactSensitiveText, redactStructured } from "./redact.js";
import {
  DEFAULT_HISTORY_MAX_AGE_MS,
  DEFAULT_TIMELINE_HYDRATE_LIMIT,
  getMaxStoredTimelineEventId,
  listTimelineDashboardEvents,
  persistDashboardEvent,
  pruneDashboardHistory
} from "./dashboardStore.js";

const MAX_EVENTS_DEFAULT = 10_000;
let ringBuffer: DashboardEvent[] = [];
let nextId = 1;
let maxEvents = MAX_EVENTS_DEFAULT;
let historyMaxAgeMs = DEFAULT_HISTORY_MAX_AGE_MS;
let hydrated = false;

const subscribers = new Set<(event: DashboardEvent) => void>();

export function setDashboardMaxEvents(n: number): void {
  maxEvents = Math.max(100, n);
}

export function setDashboardHistoryMaxAgeMs(ms: number): void {
  historyMaxAgeMs = Math.max(60_000, ms);
}

/**
 * Load the last N days of timeline events from SQLite into the in-memory ring
 * so refresh / new SSE clients see history without waiting for live traffic.
 */
export function hydrateDashboardEventsFromStore(options?: { limit?: number; maxAgeMs?: number }): number {
  const maxAgeMs = options?.maxAgeMs ?? historyMaxAgeMs;
  const limit = options?.limit ?? Math.min(maxEvents, DEFAULT_TIMELINE_HYDRATE_LIMIT);
  try {
    pruneDashboardHistory(maxAgeMs);
    const stored = listTimelineDashboardEvents({ maxAgeMs, limit });
    if (stored.length === 0) {
      const maxId = getMaxStoredTimelineEventId();
      if (maxId >= nextId) nextId = maxId + 1;
      hydrated = true;
      return 0;
    }
    // Merge with any events already emitted this process (shouldn't usually happen).
    const byId = new Map<number, DashboardEvent>();
    for (const e of ringBuffer) byId.set(e.id, e);
    for (const e of stored) byId.set(e.id, e);
    ringBuffer = [...byId.values()].sort((a, b) => a.id - b.id);
    if (ringBuffer.length > maxEvents) {
      ringBuffer = ringBuffer.slice(-maxEvents);
    }
    const maxId = Math.max(
      getMaxStoredTimelineEventId(),
      ringBuffer.length > 0 ? ringBuffer[ringBuffer.length - 1].id : 0
    );
    if (maxId >= nextId) nextId = maxId + 1;
    hydrated = true;
    return stored.length;
  } catch {
    hydrated = true;
    return 0;
  }
}

export function isDashboardEventsHydrated(): boolean {
  return hydrated;
}

export function getDashboardHistoryMaxAgeMs(): number {
  return historyMaxAgeMs;
}

export function emitDashboardEvent(input: {
  kind: DashboardEventKind;
  workspaceId?: string;
  sessionId?: string;
  surface?: "chatgpt" | "grok" | "openai" | "dashboard";
  toolName?: string;
  level?: DashboardEventLevel;
  durationMs?: number;
  payload?: Record<string, unknown>;
}): DashboardEvent {
  const redactedPayload = input.payload
    ? redactPayload(input.payload)
    : undefined;
  const event: DashboardEvent = {
    id: nextId++,
    ts: new Date().toISOString(),
    ...input,
    payload: redactedPayload,
  };
  ringBuffer.push(event);
  persistDashboardEvent(event);
  if (ringBuffer.length > maxEvents) {
    ringBuffer = ringBuffer.slice(-maxEvents);
  }
  for (const listener of subscribers) {
    try {
      listener(event);
    } catch {
      // subscriber error is non-fatal
    }
  }
  return event;
}

const SENSITIVE_KEYS: Record<string, true> = {
  token: true,
  access_token: true,
  refresh_token: true,
  authorization: true,
  password: true,
  secret: true,
  cookie: true,
  api_key: true,
  private_key: true,
};

function redactPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (SENSITIVE_KEYS[key]) {
      out[key] = "[REDACTED]";
      continue;
    }
    if (typeof value === "string") {
      out[key] = redactSensitiveText(value);
    } else if (value && typeof value === "object") {
      out[key] = redactStructured(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function subscribeDashboardEvents(
  listener: (event: DashboardEvent) => void
): () => void {
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
  };
}

export function getRecentDashboardEvents(limit?: number): DashboardEvent[] {
  const n = limit ?? maxEvents;
  if (ringBuffer.length === 0 && !hydrated) {
    hydrateDashboardEventsFromStore({ limit: n });
  }
  return ringBuffer.slice(-n);
}

export function getDashboardEventsSince(
  sinceId: number,
  limit?: number
): DashboardEvent[] {
  if (ringBuffer.length === 0 && !hydrated) {
    hydrateDashboardEventsFromStore();
  }
  // Prefer memory; if client asks for history older than the ring, fall back to SQLite.
  const start = ringBuffer.findIndex((e) => e.id > sinceId);
  if (start >= 0) {
    return ringBuffer.slice(start, limit ? start + limit : undefined);
  }
  if (ringBuffer.length > 0 && ringBuffer[0].id > sinceId + 1) {
    // Ring was truncated; load gap from DB then merge.
    const fromDb = listTimelineDashboardEvents({
      sinceId,
      maxAgeMs: historyMaxAgeMs,
      limit: limit ?? DEFAULT_TIMELINE_HYDRATE_LIMIT
    });
    if (fromDb.length === 0) return [];
    return limit ? fromDb.slice(0, limit) : fromDb;
  }
  return [];
}

/** Full timeline seed for UI refresh (memory + DB, last 3 days). */
export function getTimelineHistory(limit?: number): DashboardEvent[] {
  const n = limit ?? Math.min(maxEvents, DEFAULT_TIMELINE_HYDRATE_LIMIT);
  if (!hydrated || ringBuffer.length < Math.min(n, 50)) {
    hydrateDashboardEventsFromStore({ limit: n });
  }
  return getRecentDashboardEvents(n);
}

export function clearDashboardEvents(): void {
  ringBuffer = [];
}

export function dashboardEventCount(): number {
  return ringBuffer.length;
}

export function dashboardDroppedCount(): number {
  const stored = ringBuffer.length;
  const lastId = stored > 0 ? ringBuffer[stored - 1].id : nextId - 1;
  const expectedMax = Math.max(stored, maxEvents);
  const dropped = Math.max(0, lastId - stored - expectedMax + 1);
  return dropped;
}
