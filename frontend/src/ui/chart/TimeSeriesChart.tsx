import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { resolveTheme, useSettings } from '@/lib/settingsStore';
import {
  buildChartOption,
  CHART_BOTTOM_NO_LABELS,
  CHART_BOTTOM_WITH_LABELS,
  CHART_TOP,
  type ChartArea,
  type ChartMarker,
  type ChartPalette,
  type ChartScatterSpec,
  type ChartSeriesSpec,
} from './chartOption';
import { echarts, type ECharts, type EChartsCoreOption } from './echartsCore';

export interface TimeSeriesChartProps {
  /** Accessible name; describe the measurement and window. */
  label: string;
  /** Longer text alternative announced after the label (latest value, range...). */
  description?: string;
  unit: string;
  series: ChartSeriesSpec[];
  scatter?: ChartScatterSpec[];
  xMin: number;
  xMax: number;
  nominal?: { min: number | null; max: number | null };
  gaps?: ChartArea[];
  markers?: ChartMarker[];
  showMarkerLabels?: boolean;
  height?: number;
  xLabels?: boolean;
  gridLeft?: number;
  gridRight?: number;
  /** Called with the data time (epoch ms) under a click, e.g. to seek the replay cursor. */
  onSeek?: (ms: number) => void;
  /** Rendered inside the plot wrapper, e.g. the synchronised playback cursor. */
  overlay?: ReactNode;
  /** Shown over an empty plot. */
  emptyMessage?: string;
}

function readPalette(): ChartPalette {
  const css = getComputedStyle(document.documentElement);
  const get = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    line: get('--chart-line', '#4fb3bf'),
    line2: get('--chart-line-2', '#8aa4c8'),
    grid: get('--chart-grid', '#1f3047'),
    axis: get('--chart-axis', '#8fa3b8'),
    band: get('--chart-band', 'rgba(79,179,191,0.12)'),
    gap: get('--chart-gap', 'rgba(143,163,184,0.14)'),
    cursor: get('--chart-cursor', '#f2f6fa'),
    text: get('--text', '#d7e0ea'),
    tooltipBg: get('--surface-3', '#1a2f4d'),
    tooltipBorder: get('--border-strong', '#2f4766'),
  };
}

/** Re-renders when the data-theme attribute flips so canvas colours follow the CSS tokens. */
function useThemeVersion(): string {
  const choice = useSettings((s) => s.theme);
  const [attr, setAttr] = useState(() => document.documentElement.getAttribute('data-theme') ?? '');
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setAttr(document.documentElement.getAttribute('data-theme') ?? '');
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => {
      observer.disconnect();
    };
  }, []);
  return `${attr}:${resolveTheme(choice)}`;
}

export function TimeSeriesChart({
  label,
  description,
  unit,
  series,
  scatter,
  xMin,
  xMax,
  nominal,
  gaps,
  markers,
  showMarkerLabels = false,
  height = 160,
  xLabels = true,
  gridLeft = 58,
  gridRight = 16,
  onSeek,
  overlay,
  emptyMessage,
}: TimeSeriesChartProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ECharts | null>(null);
  const seekRef = useRef(onSeek);
  const [failed, setFailed] = useState(false);
  const timeMode = useSettings((s) => s.timeMode);
  const themeVersion = useThemeVersion();

  useEffect(() => {
    seekRef.current = onSeek;
  });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let chart: ECharts;
    try {
      chart = echarts.init(host, undefined, { renderer: 'canvas' });
    } catch {
      setFailed(true);
      return;
    }
    chartRef.current = chart;
    const zr = chart.getZr();
    zr.on('click', (event: { offsetX: number; offsetY: number }) => {
      const handler = seekRef.current;
      if (!handler) return;
      const converted = chart.convertFromPixel({ xAxisIndex: 0 }, [
        event.offsetX,
        event.offsetY,
      ]) as unknown;
      const x = Array.isArray(converted) ? (converted[0] as unknown) : converted;
      if (typeof x === 'number' && Number.isFinite(x)) handler(x);
    });
    const observer = new ResizeObserver(() => {
      chart.resize();
    });
    observer.observe(host);
    return () => {
      observer.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  const option = useMemo(
    () =>
      buildChartOption({
        unit,
        series,
        scatter,
        xMin,
        xMax,
        nominal,
        gaps,
        markers,
        showMarkerLabels,
        xLabels,
        gridLeft,
        gridRight,
        timeMode,
        palette: readPalette(),
      }),
    // themeVersion forces a palette re-read when the theme changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      unit,
      series,
      scatter,
      xMin,
      xMax,
      nominal,
      gaps,
      markers,
      showMarkerLabels,
      xLabels,
      gridLeft,
      gridRight,
      timeMode,
      themeVersion,
    ],
  );

  useEffect(() => {
    chartRef.current?.setOption(option as EChartsCoreOption, { notMerge: true });
  }, [option]);

  const style = {
    height,
    '--grid-left': `${String(gridLeft)}px`,
    '--grid-right': `${String(gridRight)}px`,
    '--grid-top': `${String(CHART_TOP)}px`,
    '--grid-bottom': `${String(xLabels ? CHART_BOTTOM_WITH_LABELS : CHART_BOTTOM_NO_LABELS)}px`,
  } as CSSProperties;

  const empty =
    series.every((s) => s.data.length === 0) && (scatter ?? []).every((s) => s.data.length === 0);

  return (
    <div className="chart" style={style}>
      <div
        className="chart__frame"
        role="img"
        aria-label={description ? `${label}. ${description}` : label}
        style={{ position: 'relative', height: '100%' }}
      >
        <div ref={hostRef} className="chart__canvas" style={{ height: '100%' }} />
        {overlay}
        {empty && emptyMessage ? (
          <div className="chart__empty" aria-hidden="true">
            {emptyMessage}
          </div>
        ) : null}
        {failed ? (
          <div className="chart__empty">
            Chart unavailable: canvas rendering is not supported here.
          </div>
        ) : null}
      </div>
    </div>
  );
}
