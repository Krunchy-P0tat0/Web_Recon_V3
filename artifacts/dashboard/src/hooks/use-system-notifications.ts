/**
 * use-system-notifications.ts
 * Toasts driven by the V1 SSE event stream.
 * Ported from V2, adapted for V1's EventStreamContext.
 */
import { useCallback } from "react";
import { useEventStreamCallback } from "@/hooks/useEventStream";
import { toast } from "sonner";

export function useSystemNotifications() {
  const onEvent = useCallback((event: { type: string; payload?: Record<string, unknown> }) => {
    if (event.type === "recovery") {
      toast.info("Recovery Initiated", {
        description: "Autonomous recovery event triggered.",
      });
    } else if (event.type === "checkpoint") {
      toast.success("Checkpoint Saved", {
        description: "Pipeline state checkpoint written.",
      });
    }
  }, []);

  useEventStreamCallback({ subsystem: "recovery" }, onEvent);
}
