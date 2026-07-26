import { useState, useEffect, useCallback, useRef } from "react";
import {
  fetchSnapshot,
  connectSSE,
  eventNeedsSnapshotRefresh,
  type DashboardSnapshot,
  type DashboardEvent,
} from "./api.ts";

interface LiveState {
  snapshot: DashboardSnapshot | null;
  events: DashboardEvent[];
  connected: boolean;
  streaming: boolean;
  lastEventTime: string | null;
  lastEventId: number;
  lastHeartbeatAt: string | null;
  error: string | null;
  eventRate: number;
}

const MAX_EVENTS = 1500;

export function useLiveDashboard(pollIntervalMs = 5000) {
  const [state, setState] = useState<LiveState>({
    snapshot: null,
    events: [],
    connected: false,
    streaming: false,
    lastEventTime: null,
    lastEventId: 0,
    lastHeartbeatAt: null,
    error: null,
    eventRate: 0,
  });

  const esRef = useRef<EventSource | null>(null);
  const eventsRef = useRef<DashboardEvent[]>([]);
  const lastEventIdRef = useRef(0);
  const seenIdsRef = useRef<Set<number>>(new Set());
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recentEventTsRef = useRef<number[]>([]);
  const mountedRef = useRef(true);

  const pushEvent = useCallback((event: DashboardEvent) => {
    if (!event || typeof event.id !== "number") return;
    if (seenIdsRef.current.has(event.id)) return;
    seenIdsRef.current.add(event.id);
    // Bound the seen-id set
    if (seenIdsRef.current.size > MAX_EVENTS * 2) {
      const keep = eventsRef.current.slice(-MAX_EVENTS).map((e) => e.id);
      seenIdsRef.current = new Set(keep);
    }

    eventsRef.current = [...eventsRef.current, event].slice(-MAX_EVENTS);
    lastEventIdRef.current = Math.max(lastEventIdRef.current, event.id);

    const now = Date.now();
    recentEventTsRef.current = [...recentEventTsRef.current.filter((t) => now - t < 60_000), now];

    setState((prev) => ({
      ...prev,
      events: eventsRef.current,
      lastEventTime: event.ts,
      lastEventId: lastEventIdRef.current,
      connected: true,
      streaming: true,
      error: null,
      eventRate: recentEventTsRef.current.length,
    }));
  }, []);

  const handleSnapshot = useCallback((snapshot: DashboardSnapshot) => {
    if (!mountedRef.current) return;
    setState((prev) => ({
      ...prev,
      snapshot,
      connected: true,
      streaming: true,
      error: null,
      lastEventId: Math.max(prev.lastEventId, snapshot.stream?.latestEventId ?? 0),
    }));
    if (snapshot.stream?.latestEventId) {
      lastEventIdRef.current = Math.max(lastEventIdRef.current, snapshot.stream.latestEventId);
    }
  }, []);

  const scheduleSnapshotRefresh = useCallback(() => {
    if (refreshTimerRef.current) return;
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      fetchSnapshot()
        .then((snap) => {
          if (mountedRef.current) handleSnapshot(snap);
        })
        .catch(() => {
          /* ignore transient */
        });
    }, 120);
  }, [handleSnapshot]);

  const handleEvent = useCallback(
    (event: DashboardEvent) => {
      pushEvent(event);
      if (eventNeedsSnapshotRefresh(event.kind)) {
        scheduleSnapshotRefresh();
      }
    },
    [pushEvent, scheduleSnapshotRefresh]
  );

  const handleHeartbeat = useCallback((payload: { ts: string }) => {
    setState((prev) => ({
      ...prev,
      connected: true,
      streaming: true,
      lastHeartbeatAt: payload.ts,
      error: null,
    }));
  }, []);

  const handleError = useCallback(() => {
    setState((prev) => ({
      ...prev,
      connected: false,
      streaming: false,
      error: prev.snapshot ? "Reconnecting…" : "Connecting…",
    }));
  }, []);

  const handleOpen = useCallback(() => {
    setState((prev) => ({
      ...prev,
      connected: true,
      streaming: true,
      error: null,
    }));
  }, []);

  useEffect(() => {
    mountedRef.current = true;

    function connect() {
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
      // Do NOT wipe events on reconnect — merge by id.
      const es = connectSSE(
        {
          onEvent: handleEvent,
          onSnapshot: handleSnapshot,
          onHeartbeat: handleHeartbeat,
          onError: handleError,
          onOpen: handleOpen,
        },
        lastEventIdRef.current > 0 ? lastEventIdRef.current : undefined
      );
      esRef.current = es;
    }

    connect();

    // Seed with HTTP snapshot immediately (works even if SSE is delayed).
    fetchSnapshot()
      .then((snap) => {
        if (mountedRef.current) handleSnapshot(snap);
      })
      .catch((err) => {
        if (mountedRef.current) {
          setState((prev) => ({
            ...prev,
            error: err instanceof Error ? err.message : "Failed to load snapshot",
          }));
        }
      });

    // Backup poll — slower when streaming; still updates runtime/git if no tools fire.
    // 0 = SSE-only mode (no interval poll).
    const pollTimer =
      pollIntervalMs > 0
        ? setInterval(() => {
            fetchSnapshot()
              .then((snap) => {
                if (mountedRef.current) handleSnapshot(snap);
              })
              .catch(() => {});
          }, Math.max(1000, pollIntervalMs))
        : null;

    return () => {
      mountedRef.current = false;
      if (pollTimer) clearInterval(pollTimer);
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
    };
  }, [handleEvent, handleSnapshot, handleHeartbeat, handleError, handleOpen, pollIntervalMs]);

  const refreshSnapshot = useCallback(async () => {
    try {
      const snap = await fetchSnapshot();
      handleSnapshot(snap);
    } catch {
      // ignore
    }
  }, [handleSnapshot]);

  return {
    snapshot: state.snapshot,
    events: state.events,
    connected: state.connected,
    streaming: state.streaming,
    lastEventTime: state.lastEventTime,
    lastEventId: state.lastEventId,
    lastHeartbeatAt: state.lastHeartbeatAt,
    error: state.error,
    eventRate: state.eventRate,
    refreshSnapshot,
  };
}
