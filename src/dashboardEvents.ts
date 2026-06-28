import type { DashboardEvent, DashboardEventKind, DashboardEventLevel } from "./dashboardTypes.js";
import { redactSensitiveText, redactStructured } from "./redact.js";
import { persistDashboardEvent } from "./dashboardStore.js";

const MAX_EVENTS_DEFAULT = 5_000;
let ringBuffer: DashboardEvent[] = [];
let nextId = 1;
let maxEvents = MAX_EVENTS_DEFAULT;

const subscribers = new Set<(event: DashboardEvent) => void>();

export function setDashboardMaxEvents(n: number): void {
  maxEvents = Math.max(100, n);
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
  return ringBuffer.slice(-n);
}

export function getDashboardEventsSince(
  sinceId: number,
  limit?: number
): DashboardEvent[] {
  const start = ringBuffer.findIndex((e) => e.id > sinceId);
  if (start < 0) return [];
  return ringBuffer.slice(start, limit ? start + limit : undefined);
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
