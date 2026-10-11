import { memo, useMemo } from 'react';
import { resolveCssColor } from '@/lib/cssColor';
import { formatValue } from '@/lib/format';
import { TimeSeriesChart } from '@/ui/chart/TimeSeriesChart';
import type { ChartMarker } from '@/ui/chart/chartOption';
import { CursorOverlay } from './CursorOverlay';
import { drawableSeries, gapAreas } from './markers';
import type { ReplayModel, ReplaySeries } from './model';
import type { PlaybackStore } from './playback';

export const REPLAY_GRID_LEFT = 64;
export const REPLAY_GRID_RIGHT = 16;

interface Props {
  model: ReplayModel;
  series: ReplaySeries;
  store: PlaybackStore;
  markers: ChartMarker[];
  showLabels: boolean;
  xLabels: boolean;
  height: number;
  theme: string;
}

function ReplayChartImpl({
  model,
  series,
  store,
  markers,
  showLabels,
  xLabels,
  height,
  theme,
}: Props) {
  const drawable = useMemo(() => drawableSeries(model, series), [model, series]);
  const gaps = useMemo(() => gapAreas(model, series.measurement), [model, series.measurement]);
  const resolvedMarkers = useMemo(
    () => markers.map((m) => ({ ...m, color: resolveCssColor(m.color) })),
    // theme is part of the key so colours are re-resolved when the palette changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [markers, theme],
  );
  const scatter = useMemo(
    () =>
      drawable.flagged.length > 0
        ? [
            {
              id: 'flagged',
              name: 'Non-good quality sample',
              data: drawable.flagged,
              color: resolveCssColor('var(--event-raised)'),
            },
          ]
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [drawable.flagged, theme],
  );
  const chartSeries = useMemo(
    () => [{ id: 'main', name: series.name, data: drawable.line }],
    [drawable.line, series.name],
  );
  const nominal = useMemo(
    () => ({ min: series.nominalMin, max: series.nominalMax }),
    [series.nominalMin, series.nominalMax],
  );
  const last = series.t.length - 1;
  const description =
    series.t.length === 0
      ? 'No stored samples in this window.'
      : `${String(series.t.length)} stored samples, last value ${formatValue(series.v[last] ?? null, series.unit)}.`;
  return (
    <div className="replay-chart">
      <div className="chart-card__title">
        <span>{series.name}</span>
        <span className="muted small">
          {series.unit}
          {series.truncated ? ' · truncated by server limit' : ''}
        </span>
      </div>
      <TimeSeriesChart
        label={`${series.name} (${series.unit}) over the replay window`}
        description={description}
        unit={series.unit}
        series={chartSeries}
        scatter={scatter}
        xMin={model.from}
        xMax={model.to}
        nominal={nominal}
        gaps={gaps}
        markers={resolvedMarkers}
        showMarkerLabels={showLabels}
        xLabels={xLabels}
        gridLeft={REPLAY_GRID_LEFT}
        gridRight={REPLAY_GRID_RIGHT}
        height={height}
        onSeek={(ms) => {
          store.seek(ms);
        }}
        emptyMessage="No stored telemetry in this window"
        overlay={
          <CursorOverlay
            store={store}
            from={model.from}
            to={model.to}
            gridLeft={REPLAY_GRID_LEFT}
            gridRight={REPLAY_GRID_RIGHT}
          />
        }
      />
    </div>
  );
}

export const ReplayChart = memo(ReplayChartImpl);
