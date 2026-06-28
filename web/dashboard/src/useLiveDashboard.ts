import { useState, useEffect, useCallback, useRef } from "react";
import { fetchSnapshot, connectSSE, type DashboardSnapshot, type DashboardEvent } from "./api.ts";

interface LiveState {
  snapshot: DashboardSnapshot | null;
  events: DashboardEvent[];
  connected: boolean;
  lastEventTime: string | null;
  error: string | null;
}

export function useLiveDashboard(refreshIntervalMs = 2000) {
  const [state, setState] = useState<LiveState>({
    snapshot: null,
    events: [],
    connected: false,
    lastEventTime: null,
    error: null,
  });
  const esRef = useRef<EventSource | null>(null);
  const eventsRef = useRef<DashboardEvent[]>([]);

  const handleSnapshot = useCallback((snapshot: DashboardSnapshot) => {
    setState((prev) => ({
      ...prev,
      snapshot,
      connected: true,
      error: null,
    }));
  }, []);

  const handleEvent = useCallback((event: DashboardEvent) => {
    eventsRef.current = [...eventsRef.current.slice(-999), event];
    setState((prev) => ({
      ...prev,
      events: eventsRef.current,
      lastEventTime: event.ts,
      connected: true,
    }));
  }, []);

  const handleError = useCallback(() => {
    setState((prev) => ({ ...prev, connected: false, error: "SSE connection lost" }));
  }, []);

  useEffect(() => {
    function connect() {
      if (esRef.current) {
        esRef.current.close();
      }
      eventsRef.current = [];
      const es = connectSSE(handleEvent, handleSnapshot, handleError);
      esRef.current = es;
    }

    connect();

    const pollTimer = setInterval(() => {
      fetchSnapshot()
        .then((snap) => handleSnapshot(snap))
        .catch(() => {});
    }, refreshIntervalMs);

    return () => {
      clearInterval(pollTimer);
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
    };
  }, [handleEvent, handleSnapshot, handleError, refreshIntervalMs]);

  const refreshSnapshot = useCallback(async () => {
    try {
      const snap = await fetchSnapshot();
      handleSnapshot(snap);
    } catch {
      // ignore refresh errors
    }
  }, [handleSnapshot]);

  return {
    snapshot: state.snapshot,
    events: state.events,
    connected: state.connected,
    lastEventTime: state.lastEventTime,
    error: state.error,
    refreshSnapshot,
  };
}
