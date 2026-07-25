/**
 * event-stream.ts — Shared types and utilities for the WebRecon SSE layer.
 *
 * Every SSE endpoint emits WebReconEvent objects with the unified envelope:
 *   { id, timestamp, jobId, subsystem, event, severity, payload }
 */

// ---------------------------------------------------------------------------
// Types (mirror of server-side event-bus.ts)
// ---------------------------------------------------------------------------

export type Subsystem =
  | "pipeline"
  | "recovery"
  | "storage"
  | "checkpoints"
  | "coverage"
  | "differential"
  | "platform";

export type Severity = "info" | "warn" | "error" | "critical";

export interface WebReconEvent {
  id:        string;
  timestamp: string;        // ISO-8601
  jobId:     string | null;
  subsystem: Subsystem;
  event:     string;        // machine-readable name, e.g. "job-started"
  severity:  Severity;
  payload:   Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Event filter
// ---------------------------------------------------------------------------

export interface EventFilter {
  subsystem?: Subsystem | Subsystem[];
  jobId?:     string;
  event?:     string | string[];
  severity?:  Severity | Severity[];
}

export function matchesFilter(evt: WebReconEvent, filter: EventFilter): boolean {
  if (filter.subsystem) {
    const allowed = Array.isArray(filter.subsystem) ? filter.subsystem : [filter.subsystem];
    if (!allowed.includes(evt.subsystem)) return false;
  }
  if (filter.jobId && evt.jobId !== filter.jobId) return false;
  if (filter.event) {
    const allowed = Array.isArray(filter.event) ? filter.event : [filter.event];
    if (!allowed.includes(evt.event)) return false;
  }
  if (filter.severity) {
    const allowed = Array.isArray(filter.severity) ? filter.severity : [filter.severity];
    if (!allowed.includes(evt.severity)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// API URL builder — resolves against the proxy base
// ---------------------------------------------------------------------------

/** Build a URL for an /api/events/* SSE endpoint. */
export function buildEventUrl(path: string): string {
  // In Replit's proxy, the dashboard is at "/" and the API is at "/api".
  // Always use root-relative /api/... — the proxy routes it correctly.
  const base = "/api";
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

// ---------------------------------------------------------------------------
// Severity helpers
// ---------------------------------------------------------------------------

export const SEVERITY_ORDER: Record<Severity, number> = {
  info:     0,
  warn:     1,
  error:    2,
  critical: 3,
};

export function isAtLeastSeverity(evt: WebReconEvent, min: Severity): boolean {
  return SEVERITY_ORDER[evt.severity] >= SEVERITY_ORDER[min];
}
