import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { iso, makeIncidentWindow } from '@/test/fixtures';
import { apiError, installApi } from '@/test/mockApi';
import { renderApp } from '@/test/render';

/** Manual animation-frame clock: playback is driven deterministically through it. */
let frame: ((time: number) => void) | null = null;
let now = 1000;
function tick(ms: number) {
  now += ms;
  const cb = frame;
  frame = null;
  act(() => {
    cb?.(now);
  });
}

beforeEach(() => {
  frame = null;
  now = 1000;
  vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => {
    frame = cb;
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {
    frame = null;
  });
  vi.spyOn(performance, 'now').mockImplementation(() => now);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const alarmRoutes = (window = makeIncidentWindow()) => ({
  'GET /api/v1/incidents/alarm/7': () => window,
});

async function openReplay(route = '/replay?alarm=7', routes = alarmRoutes()) {
  const api = installApi(routes);
  const view = renderApp({ route });
  const workbench = await screen.findByTestId('replay-workbench');
  return { api, view, workbench };
}

const cursorTime = () => screen.getByTestId('cursor-time');
const seek = (seconds: number) => {
  fireEvent.change(screen.getByLabelText('Seek position in the replay window'), {
    target: { value: String(seconds * 1000) },
  });
};
const rowFor = (measurement: string) => within(screen.getByTestId(`cursor-${measurement}`));

describe('loading the replay', () => {
  it('uses the alarm incident endpoint with the default context and shows the focus alarm', async () => {
    const { api } = await openReplay();
    const call = api.lastCall('GET', '/api/v1/incidents/alarm/7')!;
    expect(call.query.get('before_s')).toBe('300');
    expect(call.query.get('after_s')).toBe('300');
    expect(screen.getByText('Focus alarm')).toBeInTheDocument();
    expect(screen.getByTestId('window-range')).toHaveTextContent(
      '2026-03-01 10:00:00 UTC → 2026-03-01 10:01:00 UTC',
    );
    expect(screen.getAllByRole('img', { name: /over the replay window/ })).toHaveLength(2);
  });

  it('shows a loading skeleton first', () => {
    installApi({ 'GET /api/v1/incidents/alarm/7': () => new Promise(() => undefined) });
    renderApp({ route: '/replay?alarm=7' });
    expect(screen.getByRole('status', { name: 'Loading replay data' })).toBeInTheDocument();
  });

  it('supports ?vessel=&equipment=&from=&to= deep links', async () => {
    const api = installApi({
      'GET /api/v1/incidents/window': () => makeIncidentWindow({ focus_alarm_id: null }),
    });
    renderApp({ route: `/replay?vessel=VES-001&equipment=ME1&from=${iso(0)}&to=${iso(60)}` });
    await screen.findByTestId('replay-workbench');
    const q = api.lastCall('GET', '/api/v1/incidents/window')!.query;
    expect(q.get('vessel')).toBe('VES-001');
    expect(q.get('equipment')).toBe('ME1');
    expect(q.get('from')).toBe(iso(0));
    expect(q.get('to')).toBe(iso(60));
    expect(screen.queryByTestId('phase')).toBeNull(); // no focus alarm => no phase
  });

  it('asks the user to pick an incident when there is none, and explains broken links', async () => {
    installApi();
    const first = renderApp({ route: '/replay' });
    expect(await screen.findByText('No incident selected')).toBeInTheDocument();
    first.unmount();
    renderApp({ route: '/replay?vessel=VES-001' });
    expect(await screen.findByText('This replay link cannot be used.')).toBeInTheDocument();
  });

  it('adjusts the context seconds around an alarm', async () => {
    const api = installApi(alarmRoutes());
    const user = userEvent.setup();
    renderApp({ route: '/replay?alarm=7' });
    await screen.findByTestId('replay-workbench');
    const before = screen.getByLabelText('Seconds before alarm');
    await user.clear(before);
    await user.type(before, '60');
    await user.click(screen.getByRole('button', { name: 'Load replay' }));
    await waitFor(() => {
      const q = api.lastCall('GET', '/api/v1/incidents/alarm/7')!.query;
      expect(q.get('before_s')).toBe('60');
      expect(q.get('after_s')).toBe('300');
    });
  });

  it('builds a window request from a preset or a custom UTC range', async () => {
    const api = installApi({
      'GET /api/v1/incidents/window': () => makeIncidentWindow({ focus_alarm_id: null }),
    });
    const user = userEvent.setup();
    renderApp({ route: '/replay' });
    await user.click(await screen.findByRole('button', { name: 'Load replay' }));
    await screen.findByTestId('replay-workbench');
    let q = api.lastCall('GET', '/api/v1/incidents/window')!.query;
    expect(q.get('vessel')).toBe('VES-001');
    expect(q.get('equipment')).toBe('ME1');
    expect(Date.parse(q.get('to')!) - Date.parse(q.get('from')!)).toBe(15 * 60_000);

    await user.click(screen.getByRole('button', { name: 'Custom' }));
    fireEvent.change(screen.getByLabelText('From (UTC)'), {
      target: { value: '2026-03-01T10:00:00' },
    });
    fireEvent.change(screen.getByLabelText('To (UTC)'), {
      target: { value: '2026-03-01T10:20:00' },
    });
    await user.click(screen.getByRole('button', { name: 'Load replay' }));
    await waitFor(() => {
      q = api.lastCall('GET', '/api/v1/incidents/window')!.query;
      expect(q.get('from')).toBe('2026-03-01T10:00:00.000Z');
      expect(q.get('to')).toBe('2026-03-01T10:20:00.000Z');
    });
  });

  it('validates a custom range before calling the server', async () => {
    const api = installApi();
    const user = userEvent.setup();
    renderApp({ route: '/replay' });
    await user.click(await screen.findByRole('button', { name: 'Custom' }));
    fireEvent.change(screen.getByLabelText('From (UTC)'), {
      target: { value: '2026-03-01T11:00:00' },
    });
    fireEvent.change(screen.getByLabelText('To (UTC)'), {
      target: { value: '2026-03-01T10:00:00' },
    });
    await user.click(screen.getByRole('button', { name: 'Load replay' }));
    expect(await screen.findByText('The start must be earlier than the end.')).toBeInTheDocument();
    expect(api.callsTo('GET', '/api/v1/incidents/window')).toHaveLength(0);
  });
});

describe('errors and empty data', () => {
  it('shows the window_too_large error with a hint and a retry', async () => {
    installApi({
      'GET /api/v1/incidents/window': () =>
        apiError(
          422,
          'window_too_large',
          'Replay windows are limited to 7200 s (120 min) so the data stays playable',
        ),
    });
    renderApp({ route: `/replay?vessel=VES-001&equipment=ME1&from=${iso(-86400)}&to=${iso(0)}` });
    const alert = (await screen.findByText('Replay window too large')).closest(
      '[role="alert"]',
    )!;
    expect(alert).toHaveTextContent('Replay window too large');
    expect(alert).toHaveTextContent('limited to 7200 s');
    expect(alert).toHaveTextContent(/shorter time range/i);
    expect(within(alert).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('says so explicitly when the window holds no stored telemetry', async () => {
    const empty = makeIncidentWindow({
      series: makeIncidentWindow().series.map((s) => ({ ...s, points: [] })),
      point_count: 0,
      first_ts: null,
      last_ts: null,
      gaps: [],
      alarm_events: [],
      alarms: [],
      state_changes: [],
      state_at_start: null,
      focus_alarm_id: null,
    });
    installApi({ 'GET /api/v1/incidents/window': () => empty });
    renderApp({ route: `/replay?vessel=VES-001&equipment=ME1&from=${iso(0)}&to=${iso(60)}` });
    await screen.findByTestId('replay-workbench');
    expect(screen.getAllByText('No stored telemetry in this window.').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Step forward to next sample' })).toBeDisabled();
    expect(screen.getByText('No events in this window')).toBeInTheDocument();
  });

  it('warns when the server truncated a series', async () => {
    const w = makeIncidentWindow();
    w.series[0]!.truncated = true;
    await openReplay('/replay?alarm=7', alarmRoutes(w));
    expect(screen.getByText('Some series were truncated.')).toBeInTheDocument();
  });
});

describe('state at cursor uses the last STORED sample', () => {
  it('shows "no sample yet" before the first stored sample and phase "before alarm"', async () => {
    const w = makeIncidentWindow({ from: iso(-10) });
    await openReplay('/replay?alarm=7', alarmRoutes(w));
    expect(rowFor('temperature').getByText('No sample yet at this position')).toBeInTheDocument();
    expect(screen.getByTestId('phase')).toHaveTextContent('Before alarm');
  });

  it('shows value, unit, quality, its own timestamp and its age relative to the cursor', async () => {
    await openReplay();
    seek(10);
    const temp = rowFor('temperature');
    expect(temp.getByTestId('cursor-value')).toHaveTextContent('85');
    expect(screen.getByTestId('cursor-temperature')).toHaveTextContent('°C');
    expect(temp.getByText('Good')).toBeInTheDocument();
    expect(screen.getByTestId('cursor-temperature')).toHaveTextContent('10:00:10.000');
    expect(temp.getByTestId('cursor-sample-age')).toHaveTextContent('at the cursor');
  });

  it('does not interpolate between samples: the previous stored value is shown with its true age', async () => {
    await openReplay();
    seek(10.4);
    const temp = rowFor('temperature');
    expect(temp.getByTestId('cursor-value')).toHaveTextContent(/^85$/); // not 85.2
    expect(temp.getByTestId('cursor-sample-age')).toHaveTextContent('0.4 s before the cursor');
  });

  it('keeps the last sample across a data gap, with its growing age and a gap badge', async () => {
    await openReplay();
    seek(33);
    const rpm = rowFor('rpm');
    expect(rpm.getByTestId('cursor-value')).toHaveTextContent('120'); // stored at 20 s
    expect(rpm.getByTestId('cursor-sample-age')).toHaveTextContent('13 s before the cursor');
    expect(rpm.getByText(/Inside a data gap of 20 s/)).toBeInTheDocument();
    // temperature has samples during the same period
    expect(rowFor('temperature').getByTestId('cursor-value')).toHaveTextContent('96.5');
  });

  it('shows equipment state and the alarms open at the cursor, changing with phase', async () => {
    await openReplay();
    seek(20);
    expect(screen.getByTestId('equipment-state')).toHaveTextContent('RUNNING');
    expect(screen.getByText('No alarm was open at this position.')).toBeInTheDocument();
    seek(40);
    expect(screen.getByTestId('equipment-state')).toHaveTextContent('DEGRADED');
    const open = screen.getByRole('list', { name: 'Open alarms at cursor' });
    expect(within(open).getByText('Active - unacknowledged')).toBeInTheDocument();
    expect(screen.getByTestId('phase')).toHaveTextContent('During alarm');
    seek(47);
    expect(
      within(screen.getByRole('list', { name: 'Open alarms at cursor' })).getByText(
        'Active - acknowledged',
      ),
    ).toBeInTheDocument();
    seek(58);
    expect(screen.getByTestId('phase')).toHaveTextContent('After alarm (condition cleared)');
    expect(screen.getByText('No alarm was open at this position.')).toBeInTheDocument();
  });
});

describe('playback controls', () => {
  it('plays in data time, honours the speed, and pauses', async () => {
    const user = userEvent.setup();
    await openReplay();
    await user.click(screen.getByRole('button', { name: 'Play' }));
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument();
    tick(2000);
    expect(cursorTime()).toHaveTextContent('10:00:02.000');
    await user.click(screen.getByRole('button', { name: '10x' }));
    tick(1000);
    expect(cursorTime()).toHaveTextContent('10:00:12.000');
    await user.click(screen.getByRole('button', { name: '0.5x' }));
    tick(2000);
    expect(cursorTime()).toHaveTextContent('10:00:13.000');
    await user.click(screen.getByRole('button', { name: 'Pause' }));
    tick(5000);
    expect(cursorTime()).toHaveTextContent('10:00:13.000');
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument();
  });

  it('pauses at the end of the window', async () => {
    const user = userEvent.setup();
    await openReplay();
    await user.click(screen.getByRole('button', { name: '30x' }));
    await user.click(screen.getByRole('button', { name: 'Play' }));
    tick(1000);
    tick(1000);
    tick(1000);
    expect(cursorTime()).toHaveTextContent('10:01:00.000');
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument();
  });

  it('seeks with the slider and moves the cursor line on every chart', async () => {
    await openReplay();
    seek(30);
    expect(cursorTime()).toHaveTextContent('10:00:30.000');
    const lines = screen.getAllByTestId('cursor-line');
    expect(lines.length).toBe(3); // state strip + two charts
    for (const line of lines) expect((line).style.left).toContain('64px + 0.5 *'); // 30 s of 60 s
  });

  it('steps to the previous and next STORED sample', async () => {
    const user = userEvent.setup();
    await openReplay();
    seek(20.5);
    await user.click(screen.getByRole('button', { name: 'Step forward to next sample' }));
    expect(cursorTime()).toHaveTextContent('10:00:21.000');
    await user.click(screen.getByRole('button', { name: 'Step back to previous sample' }));
    expect(cursorTime()).toHaveTextContent('10:00:20.000');
    await user.click(screen.getByRole('button', { name: 'Step back to previous sample' }));
    expect(cursorTime()).toHaveTextContent('10:00:19.000');
    seek(0);
    expect(screen.getByRole('button', { name: 'Step back to previous sample' })).toBeDisabled();
  });

  it('jumps to alarm raised / cleared and between events', async () => {
    const user = userEvent.setup();
    await openReplay();
    await user.click(screen.getByRole('button', { name: 'Jump to alarm raised' }));
    expect(cursorTime()).toHaveTextContent('10:00:30.000');
    expect(screen.getByTestId('phase')).toHaveTextContent('During alarm');
    expect(screen.getByTestId('cursor-offset')).toHaveTextContent('T+00:00');
    await user.click(screen.getByRole('button', { name: 'Next alarm event' }));
    expect(cursorTime()).toHaveTextContent('10:00:45.000');
    await user.click(screen.getByRole('button', { name: 'Previous alarm event' }));
    expect(cursorTime()).toHaveTextContent('10:00:30.000');
    await user.click(screen.getByRole('button', { name: 'Jump to alarm cleared' }));
    expect(cursorTime()).toHaveTextContent('10:00:55.000');
    expect(screen.getByTestId('phase')).toHaveTextContent('After alarm');
  });

  it('seeks when a timeline event is selected and marks the current one', async () => {
    const user = userEvent.setup();
    await openReplay();
    const timeline = screen.getByRole('list', { name: 'Chronological alarm events' });
    const entries = within(timeline).getAllByRole('button');
    expect(entries).toHaveLength(4); // raised, state change, acknowledged, cleared
    await user.click(within(timeline).getByRole('button', { name: /Acknowledged/ }));
    expect(cursorTime()).toHaveTextContent('10:00:45.000');
    expect(within(timeline).getByRole('button', { name: /Acknowledged/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(within(timeline).getByRole('button', { name: /Acknowledged/ })).toHaveTextContent(
      'operator',
    );
  });

  it('is operable from the keyboard: Space plays/pauses, arrows step, typing in a field is ignored', async () => {
    const user = userEvent.setup();
    await openReplay();
    expect(screen.getByText('play / pause', { exact: false })).toBeInTheDocument(); // visible hint
    await user.keyboard(' ');
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument();
    await user.keyboard(' ');
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument();
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(cursorTime()).toHaveTextContent('10:00:02.000');
    await user.keyboard('{ArrowLeft}');
    expect(cursorTime()).toHaveTextContent('10:00:01.000');
  });

  it('ignores shortcuts while typing in a form field', async () => {
    const user = userEvent.setup();
    await openReplay('/replay?alarm=7');
    await user.click(screen.getByLabelText('Seconds before alarm'));
    await user.keyboard(' {ArrowRight}');
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument();
    expect(cursorTime()).toHaveTextContent('10:00:00.000');
  });
});

describe('alarm markers', () => {
  it('passes alarm events and state changes to the chart as labelled markers and gaps as areas', async () => {
    const { echarts } = await import('@/ui/chart/echartsCore');
    await openReplay();
    const chart = (
      echarts.init as unknown as {
        mock: { results: { value: { setOption: { mock: { calls: unknown[][] } } } }[] };
      }
    ).mock.results[0]!.value;
    const options = chart.setOption.mock.calls.map(
      (c) =>
        c[0] as {
          series: {
            markLine?: { data: { name: string; label: { formatter: string } }[] };
            markArea?: { data: unknown[] };
          }[];
        },
    );
    const top = options.at(-1)!;
    const marks = top.series[0]!.markLine!.data;
    expect(marks.map((m) => m.label.formatter).filter(Boolean)).toEqual(
      expect.arrayContaining(['▲ WARN raised', '✓ WARN ack', '▼ WARN normal']),
    );
  });
});
