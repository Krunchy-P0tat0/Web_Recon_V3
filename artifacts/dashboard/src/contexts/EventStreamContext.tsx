/**
 * EventStreamContext.tsx — Single EventSource for the entire app.
 *
 * One connection to /api/events/platform delivers ALL subsystem events.
 * Widgets subscribe via useEventStream() — no widget opens its own EventSource.
 *
 * Features:
 *   - Automatic reconnect with exponential back-off (max 30s)
 *   - Local ring buffer (last 500 events) for replay on mount
 *   - Per-subscriber callbacks — zero re-renders for unrelated events
 *   - Connection status broadcast
 */

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useCallback,
  useState,
  type ReactNode,
} from "react";
import {
  buildEventUrl,
  matchesFilter,
  type WebReconEvent,
  type EventFilter,
} from "@/lib/event-stream";

// ---------------------------------------------------------------------------
// Context shape
// ---------------------------------------------------------------------------

type Unsubscribe = () => void;
type EventCallback = (evt: WebReconEvent) => void;

interface EventStreamContextValue {
  /** Current SSE connection status. */
  connected: boolean;
  /** Subscribe to events matching filter. Returns an unsubscribe function. */
  subscribe: (filter: EventFilter, cb: EventCallback) => Unsubscribe;
  /** Snapshot of the local event ring buffer. */
  getBuffer: (filter?: EventFilter) => WebReconEvent[];
  /** Latest single event (triggers re-render on every event). */
  latest: WebReconEvent | null;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const EventStreamContext = createContext<EventStreamContextValue | null>(null);

export function useEventStreamContext(): EventStreamContextValue {
  const ctx = useContext(EventStreamContext);
  if (!ctx) throw new Error("useEventStreamContext must be used inside <EventStreamProvider>");
  return ctx;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

const BUFFER_SIZE   = 500;
const RECONNECT_MIN =  1_000;   // 1s
const RECONNECT_MAX = 30_000;   // 30s

export function EventStreamProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [latest, setLatest]       = useState<WebReconEvent | null>(null);

  // Ring buffer (not React state — we don't want renders on every push)
  const bufferRef = useRef<WebReconEvent[]>([]);

  // Subscriber map: id → { filter, cb }
  const subscribersRef = useRef<
    Map<number, { filter: EventFilter; cb: EventCallback }>
  >(new Map());
  const subSeq = useRef(0);

  // Reconnect state
  const retryDelay = useRef(RECONNECT_MIN);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const esRef       = useRef<EventSource | null>(null);

  // Dispatch an incoming event to buffer + subscribers + latest
  const dispatch = useCallback((evt: WebReconEvent) => {
    // Update ring buffer
    const buf = bufferRef.current;
    if (buf.length >= BUFFER_SIZE) buf.shift();
    buf.push(evt);

    // Notify subscribers
    for (const { filter, cb } of subscribersRef.current.values()) {
      if (matchesFilter(evt, filter)) {
        cb(evt);
      }
    }

    // Trigger latest (causes only components that use `latest` to re-render)
    setLatest(evt);
  }, []);

  // Connect / reconnect
  const connect = useCallback(() => {
    if (retryTimer.current) {
      clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }

    const url = buildEventUrl("/events/platform");
    const es  = new EventSource(url);
    esRef.current = es;

    es.addEventListener("connected", () => {
      setConnected(true);
      retryDelay.current = RECONNECT_MIN;   // reset back-off on success
    });

    es.addEventListener("webrecon-event", (e: Event) => {
      try {
        const evt = JSON.parse((e as MessageEvent).data) as WebReconEvent;
        dispatch(evt);
      } catch (_) {}
    });

    es.onopen  = () => setConnected(true);

    es.onerror = () => {
      setConnected(false);
      es.close();
      esRef.current = null;

      // Exponential back-off
      retryTimer.current = setTimeout(() => {
        connect();
      }, retryDelay.current);
      retryDelay.current = Math.min(retryDelay.current * 2, RECONNECT_MAX);
    };
  }, [dispatch]);

  // Open once on mount; close on unmount
  useEffect(() => {
    connect();
    return () => {
      if (retryTimer.current) clearTimeout(retryTimer.current);
      esRef.current?.close();
    };
  }, [connect]);

  // Subscribe API
  const subscribe = useCallback(
    (filter: EventFilter, cb: EventCallback): Unsubscribe => {
      const id = ++subSeq.current;
      subscribersRef.current.set(id, { filter, cb });
      return () => subscribersRef.current.delete(id);
    },
    [],
  );

  // Buffer snapshot
  const getBuffer = useCallback((filter?: EventFilter): WebReconEvent[] => {
    const buf = bufferRef.current;
    if (!filter) return [...buf];
    return buf.filter((e) => matchesFilter(e, filter));
  }, []);

  return (
    <EventStreamContext.Provider value={{ connected, subscribe, getBuffer, latest }}>
      {children}
    </EventStreamContext.Provider>
  );
}
