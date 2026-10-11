import { useSyncExternalStore } from 'react';
import type { PlaybackSnapshot, PlaybackStore } from './playback';

export function usePlaybackSnapshot(store: PlaybackStore): PlaybackSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
