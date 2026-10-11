import { useEffect, useRef } from 'react';
import type { PlaybackStore } from './playback';

interface Props {
  store: PlaybackStore;
  from: number;
  to: number;
  gridLeft: number;
  gridRight: number;
  /** Vertical extent override (e.g. for the state strip). */
  top?: string;
  bottom?: string;
}

/** The playback cursor: a vertical line positioned from the store without re-rendering React. */
export function CursorOverlay({ store, from, to, gridLeft, gridRight, top, bottom }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const update = () => {
      const el = ref.current;
      if (!el) return;
      const span = to - from;
      const fraction = span > 0 ? (store.getSnapshot().cursor - from) / span : 0;
      el.style.left = `calc(${String(gridLeft)}px + (100% - ${String(gridLeft + gridRight)}px) * ${String(fraction)})`;
    };
    update();
    return store.subscribe(update);
  }, [store, from, to, gridLeft, gridRight]);
  return (
    <div
      ref={ref}
      className="cursor-line"
      aria-hidden="true"
      data-testid="cursor-line"
      style={{ top: top ?? 'var(--grid-top, 22px)', bottom: bottom ?? 'var(--grid-bottom, 8px)' }}
    />
  );
}
