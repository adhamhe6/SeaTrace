import { useSyncExternalStore } from 'react';
import { useLive } from '@/realtime/liveStore';

/** One shared 1 s ticker for every component that shows an age. */
let current = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    current = Date.now();
    timer = setInterval(() => {
      current = Date.now();
      listeners.forEach((l) => {
        l();
      });
    }, 1000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

function getSnapshot(): number {
  return current;
}

/** Server-aligned current time in epoch ms, refreshed every second. */
export function useNow(): number {
  const tick = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const offset = useLive((s) => s.clockOffsetMs);
  return tick + offset;
}
