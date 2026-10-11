import { SEVERITY } from '@/lib/domain';
import type { ChartArea, ChartMarker, ChartPoint } from '@/ui/chart/chartOption';
import { breakAtGaps } from '@/lib/series';
import { isUsableQuality, type ReplayEvent, type ReplayModel, type ReplaySeries } from './model';

const GLYPH: Record<string, string> = {
  raised: '▲',
  acknowledged: '✓',
  cleared: '▼',
  reactivated: '↻',
};
const VERB: Record<string, string> = {
  raised: 'raised',
  acknowledged: 'ack',
  cleared: 'normal',
  reactivated: 're-raised',
};
const SEV_SHORT = { info: 'INFO', warning: 'WARN', critical: 'CRIT' } as const;

function eventColor(event: ReplayEvent): string {
  switch (event.type) {
    case 'raised':
      return event.severity === 'critical' ? 'var(--event-raised)' : 'var(--event-reactivated)';
    case 'acknowledged':
      return 'var(--event-ack)';
    case 'cleared':
      return 'var(--event-cleared)';
    default:
      return 'var(--event-reactivated)';
  }
}

export function markerLabel(event: ReplayEvent): string {
  return `${GLYPH[event.type] ?? '•'} ${SEV_SHORT[event.severity]} ${VERB[event.type] ?? event.type}`;
}

export function eventMarkers(model: ReplayModel): ChartMarker[] {
  return model.events.map((e) => ({
    x: e.ts,
    name: `${SEVERITY[e.severity].label} alarm #${String(e.alarmId)} ${VERB[e.type] ?? e.type}`,
    label: markerLabel(e),
    color: eventColor(e),
    lineType: e.type === 'raised' ? 'solid' : e.type === 'acknowledged' ? 'dotted' : 'dashed',
    width: e.type === 'raised' || e.type === 'reactivated' ? 2 : 1.5,
  }));
}

export function stateMarkers(model: ReplayModel): ChartMarker[] {
  return model.stateChanges.map((s) => ({
    x: s.ts,
    name: `State changed to ${s.state}`,
    label: undefined,
    color: 'var(--chart-axis)',
    lineType: 'dotted',
    width: 1,
  }));
}

export function gapAreas(model: ReplayModel, measurement: string): ChartArea[] {
  return model.gaps
    .filter((g) => g.measurement === measurement)
    .map((g) => ({ from: g.from, to: g.to, label: 'no data' }));
}

export interface DrawableSeries {
  line: ChartPoint[];
  flagged: ChartPoint[];
}

/** Drawable points for one series: usable samples as a line (broken at gaps), others as flagged markers. */
export function drawableSeries(model: ReplayModel, series: ReplaySeries): DrawableSeries {
  const line: ChartPoint[] = [];
  const flagged: ChartPoint[] = [];
  series.t.forEach((t, i) => {
    const value = series.v[i] ?? null;
    const quality = series.q[i] ?? 'good';
    if (value !== null && isUsableQuality(quality)) line.push([t, value, quality]);
    else if (value !== null) flagged.push([t, value, quality]);
  });
  const gaps = model.gaps.filter((g) => g.measurement === series.measurement);
  return { line: breakAtGaps(line, gaps), flagged };
}
