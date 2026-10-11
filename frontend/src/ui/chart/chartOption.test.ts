import { describe, expect, it } from 'vitest';
import {
  buildChartOption,
  computeYExtent,
  niceExtent,
  tooltipFormatter,
  type ChartPalette,
  type ChartSpec,
} from './chartOption';

const palette: ChartPalette = {
  line: '#1',
  line2: '#2',
  grid: '#3',
  axis: '#4',
  band: '#5',
  gap: '#6',
  cursor: '#7',
  text: '#8',
  tooltipBg: '#9',
  tooltipBorder: '#a',
};

const spec = (over: Partial<ChartSpec> = {}): ChartSpec => ({
  unit: '°C',
  series: [
    {
      id: 'main',
      name: 'Temp',
      data: [
        [1000, 80],
        [2000, 90],
        [3000, null],
        [4000, 85],
      ],
    },
  ],
  xMin: 0,
  xMax: 5000,
  xLabels: true,
  gridLeft: 60,
  gridRight: 10,
  timeMode: 'utc',
  palette,
  ...over,
});

describe('computeYExtent / niceExtent', () => {
  it('covers data and nominal band with margin, ignoring nulls', () => {
    const e = computeYExtent(
      [
        {
          data: [
            [0, 80],
            [1, null],
            [2, 90],
          ],
        },
      ],
      { min: 70, max: 100 },
    );
    expect(e.min).toBeLessThan(70);
    expect(e.max).toBeGreaterThan(100);
  });
  it('handles flat and empty data', () => {
    expect(
      computeYExtent([
        {
          data: [
            [0, 5],
            [1, 5],
          ],
        },
      ]).max,
    ).toBeGreaterThan(5);
    expect(computeYExtent([{ data: [] }])).toEqual({ min: 0, max: 1 });
  });
  it('rounds to tick boundaries and does not go negative for non-negative data', () => {
    const n = niceExtent(0.4, 87.3);
    expect(n.max % n.interval).toBe(0);
    expect(niceExtent(0.4, 87.3).min).toBe(0);
    expect(niceExtent(-12, 30).min).toBeLessThan(0);
  });
});

interface Opt {
  useUTC: boolean;
  animation: boolean;
  xAxis: { type: string; min: number; max: number; axisLabel: { show: boolean } };
  yAxis: { name: string };
  series: {
    type: string;
    connectNulls: boolean;
    sampling: string;
    markArea: { data: Record<string, unknown>[][] };
    markLine: { data: { xAxis: number; lineStyle: { type: string }; label: { show: boolean; formatter: string } }[] };
  }[];
}
const build = (s: ChartSpec) => buildChartOption(s) as unknown as Opt;

describe('buildChartOption', () => {
  it('uses a fixed time axis in the requested zone with a unit on the y axis', () => {
    const o = build(spec());
    expect(o.xAxis).toMatchObject({ type: 'time', min: 0, max: 5000 });
    expect(o.useUTC).toBe(true);
    expect(o.yAxis.name).toBe('°C');
    expect(o.animation).toBe(false);
    expect(build(spec({ timeMode: 'local' })).useUTC).toBe(
      false,
    );
  });
  it('draws nulls as breaks (no connection) and enables sampling for big series', () => {
    const o = build(spec());
    expect(o.series[0]!.connectNulls).toBe(false);
    expect(o.series[0]!.sampling).toBe('lttb');
  });
  it('adds the nominal band, gap areas and labelled alarm markers to the first series', () => {
    const o = build(
      spec({
        nominal: { min: 78, max: 88 },
        gaps: [{ from: 2000, to: 4000, label: 'no data' }],
        markers: [
          { x: 1500, name: 'raised', label: '▲ CRIT raised', color: '#f00', lineType: 'solid' },
        ],
        showMarkerLabels: true,
      }),
    );
    const areas = o.series[0]!.markArea.data;
    expect(areas).toHaveLength(2);
    expect(areas[0]![0]!.yAxis).toBe(78);
    expect(areas[1]![0]!.xAxis).toBe(2000);
    const line = o.series[0]!.markLine.data[0]!;
    expect(line).toMatchObject({ xAxis: 1500, lineStyle: { type: 'solid' } });
    expect(line.label.show).toBe(true);
  });
  it('hides marker labels unless requested and hides x labels when asked', () => {
    const o = build(
      spec({ markers: [{ x: 1, name: 'a', label: 'L', color: '#f00' }], xLabels: false }),
    );
    expect(o.series[0]!.markLine.data[0]!.label.show).toBe(false);
    expect(o.xAxis.axisLabel.show).toBe(false);
  });
  it('creates a host series for marker-only charts and a scatter layer for flagged points', () => {
    const o = build(
      spec({
        series: [],
        scatter: [{ id: 'f', name: 'Flagged', data: [[1000, 500, 'invalid']], color: '#f00' }],
        markers: [{ x: 1, name: 'a', color: '#f00' }],
      }),
    );
    expect(o.series.map((x) => x.type)).toEqual(['line', 'scatter']);
  });
});

describe('tooltipFormatter', () => {
  it('shows a labelled UTC timestamp, value, unit and non-good quality; escapes HTML', () => {
    const f = tooltipFormatter({ unit: '°C', timeMode: 'utc' });
    const html = f([
      {
        seriesName: '<b>Temp</b>',
        value: [Date.parse('2026-03-01T10:00:00.250Z'), 91.234, 'uncertain'],
        marker: '',
      },
    ]);
    expect(html).toContain('2026-03-01 10:00:00.250 UTC');
    expect(html).toContain('91.23');
    expect(html).toContain('°C');
    expect(html).toContain('(uncertain)');
    expect(html).not.toContain('<b>Temp</b>');
  });
  it('skips null points and empty input', () => {
    const f = tooltipFormatter({ unit: 'x', timeMode: 'utc' });
    expect(f([])).toBe('');
    expect(f([{ seriesName: 'a', value: [1000, null] }])).not.toContain('<b>');
  });
});
