import type { StateStorage } from 'zustand/middleware';

type Area = 'localStorage' | 'sessionStorage';

/** Web Storage wrapper that never throws (private mode, blocked storage) and falls back to memory. */
export function safeStorage(area: Area): StateStorage {
  const memory = new Map<string, string>();
  return {
    getItem(name) {
      try {
        return window[area].getItem(name);
      } catch {
        return memory.get(name) ?? null;
      }
    },
    setItem(name, value) {
      try {
        window[area].setItem(name, value);
      } catch {
        memory.set(name, value);
      }
    },
    removeItem(name) {
      try {
        window[area].removeItem(name);
      } catch {
        memory.delete(name);
      }
    },
  };
}
