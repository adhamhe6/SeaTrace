import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { safeStorage } from './storage';

export type ThemeChoice = 'light' | 'dark';
export type TimeMode = 'utc' | 'local';

interface SettingsState {
  /** null = follow the operating system preference. */
  theme: ThemeChoice | null;
  timeMode: TimeMode;
  setTheme: (theme: ThemeChoice | null) => void;
  setTimeMode: (mode: TimeMode) => void;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      theme: null,
      timeMode: 'utc',
      setTheme: (theme) => {
        set({ theme });
      },
      setTimeMode: (timeMode) => {
        set({ timeMode });
      },
    }),
    {
      name: 'seatrace.settings',
      storage: createJSONStorage(() => safeStorage('localStorage')),
      version: 1,
    },
  ),
);

export function systemTheme(): ThemeChoice {
  if (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: light)').matches
  ) {
    return 'light';
  }
  return 'dark';
}

export function resolveTheme(choice: ThemeChoice | null): ThemeChoice {
  return choice ?? systemTheme();
}
