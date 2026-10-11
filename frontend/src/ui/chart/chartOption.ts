import { formatAxisTime, formatNumber, formatTimestamp } from '@/lib/format';
import type { TimeMode } from '@/lib/settingsStore';

/** [epoch ms, value, optional quality]. A null value breaks the line (used at data gaps). */
export type ChartPoint = [number, number | null, string?];

export interface ChartSeriesSpec {
  id: string;
  name: string;
  data: ChartPoint[];
  tone?: 'primary' | 'secondary';
  dashed?: boolean;
  width?: number;
  opacity?: number;
}

export interface ChartScatterSpec {
  id: string;
  name: string;
  data: ChartPoint[];
  color: string;
}

export interface ChartMarker {
  x: number;
  name: string;
  color: string;
  label?: string;
  lineType?: 'solid' | 'dashed' | 'dotted';
  width?: number;
}

export interface ChartArea {
  from: number;
  to: number;
  label?: string;
}

export interface ChartPalette {
  line: string;
  line2: string;
  grid: string;
  axis: string;
  band: string;
  gap: string;
  cursor: string;
  text: string;
  tooltipBg: string;
  tooltipBorder: string;
}

export interface ChartSpec {
  unit: string;
  series: ChartSeriesSpec[];
  scatter?: ChartScatterSpec[];
  xMin: number;
  xMax: number;
  nominal?: { min: number | null; max: number | null };
  gaps?: ChartArea[];
  markers?: ChartMarker[];
  showMarkerLabels?: boolean;
  xLabels: boolean;
  gridLeft: number;
  gridRight: number;
  timeMode: TimeMode;
  palette: ChartPalette;
}

export const CHART_TOP = 28;
export const CHART_BOTTOM_WITH_LABELS = 30;
export const CHART_BOTTOM_NO_LABELS = 8;

/** Y-axis extent covering the data and the nominal band, with a small margin. */
export function computeYExtent(
  series: readonly { data: readonly ChartPoint[] }[],
  nominal?: { min: number | null; max: number | null },
): { min: number; max: number } {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const s of series) {
    for (const p of s.data) {
      const v = p[1];
      if (v !== null && Number.isFinite(v)) {
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
  }
  if (nominal?.min !== null && nominal?.min !== undefined) lo = Math.min(lo, nominal.min);
  if (nominal?.max !== null && nominal?.max !== undefined) hi = Math.max(hi, nominal.max);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { min: 0, max: 1 };
  if (hi === lo) {
    const pad = Math.abs(hi) * 0.05 || 1;
    return { min: lo - pad, max: hi + pad };
  }
  const pad = (hi - lo) * 0.08;
  return { min: lo - pad, max: hi + pad };
}

/** Rounds an extent outwards to "nice" tick boundaries; returns the tick interval too. */
export function niceExtent(min: number, max: number, ticks = 3): { min: number; max: number; interval: number } {
  const span = max - min;
  const rough = span / ticks;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / pow;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * pow;
  const lo = Math.floor(min / step) * step;
  // Quantities that are never negative should not get a negative axis just because of rounding.
  return { min: min >= 0 && lo < 0 ? 0 : lo, max: Math.ceil(max / step) * step, interval: step };
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${String(c.charCodeAt(0))};`);
}

interface TooltipParam {
  seriesName?: string;
  value?: unknown;
  marker?: string;
  axisValue?: number | string;
}

export function tooltipFormatter(spec: Pick<ChartSpec, 'unit' | 'timeMode'>) {
  return (raw: unknown): string => {
    const params = (Array.isArray(raw) ? raw : [raw]) as TooltipParam[];
    const first = params[0];
    if (!first) return '';
    const axis = Array.isArray(first.value) ? (first.value[0] as unknown) : first.axisValue;
    const ms = typeof axis === 'number' ? axis : Number(axis);
    const lines = [
      `<div style="font-family:ui-monospace,monospace;margin-bottom:4px">${escapeHtml(
        formatTimestamp(ms, spec.timeMode, { millis: true }),
      )}</div>`,
    ];
    for (const p of params) {
      if (!Array.isArray(p.value)) continue;
      const tuple: unknown[] = p.value;
      const v = tuple[1];
      if (typeof v !== 'number') continue;
      const quality = typeof tuple[2] === 'string' ? tuple[2] : undefined;
      const flag =
        quality !== undefined && quality !== 'good' ? ` <em>(${escapeHtml(quality)})</em>` : '';
      lines.push(
        `<div>${p.marker ?? ''} ${escapeHtml(p.seriesName ?? '')}: <b>${escapeHtml(formatNumber(v))}</b> ${escapeHtml(spec.unit)}${flag}</div>`,
      );
    }
    return lines.join('');
  };
}

/** Builds the ECharts option for one time-series panel. Pure, so it can be unit-tested. */
export function buildChartOption(spec: ChartSpec): Record<string, unknown> {
  const { palette } = spec;
  const rawExtent = computeYExtent(spec.series, spec.nominal);
  const extent = niceExtent(rawExtent.min, rawExtent.max);
  const hasBand =
    spec.nominal?.min != null && spec.nominal.max != null && spec.nominal.max > spec.nominal.min;

  const markAreaData: unknown[] = [];
  if (hasBand && spec.nominal) {
    markAreaData.push([
      { yAxis: spec.nominal.min, itemStyle: { color: palette.band } },
      { yAxis: spec.nominal.max },
    ]);
  }
  for (const gap of spec.gaps ?? []) {
    markAreaData.push([
      {
        xAxis: gap.from,
        itemStyle: {
          color: palette.gap,
          borderColor: palette.axis,
          borderType: 'dashed',
          borderWidth: 0.5,
        },
        label: {
          show: Boolean(gap.label),
          formatter: gap.label ?? '',
          color: palette.axis,
          fontSize: 10,
        },
      },
      { xAxis: gap.to },
    ]);
  }
  const markLineData = (spec.markers ?? []).map((m) => ({
    xAxis: m.x,
    name: m.name,
    lineStyle: { color: m.color, type: m.lineType ?? 'dashed', width: m.width ?? 1.5 },
    label: {
      show: Boolean(spec.showMarkerLabels && m.label),
      formatter: m.label ?? '',
      color: m.color,
      fontSize: 10,
      position: 'insideEndTop',
    },
  }));

  const lineSeries = spec.series.map((s, index) => ({
    id: s.id,
    name: s.name,
    type: 'line',
    data: s.data,
    showSymbol: false,
    symbolSize: 4,
    connectNulls: false,
    sampling: 'lttb',
    animation: false,
    emphasis: { disabled: true },
    lineStyle: {
      width: s.width ?? 1.6,
      type: s.dashed ? 'dashed' : 'solid',
      opacity: s.opacity ?? 1,
      color: s.tone === 'secondary' ? palette.line2 : palette.line,
    },
    itemStyle: { color: s.tone === 'secondary' ? palette.line2 : palette.line },
    z: 3,
    ...(index === 0
      ? {
          markArea: { silent: true, animation: false, data: markAreaData },
          markLine: { silent: true, symbol: 'none', animation: false, data: markLineData },
        }
      : {}),
  }));

  const scatterSeries = (spec.scatter ?? []).map((s) => ({
    id: s.id,
    name: s.name,
    type: 'scatter',
    data: s.data,
    symbol: 'diamond',
    symbolSize: 9,
    large: true,
    animation: false,
    itemStyle: { color: s.color, borderColor: palette.text, borderWidth: 1 },
    z: 4,
  }));

  // A marker-only chart (no line series) still needs a host series for the mark lines / areas.
  const hostSeries =
    lineSeries.length === 0
      ? [
          {
            id: 'host',
            type: 'line',
            data: [],
            silent: true,
            animation: false,
            markArea: { silent: true, animation: false, data: markAreaData },
            markLine: { silent: true, symbol: 'none', animation: false, data: markLineData },
          },
        ]
      : [];

  return {
    animation: false,
    useUTC: spec.timeMode === 'utc',
    backgroundColor: 'transparent',
    textStyle: { color: palette.axis },
    grid: {
      left: spec.gridLeft,
      right: spec.gridRight,
      top: CHART_TOP,
      bottom: spec.xLabels ? CHART_BOTTOM_WITH_LABELS : CHART_BOTTOM_NO_LABELS,
    },
    tooltip: {
      trigger: 'axis',
      confine: true,
      transitionDuration: 0,
      backgroundColor: palette.tooltipBg,
      borderColor: palette.tooltipBorder,
      textStyle: { color: palette.text, fontSize: 12 },
      axisPointer: { type: 'line', lineStyle: { color: palette.axis, type: 'dotted' } },
      formatter: tooltipFormatter(spec),
    },
    xAxis: {
      type: 'time',
      min: spec.xMin,
      max: spec.xMax,
      axisLine: { lineStyle: { color: palette.grid } },
      axisTick: { show: spec.xLabels },
      axisLabel: {
        show: spec.xLabels,
        color: palette.axis,
        fontSize: 11,
        hideOverlap: true,
        formatter: (value: number) => formatAxisTime(value, spec.timeMode),
      },
      splitLine: { show: true, lineStyle: { color: palette.grid } },
    },
    yAxis: {
      type: 'value',
      min: extent.min,
      max: extent.max,
      interval: extent.interval,
      name: spec.unit,
      nameLocation: 'end',
      nameGap: 14,
      nameTextStyle: { color: palette.axis, align: 'right', fontSize: 11 },
      axisLabel: {
        color: palette.axis,
        fontSize: 11,
        formatter: (v: number) => formatNumber(v, 3),
      },
      splitLine: { lineStyle: { color: palette.grid } },
    },
    series: [...lineSeries, ...hostSeries, ...scatterSeries],
  };
}
