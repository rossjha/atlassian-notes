import type { LiveEvent } from "../shared/types.ts";

/** EventSource reconnects by itself; we only parse and forward. */
export function connectLive(onEvent: (e: LiveEvent) => void): void {
  const es = new EventSource("/api/events");
  es.onmessage = (m) => {
    try {
      onEvent(JSON.parse(m.data as string) as LiveEvent);
    } catch {
      // ignore malformed event
    }
  };
}
