import type { TelemetryItem } from './protocol';

type Listener = (items: readonly TelemetryItem[]) => void;
const listeners = new Set<Listener>();

/** Fan-out of live telemetry items to chart buffers (kept outside React state to stay cheap). */
export const telemetryBus = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  emit(items: readonly TelemetryItem[]): void {
    listeners.forEach((l) => {
      l(items);
    });
  },
};
