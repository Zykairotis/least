import type { DashboardEvent } from "./api.ts";

export interface PairedToolCall {
  id: number;
  ts: string;
  toolName: string;
  status: "running" | "ok" | "error";
  durationMs?: number;
  input?: Record<string, unknown>;
  output?: { rawBytes?: number; visibleBytes?: number };
  error?: string;
  workspaceId?: string;
  sessionId?: string;
}

export function pairToolCalls(events: DashboardEvent[]): (DashboardEvent | PairedToolCall)[] {
  const pairs: Map<number, { start: DashboardEvent; end?: DashboardEvent; error?: DashboardEvent }> = new Map();
  const standalone: DashboardEvent[] = [];

  // Strict ordering: tool:start comes before tool:end/tool:error, same toolName
  for (const e of events) {
    if (e.kind === "tool:start") {
      pairs.set(e.id, { start: e });
    } else if (e.kind === "tool:end") {
      // Find matching start: walk backwards through current pairs
      let matched = false;
      for (const [, pair] of pairs) {
        if (!pair.end && !pair.error && pair.start.toolName === e.toolName && pair.start.id < e.id) {
          pair.end = e;
          matched = true;
          break;
        }
      }
      if (!matched) standalone.push(e);
    } else if (e.kind === "tool:error") {
      let matched = false;
      for (const [, pair] of pairs) {
        if (!pair.end && !pair.error && pair.start.toolName === e.toolName && pair.start.id < e.id) {
          pair.error = e;
          matched = true;
          break;
        }
      }
      if (!matched) standalone.push(e);
    } else {
      standalone.push(e);
    }
  }

  const result: (DashboardEvent | PairedToolCall)[] = [];

  for (const [, pair] of pairs) {
    const start = pair.start;
    const end = pair.end || pair.error;

    // Only emit paired if we matched an end/error
    if (end) {
      result.push({
        id: start.id,
        ts: start.ts,
        toolName: start.toolName ?? "?",
        status: pair.error ? "error" : "ok",
        durationMs: end.durationMs ?? (end.ts ? Date.parse(end.ts) - Date.parse(start.ts) : undefined),
        input: start.payload as Record<string, unknown> | undefined,
        output: end.payload?.outputSummary as { rawBytes?: number; visibleBytes?: number } | undefined,
        error: pair.error?.payload?.message as string | undefined,
        workspaceId: start.workspaceId,
        sessionId: start.sessionId,
      });
    } else {
      // No matching end — emit as running
      result.push({
        id: start.id,
        ts: start.ts,
        toolName: start.toolName ?? "?",
        status: "running",
        input: start.payload as Record<string, unknown> | undefined,
        workspaceId: start.workspaceId,
        sessionId: start.sessionId,
      });
    }
  }

  // Append standalone events, sorted by id
  result.push(...standalone.sort((a, b) => a.id - b.id));

  // Sort all by id descending (newest first)
  return result.sort((a, b) => b.id - a.id);
}
