import { useState, useEffect, useCallback, useRef } from "react";
import {
  fetchSnapshot,
  fetchTimeline,
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
  historyDays: number;
}

/** Match server SQLite hydrate cap — keep multi-day timeline across refresh. */
const MAX_EVENTS = 8000;

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
    historyDays: 3,
  });

  const esRef = useRef<EventSource | null>(null);
  const eventsRef = useRef<DashboardEvent[]>([]);
  const lastEventIdRef = useRef(0);
  const seenIdsRef = useRef<Set<number>>(new Set());
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recentEventTsRef = useRef<number[]>([]);
  const mountedRef = useRef(true);

  const mergeEvents = useCallback((incoming: DashboardEvent[], opts?: { quiet?: boolean }) => {
    if (!incoming.length) return;
    let changed = false;
    let maxId = lastEventIdRef.current;
    let lastTs: string | null = null;
    for (const event of incoming) {
      if (!event || typeof event.id !== "number") continue;
      if (seenIdsRef.current.has(event.id)) continue;
      seenIdsRef.current.add(event.id);
      eventsRef.current.push(event);
      changed = true;
      maxId = Math.max(maxId, event.id);
      lastTs = event.ts;
    }
    if (!changed) return;
    eventsRef.current.sort((a, b) => a.id - b.id);
    if (eventsRef.current.length > MAX_EVENTS) {
      eventsRef.current = eventsRef.current.slice(-MAX_EVENTS);
    }
    if (seenIdsRef.current.size > MAX_EVENTS * 2) {
      seenIdsRef.current = new Set(eventsRef.current.map((e) => e.id));
    }
    lastEventIdRef.current = maxId;
    if (opts?.quiet) {
      setState((prev) => ({
        ...prev,
        events: eventsRef.current,
        lastEventId: maxId,
        lastEventTime: lastTs ?? prev.lastEventTime,
      }));
      return;
    }
    const now = Date.now();
    recentEventTsRef.current = [...recentEventTsRef.current.filter((t) => now - t < 60_000), now];
    setState((prev) => ({
      ...prev,
      events: eventsRef.current,
      lastEventTime: lastTs ?? prev.lastEventTime,
      lastEventId: maxId,
      connected: true,
      streaming: true,
      error: null,
      eventRate: recentEventTsRef.current.length,
    }));
  }, []);

  const pushEvent = useCallback(
    (event: DashboardEvent) => {
      mergeEvents([event]);
    },
    [mergeEvents]
  );

  const handleSnapshot = useCallback(
    (snapshot: DashboardSnapshot) => {
      if (!mountedRef.current) return;
      if (Array.isArray(snapshot.recentEvents) && snapshot.recentEvents.length > 0) {
        mergeEvents(snapshot.recentEvents, { quiet: true });
      }
      setState((prev) => ({
        ...prev,
        snapshot,
        connected: true,
        streaming: true,
        error: null,
        lastEventId: Math.max(
          prev.lastEventId,
          snapshot.stream?.latestEventId ?? 0,
          lastEventIdRef.current
        ),
        historyDays: snapshot.history?.maxAgeDays ?? prev.historyDays,
      }));
      if (snapshot.stream?.latestEventId) {
        lastEventIdRef.current = Math.max(lastEventIdRef.current, snapshot.stream.latestEventId);
      }
    },
    [mergeEvents]
  );

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

    // Seed with HTTP snapshot + explicit timeline DB history (survives refresh).
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

    fetchTimeline(MAX_EVENTS)
      .then((payload) => {
        if (!mountedRef.current) return;
        if (Array.isArray(payload.events)) {
          mergeEvents(payload.events, { quiet: true });
        }
        if (payload.history?.maxAgeDays) {
          setState((prev) => ({ ...prev, historyDays: payload.history!.maxAgeDays }));
        }
      })
      .catch(() => {
        /* timeline endpoint optional if older server */
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
  }, [handleEvent, handleSnapshot, handleHeartbeat, handleError, handleOpen, mergeEvents, pollIntervalMs]);

  const refreshSnapshot = useCallback(async () => {
    try {
      const snap = await fetchSnapshot();
      handleSnapshot(snap);
      const timeline = await fetchTimeline(MAX_EVENTS);
      if (Array.isArray(timeline.events)) mergeEvents(timeline.events, { quiet: true });
    } catch {
      // ignore
    }
  }, [handleSnapshot, mergeEvents]);

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
    historyDays: state.historyDays,
    refreshSnapshot,
  };
}
