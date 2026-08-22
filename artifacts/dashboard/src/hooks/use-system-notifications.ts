/**
 * use-system-notifications.ts
 * Toasts driven by the V1 SSE event stream.
 * Ported from V2, adapted for V1's EventStreamContext.
 */
import { useCallback } from "react";
import { useEventStreamCallback } from "@/hooks/useEventStream";
import { toast } from "sonner";
import type { WebReconEvent } from "@/lib/event-stream";

export function useSystemNotifications() {
  const onEvent = useCallback((event: WebReconEvent) => {
    if (event.subsystem === "recovery") {
      toast.info("Recovery Initiated", {
        description: "Autonomous recovery event triggered.",
      });
    } else if (event.subsystem === "checkpoints") {
      toast.success("Checkpoint Saved", {
        description: "Pipeline state checkpoint written.",
      });
    }
  }, []);

  useEventStreamCallback({ subsystem: ["recovery", "checkpoints"] }, onEvent);
}