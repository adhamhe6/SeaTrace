import { ChartLine } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  HISTORY_RANGES_MIN,
  RAW_HISTORY_MAX_MIN,
  useAlarms,
  useHistory,
  type HistoryRangeMin,
} from '@/api/hooks';
import type { AlarmOut, EquipmentDetail, HistoryResponse, VesselDetail } from '@/api/types';
import { resolveCssColor } from '@/lib/cssColor';
import { SEVERITY } from '@/lib/domain';
import { formatValue, toMs } from '@/lib/format';
import { breakAtGaps, detectGaps } from '@/lib/series';
import { useNow } from '@/lib/useNow';
import { Banner } from '@/ui/Banner';
import { Card } from '@/ui/Card';
import { Segmented } from '@/ui/Choice';
import { TimeSeriesChart } from '@/ui/chart/TimeSeriesChart';
import type {
  ChartMarker,
  ChartPoint,
  ChartScatterSpec,
  ChartSeriesSpec,
} from '@/ui/chart/chartOption';
import { Skeleton } from '@/ui/Skeleton';
import { ErrorState } from '@/ui/states';
import { Tabs, TabPanel } from '@/ui/Tabs';
import { EquipmentAlarms } from './EquipmentAlarms';
import { useLiveBuffer } from './useLiveBuffer';

const USABLE = new Set(['good', 'uncertain']);

export interface MeasurementSeries {
  measurement: string;
  line: ChartPoint[];
  band: { min: ChartPoint[]; max: ChartPoint[] } | null;
  flagged: ChartPoint[];
}

/** Converts a history response into drawable series per measurement (raw samples or bucket averages). */
export function toMeasurementSeries(
  history: HistoryResponse,
  measurement: string,
): MeasurementSeries {
  const line: ChartPoint[] = [];
  const flagged: ChartPoint[] = [];
  let band: MeasurementSeries['band'] = null;
  if (history.bucket_s) {
    const min: ChartPoint[] = [];
    const max: ChartPoint[] = [];
    for (const b of history.buckets) {
      if (b.measurement !== measurement) continue;
      const ts = Date.parse(b.ts);
      line.push([ts, b.avg]);
      min.push([ts, b.min]);
      max.push([ts, b.max]);
    }
    band = { min, max };
  } else {
    for (const p of history.items) {
      if (p.measurement !== measurement) continue;
      const ts = Date.parse(p.ts);
      if (USABLE.has(p.quality) && p.value !== null) line.push([ts, p.value, p.quality]);
      else {
        line.push([ts, null]);
        if (p.value !== null) flagged.push([ts, p.value, p.quality]);
      }
    }
  }
  return { measurement, line, band, flagged };
}

function alarmMarkers(
  alarms: readonly AlarmOut[],
  measurement: string,
  from: number,
  to: number,
): ChartMarker[] {
  const out: ChartMarker[] = [];
  for (const alarm of alarms) {
    if (alarm.measurement !== measurement) continue;
    const sev = SEVERITY[alarm.severity];
    const raised = toMs(alarm.raised_at);
    if (raised !== null && raised >= from && raised <= to) {
      out.push({
        x: raised,
        name: `Alarm raised #${String(alarm.id)}`,
        label: `${sev.label} alarm`,
        color: alarm.severity === 'critical' ? 'var(--event-raised)' : 'var(--event-reactivated)',
        lineType: 'solid',
      });
    }
    const cleared = toMs(alarm.cleared_at);
    if (cleared !== null && cleared >= from && cleared <= to) {
      out.push({
        x: cleared,
        name: `Returned to normal #${String(alarm.id)}`,
        label: 'Normal',
        color: 'var(--event-cleared)',
        lineType: 'dashed',
      });
    }
  }
  return out;
}

function EquipmentCharts({
  vessel,
  equipment,
  rangeMin,
}: {
  vessel: string;
  equipment: EquipmentDetail;
  rangeMin: HistoryRangeMin;
}) {
  const history = useHistory(vessel, equipment.code, rangeMin);
  const raw = rangeMin <= RAW_HISTORY_MAX_MIN;
  const live = useLiveBuffer(vessel, equipment.code, history.dataUpdatedAt, raw);
  const alarms = useAlarms({ vessel, equipment: equipment.code, limit: 50, offset: 0 });
  const now = useNow();
  const xMax = now;
  const xMin = now - rangeMin * 60_000;

  const series = useMemo(() => {
    if (!history.data) return null;
    const data = history.data;
    return equipment.readings.map((reading) => {
      const base = toMeasurementSeries(data, reading.measurement);
      return { reading, base };
    });
  }, [history.data, equipment.readings]);

  if (history.isError && !history.data) {
    return (
      <ErrorState
        error={history.error}
        title="Could not load history"
        onRetry={() => void history.refetch()}
        retrying={history.isRefetching}
      />
    );
  }
  if (!series) {
    return (
      <div className="charts-grid" role="status" aria-label="Loading charts">
        {equipment.readings.map((r) => (
          <Skeleton key={r.measurement} height={180} />
        ))}
      </div>
    );
  }

  return (
    <div className="stack">
      {history.data?.truncated ? (
        <Banner tone="warning">
          The selected range holds more samples than one response returns; only the earliest part is
          drawn.
        </Banner>
      ) : null}
      <div className="charts-grid">
        {series.map(({ reading, base }) => {
          const livePoints = raw ? (live[reading.measurement] ?? []) : [];
          const last = base.line[base.line.length - 1]?.[0] ?? 0;
          const merged = [...base.line, ...livePoints.filter((p) => p[0] > last)];
          const times = merged.filter((p) => p[1] !== null).map((p) => p[0]);
          const gaps = detectGaps(times);
          const line = breakAtGaps(merged, gaps);
          const specs: ChartSeriesSpec[] = [
            { id: 'main', name: base.band ? 'Average' : reading.name, data: line, tone: 'primary' },
          ];
          if (base.band) {
            specs.push(
              {
                id: 'min',
                name: 'Min',
                data: base.band.min,
                tone: 'secondary',
                dashed: true,
                width: 1,
                opacity: 0.7,
              },
              {
                id: 'max',
                name: 'Max',
                data: base.band.max,
                tone: 'secondary',
                dashed: true,
                width: 1,
                opacity: 0.7,
              },
            );
          }
          const scatter: ChartScatterSpec[] =
            base.flagged.length > 0
              ? [
                  {
                    id: 'flagged',
                    name: 'Bad-quality sample',
                    data: base.flagged,
                    color: resolveCssColor('var(--event-raised)'),
                  },
                ]
              : [];
          const markers = alarmMarkers(
            alarms.data?.items ?? [],
            reading.measurement,
            xMin,
            xMax,
          ).map((m) => ({
            ...m,
            color: resolveCssColor(m.color),
          }));
          const latest = [...line].reverse().find((p) => p[1] !== null);
          const description = latest
            ? `Latest plotted value ${formatValue(latest[1], reading.unit)}.`
            : 'No stored samples in this range.';
          return (
            <div className="chart-card" key={reading.measurement}>
              <div className="chart-card__title">
                <span>{reading.name}</span>
                <span className="muted tnum small">{reading.unit}</span>
              </div>
              <TimeSeriesChart
                label={`${reading.name} (${reading.unit}), last ${String(rangeMin)} minutes`}
                description={description}
                unit={reading.unit}
                series={specs}
                scatter={scatter}
                xMin={xMin}
                xMax={xMax}
                nominal={{ min: reading.nominal_min, max: reading.nominal_max }}
                gaps={gaps.map((g) => ({ from: g.from, to: g.to }))}
                markers={markers}
                showMarkerLabels
                height={190}
                emptyMessage="No stored telemetry in this range"
              />
            </div>
          );
        })}
      </div>
      <p className="xs muted">
        {raw
          ? 'Raw samples.'
          : `Averages of ${String(history.data?.bucket_s ?? '')} s buckets with min/max.`}{' '}
        Shaded teal band: nominal range. Grey areas: gaps in stored data. Vertical lines: alarm
        raised / returned to normal.
      </p>
    </div>
  );
}

export function Trends({ vessel }: { vessel: VesselDetail }) {
  const [equipmentCode, setEquipmentCode] = useState(vessel.equipment[0]?.code ?? '');
  const [range, setRange] = useState<HistoryRangeMin>(15);
  const selected = vessel.equipment.find((e) => e.code === equipmentCode) ?? vessel.equipment[0];
  if (!selected) return null;
  const base = `trend-${vessel.code}`;
  return (
    <Card
      title="Trends"
      subtitle="Stored telemetry for the selected equipment, extended live while the channel is connected"
      icon={ChartLine}
      actions={
        <Segmented
          label="Time range"
          value={range}
          onChange={setRange}
          options={HISTORY_RANGES_MIN.map((m) => ({ value: m, label: `${String(m)} min` }))}
        />
      }
    >
      <div className="stack">
        <Tabs
          label="Equipment"
          idBase={base}
          value={selected.code}
          onChange={setEquipmentCode}
          items={vessel.equipment.map((e) => ({ id: e.code, label: e.name, count: e.open_alarms }))}
        />
        {vessel.equipment.map((e) => (
          <TabPanel key={e.code} base={base} id={e.code} active={e.code === selected.code}>
            <div className="stack">
              <EquipmentCharts vessel={vessel.code} equipment={e} rangeMin={range} />
              <EquipmentAlarms vesselCode={vessel.code} equipmentCode={e.code} />
            </div>
          </TabPanel>
        ))}
      </div>
    </Card>
  );
}
