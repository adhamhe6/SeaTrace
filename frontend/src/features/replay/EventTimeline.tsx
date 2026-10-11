import {
  ArrowRightLeft,
  Check,
  CircleCheck,
  RotateCcw,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import { SEVERITY, eventLabel } from '@/lib/domain';
import { formatRelativeOffset } from '@/lib/format';
import { Card } from '@/ui/Card';
import { cx } from '@/ui/cx';
import { Timestamp } from '@/ui/misc';
import { EmptyState } from '@/ui/states';
import { focusTimes, type ReplayModel } from './model';
import type { PlaybackStore } from './playback';
import { usePlaybackSnapshot } from './usePlayback';

const ICON: Record<string, LucideIcon> = {
  raised: TriangleAlert,
  acknowledged: Check,
  cleared: CircleCheck,
  reactivated: RotateCcw,
};

interface Entry {
  key: string;
  ts: number;
  kind: 'alarm' | 'state';
  title: string;
  detail: string;
  icon: LucideIcon;
  tone: string;
  severityLabel?: string;
}

export function timelineEntries(model: ReplayModel): Entry[] {
  const entries: Entry[] = model.events.map((e) => ({
    key: `a-${String(e.id)}`,
    ts: e.ts,
    kind: 'alarm',
    title: `${eventLabel(e.type)}: ${e.message}`,
    detail: `${e.actor}${e.note ? ` — “${e.note}”` : ''}`,
    icon: ICON[e.type] ?? TriangleAlert,
    tone:
      e.type === 'cleared'
        ? 'ok'
        : e.type === 'acknowledged'
          ? 'info'
          : e.severity === 'critical'
            ? 'critical'
            : 'warning',
    severityLabel: SEVERITY[e.severity].label,
  }));
  model.stateChanges.forEach((s, i) => {
    entries.push({
      key: `s-${String(i)}`,
      ts: s.ts,
      kind: 'state',
      title: `Equipment state: ${s.state}`,
      detail: 'operating state change',
      icon: ArrowRightLeft,
      tone: 'neutral',
    });
  });
  return entries.sort((a, b) => a.ts - b.ts || a.key.localeCompare(b.key));
}

export function EventTimeline({ model, store }: { model: ReplayModel; store: PlaybackStore }) {
  const { cursor } = usePlaybackSnapshot(store);
  const entries = timelineEntries(model);
  const reference = focusTimes(model).raisedAt ?? model.from;
  let currentIndex = -1;
  entries.forEach((e, i) => {
    if (e.ts <= cursor) currentIndex = i;
  });
  return (
    <Card
      title="Events"
      subtitle="Alarm transitions and equipment state changes; select one to jump there"
      flush
    >
      {entries.length === 0 ? (
        <EmptyState title="No events in this window">
          No alarm transition or equipment state change was stored for this period.
        </EmptyState>
      ) : (
        <ol className="events" aria-label="Chronological alarm events">
          {entries.map((e, i) => (
            <li key={e.key}>
              <button
                type="button"
                className={cx(
                  'events__btn',
                  `st-tone-${e.tone}`,
                  i === currentIndex && 'is-current',
                )}
                aria-current={i === currentIndex ? 'true' : undefined}
                onClick={() => {
                  store.seek(e.ts);
                }}
              >
                <e.icon size={15} aria-hidden="true" className="events__icon" />
                <span className="events__body">
                  <span className="events__title">
                    {e.severityLabel ? (
                      <span className="events__sev">{e.severityLabel}</span>
                    ) : null}
                    {e.title}
                  </span>
                  <span className="xs muted">
                    <span className="mono">{formatRelativeOffset(e.ts, reference)}</span> ·{' '}
                    <Timestamp value={e.ts} millis /> · {e.detail}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
