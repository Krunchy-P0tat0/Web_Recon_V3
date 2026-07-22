/**
 * useEventStream.ts — React hook for consuming WebRecon events.
 *
 * Usage:
 *   // Get all events for a job
 *   const events = useEventStream({ jobId: "abc-123" });
 *
 *   // Get only pipeline events for a job
 *   const events = useEventStream({ subsystem: "pipeline", jobId: "abc-123" });
 *
 *   // React to events immediately (callback variant)
 *   useEventStreamCallback({ subsystem: "checkpoints" }, (evt) => {
 *     setCheckpointStatus(evt.payload);
 *   });
 *
 *   // Get connection status only
 *   const { connected } = useEventStreamStatus();
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { useEventStreamContext } from "@/contexts/EventStreamContext";
import type { WebReconEvent, EventFilter } from "@/lib/event-stream";

// ---------------------------------------------------------------------------
// useEventStream — accumulates matching events into a state array
// ---------------------------------------------------------------------------

export interface UseEventStreamOptions extends EventFilter {
  /** Max events to keep in the local array. Default: 50. */
  maxEvents?: number;
  /** Include events from the local buffer on mount. Default: true. */
  replayBuffer?: boolean;
}

export function useEventStream(options: UseEventStreamOptions = {}): WebReconEvent[] {
  const { maxEvents = 50, replayBuffer = true, ...filter } = options;
  const { subscribe, getBuffer } = useEventStreamContext();
  const [events, setEvents]      = useState<WebReconEvent[]>(() =>
    replayBuffer ? getBuffer(filter).slice(-maxEvents) : [],
  );

  useEffect(() => {
    const unsub = subscribe(filter, (evt) => {
      setEvents((prev) => {
        const next = [...prev, evt];
        return next.length > maxEvents ? next.slice(-maxEvents) : next;
      });
    });
    return unsub;
    // filter is a new object each render — stringify for stable dep
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscribe, maxEvents, JSON.stringify(filter)]);

  return events;
}

// ---------------------------------------------------------------------------
// useLatestEvent — returns only the most recent matching event
// ---------------------------------------------------------------------------

export function useLatestEvent(filter: EventFilter = {}): WebReconEvent | null {
  const { subscribe, getBuffer } = useEventStreamContext();
  const [latest, setLatest] = useState<WebReconEvent | null>(() => {
    const buf = getBuffer(filter);
    return buf.length > 0 ? buf[buf.length - 1] : null;
  });

  useEffect(() => {
    const unsub = subscribe(filter, setLatest);
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscribe, JSON.stringify(filter)]);

  return latest;
}

// ---------------------------------------------------------------------------
// useEventStreamCallback — fire a callback without storing events in state
// ---------------------------------------------------------------------------

export function useEventStreamCallback(
  filter: EventFilter,
  cb: (evt: WebReconEvent) => void,
): void {
  const { subscribe }  = useEventStreamContext();
  // Stable ref so we don't re-subscribe when the callback closure changes
  const cbRef = useRef(cb);
  cbRef.current = cb;

  const stableCb = useCallback((evt: WebReconEvent) => {
    cbRef.current(evt);
  }, []);

  useEffect(() => {
    const unsub = subscribe(filter, stableCb);
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscribe, stableCb, JSON.stringify(filter)]);
}

// ---------------------------------------------------------------------------
// useEventStreamStatus — connection indicator only (no event data)
// ---------------------------------------------------------------------------

export function useEventStreamStatus(): { connected: boolean } {
  const { connected } = useEventStreamContext();
  return { connected };
}

// ---------------------------------------------------------------------------
// useSubsystemEvents — convenience wrapper per subsystem
// ---------------------------------------------------------------------------

export function usePipelineEvents(jobId?: string, max = 50): WebReconEvent[] {
  return useEventStream({ subsystem: "pipeline", jobId, maxEvents: max });
}

export function useRecoveryEvents(max = 30): WebReconEvent[] {
  return useEventStream({ subsystem: "recovery", maxEvents: max });
}

export function useStorageEvents(max = 30): WebReconEvent[] {
  return useEventStream({ subsystem: "storage", maxEvents: max });
}

export function useCheckpointEvents(max = 20): WebReconEvent[] {
  return useEventStream({ subsystem: "checkpoints", maxEvents: max });
}

export function useCoverageEvents(jobId?: string, max = 30): WebReconEvent[] {
  return useEventStream({ subsystem: "coverage", jobId, maxEvents: max });
}

export function useDifferentialEvents(jobId?: string, max = 30): WebReconEvent[] {
  return useEventStream({ subsystem: "differential", jobId, maxEvents: max });
}
