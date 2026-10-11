import { create } from 'zustand';
import type { OpcUaStatus } from '@/api/types';

export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed';

interface Announcement {
  id: number;
  text: string;
}

interface LiveState {
  connection: ConnectionState;
  /** navigator.onLine mirror. */
  online: boolean;
  lastFrameAt: number | null;
  /** serverTime - clientTime in ms, so locally computed ages are not skewed by clock drift. */
  clockOffsetMs: number;
  /** Latest OPC UA status pushed over the WebSocket (falls back to REST when null). */
  sourceStatus: OpcUaStatus | null;
  announcement: Announcement | null;
  /** alarm id -> epoch ms until which the row is highlighted as freshly changed */
  highlighted: Record<number, number>;
  setConnection: (state: ConnectionState) => void;
  setOnline: (online: boolean) => void;
  touch: (at: number) => void;
  setServerTime: (serverTimeIso: string, clientNow?: number) => void;
  setSourceStatus: (status: OpcUaStatus) => void;
  announce: (text: string) => void;
  highlight: (alarmId: number, until: number) => void;
  reset: () => void;
}

let announcementId = 0;

const initialState = {
  connection: 'connecting' as ConnectionState,
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  lastFrameAt: null,
  clockOffsetMs: 0,
  sourceStatus: null,
  announcement: null,
  highlighted: {},
};

export const useLive = create<LiveState>()((set) => ({
  ...initialState,
  setConnection: (connection) => {
    set({ connection });
  },
  setOnline: (online) => {
    set({ online });
  },
  touch: (lastFrameAt) => {
    set({ lastFrameAt });
  },
  setServerTime: (serverTimeIso, clientNow = Date.now()) => {
    const server = Date.parse(serverTimeIso);
    if (Number.isFinite(server)) set({ clockOffsetMs: server - clientNow });
  },
  setSourceStatus: (sourceStatus) => {
    set({ sourceStatus });
  },
  announce: (text) => {
    announcementId += 1;
    set({ announcement: { id: announcementId, text } });
  },
  highlight: (alarmId, until) => {
    set((s) => {
      const now = Date.now();
      const next: Record<number, number> = {};
      for (const [id, expiry] of Object.entries(s.highlighted)) {
        if (expiry > now) next[Number(id)] = expiry;
      }
      next[alarmId] = until;
      return { highlighted: next };
    });
  },
  reset: () => {
    set({ ...initialState, online: typeof navigator === 'undefined' ? true : navigator.onLine });
  },
}));

/** Server-aligned "now" in epoch ms. */
export function serverNow(): number {
  return Date.now() + useLive.getState().clockOffsetMs;
}
