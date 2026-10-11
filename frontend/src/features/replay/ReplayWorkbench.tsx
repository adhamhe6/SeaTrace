import { useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import type { IncidentWindow } from '@/api/types';
import { formatNumber, formatTimestamp } from '@/lib/format';
import { resolveTheme, useSettings } from '@/lib/settingsStore';
import { Banner } from '@/ui/Banner';
import { Card } from '@/ui/Card';
import { SeverityBadge } from '@/ui/Badge';
import { EventTimeline } from './EventTimeline';
import { eventMarkers, stateMarkers } from './markers';
import { buildReplayModel, focusTimes } from './model';
import { PlaybackControls } from './PlaybackControls';
import { PlaybackStore } from './playback';
import { REPLAY_GRID_LEFT, REPLAY_GRID_RIGHT, ReplayChart } from './ReplayChart';
import { StateAtCursor } from './StateAtCursor';
import { StateStrip } from './StateStrip';

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) ||
    target.getAttribute('role') === 'slider'
  );
}

function isActivatable(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && ['BUTTON', 'A', 'SUMMARY'].includes(target.tagName);
}

export function ReplayWorkbench({ window: w }: { window: IncidentWindow }) {
  const model = useMemo(() => buildReplayModel(w), [w]);
  // A new window gets a fresh clock; the old one stops ticking.
  const store = useMemo(() => new PlaybackStore(model.from, model.to), [model]);
  const themeChoice = useSettings((s) => s.theme);
  const timeMode = useSettings((s) => s.timeMode);
  const theme = `${resolveTheme(themeChoice)}-${timeMode}`;

  useEffect(
    () => () => {
      store.dispose();
    },
    [store],
  );

  // Keyboard shortcuts: Space toggles playback, arrows step between stored samples.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      if (event.key === ' ' || event.code === 'Space') {
        if (isActivatable(event.target)) return; // let a focused button handle its own Space
        event.preventDefault();
        store.toggle();
      } else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        event.preventDefault();
        const cursor = store.cursor;
        const forward = event.key === 'ArrowRight';
        const times = model.sampleTimes;
        let target: number | null = null;
        if (forward) target = times.find((t) => t > cursor + 0.5) ?? null;
        else
          for (let i = times.length - 1; i >= 0; i -= 1) {
            if ((times[i] ?? 0) < cursor - 0.5) {
              target = times[i] ?? null;
              break;
            }
          }
        if (target !== null) store.seek(target);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [store, model]);

  const events = useMemo(() => eventMarkers(model), [model]);
  const states = useMemo(() => stateMarkers(model), [model]);
  const topMarkers = useMemo(() => [...events, ...states], [events, states]);
  const focus = model.focusAlarmId !== null ? model.alarms.get(model.focusAlarmId) : undefined;
  const truncated = model.series.filter((s) => s.truncated);
  const ft = focusTimes(model);
  const empty = model.pointCount === 0;

  return (
    <div className="stack" data-testid="replay-workbench">
      <Card
        title={`${model.vesselName} — ${model.equipmentName}`}
        subtitle={
          <span className="mono">
            {model.vesselCode}/{model.equipmentCode}
          </span>
        }
      >
        <div className="replay-summary">
          <div>
            <span className="st-stat__label">Window</span>
            <div className="mono small" data-testid="window-range">
              {formatTimestamp(model.from, timeMode)} → {formatTimestamp(model.to, timeMode)}
            </div>
            <div className="xs muted">{formatNumber((model.to - model.from) / 1000, 0)} s</div>
          </div>
          <div>
            <span className="st-stat__label">Stored samples</span>
            <div className="tnum">{model.pointCount}</div>
          </div>
          <div>
            <span className="st-stat__label">Alarm events</span>
            <div className="tnum">{model.events.length}</div>
          </div>
          {focus ? (
            <div>
              <span className="st-stat__label">Focus alarm</span>
              <div className="row">
                <SeverityBadge severity={focus.severity} />
                <Link to={`/alarms/${String(focus.id)}`}>#{focus.id}</Link>
              </div>
              <div className="xs muted">
                {focus.message}
                {ft.raisedAt === null ? ' (raised before this window)' : ''}
              </div>
            </div>
          ) : null}
        </div>
      </Card>

      {empty ? (
        <Banner tone="warning" title="No stored telemetry in this window.">
          Nothing was recorded for {model.equipmentName} between these times (for example while the
          data source was offline). Alarm events and state changes, if any, are still listed.
        </Banner>
      ) : null}
      {truncated.length > 0 ? (
        <Banner tone="warning" title="Some series were truncated.">
          The server returns a limited number of points per series (
          {truncated.map((s) => s.name).join(', ')}). Choose a shorter window for full resolution.
        </Banner>
      ) : null}

      <PlaybackControls model={model} store={store} />

      <div className="replay-grid">
        <div
          className="stack stack--sm replay-charts"
          data-testid="replay-charts"
          data-timekey={theme}
          aria-label="Synchronised charts"
        >
          <StateStrip
            model={model}
            store={store}
            gridLeft={REPLAY_GRID_LEFT}
            gridRight={REPLAY_GRID_RIGHT}
          />
          {model.series.map((series, index) => (
            <ReplayChart
              key={series.measurement}
              model={model}
              series={series}
              store={store}
              markers={index === 0 ? topMarkers : events}
              showLabels={index === 0}
              xLabels={index === model.series.length - 1}
              height={index === model.series.length - 1 ? 168 : 128}
              theme={theme}
            />
          ))}
          <p className="xs muted">
            Click a chart to move the cursor. Teal band: nominal range. Grey areas: gaps in stored
            data. Vertical lines: ▲ raised, ✓ acknowledged, ▼ returned to normal, ↻ re-raised. Times
            are shown in {timeMode === 'utc' ? 'UTC' : 'your local time zone'}.
          </p>
        </div>
        <div className="stack replay-side">
          <StateAtCursor model={model} store={store} />
          <EventTimeline model={model} store={store} />
        </div>
      </div>
    </div>
  );
}
