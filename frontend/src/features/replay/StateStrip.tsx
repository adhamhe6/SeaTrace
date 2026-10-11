import { toMs } from '@/lib/format';
import { cx } from '@/ui/cx';
import { CursorOverlay } from './CursorOverlay';
import type { ReplayModel } from './model';
import type { PlaybackStore } from './playback';

interface Segment {
  from: number;
  to: number;
  state: string | null;
}

export function stateSegments(model: ReplayModel): Segment[] {
  const segments: Segment[] = [];
  let state = model.stateAtStart;
  let start = model.from;
  for (const change of model.stateChanges) {
    if (change.ts > start) segments.push({ from: start, to: change.ts, state });
    state = change.state;
    start = Math.max(start, change.ts);
  }
  if (model.to > start) segments.push({ from: start, to: model.to, state });
  return segments;
}

const TONE: Record<string, string> = {
  RUNNING: 'ok',
  STARTING: 'info',
  PUMPING: 'info',
  DEGRADED: 'warning',
  TRIPPED: 'critical',
  STOPPED: 'neutral',
  STANDBY: 'neutral',
};

interface Props {
  model: ReplayModel;
  store: PlaybackStore;
  gridLeft: number;
  gridRight: number;
}

/** Equipment operating state over the window, aligned with the chart plot areas. */
export function StateStrip({ model, store, gridLeft, gridRight }: Props) {
  const span = model.to - model.from;
  const segments = stateSegments(model);
  return (
    <div className="state-strip" style={{ paddingLeft: gridLeft, paddingRight: gridRight }}>
      <div className="state-strip__label" style={{ width: gridLeft }}>
        State
      </div>
      <div
        className="state-strip__track"
        role="img"
        aria-label={`Equipment state over time: ${segments.map((s) => s.state ?? 'unknown').join(', then ')}`}
      >
        {segments.map((s) => {
          const left = ((s.from - model.from) / span) * 100;
          const width = ((s.to - s.from) / span) * 100;
          return (
            <span
              key={`${String(s.from)}-${s.state ?? 'unknown'}`}
              className={cx(
                'state-strip__seg',
                s.state ? `st-tone-${TONE[s.state.toUpperCase()] ?? 'neutral'}` : 'st-tone-offline',
                !s.state && 'is-unknown',
              )}
              style={{ left: `${String(left)}%`, width: `${String(width)}%` }}
              title={`${s.state ?? 'State unknown (no state recorded before this window)'}: ${new Date(toMs(s.from) ?? 0).toISOString()} to ${new Date(s.to).toISOString()}`}
            >
              {s.state ?? 'unknown'}
            </span>
          );
        })}
      </div>
      <CursorOverlay
        store={store}
        from={model.from}
        to={model.to}
        gridLeft={gridLeft}
        gridRight={gridRight}
        top="0"
        bottom="0"
      />
    </div>
  );
}
