import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useLive } from '@/realtime/liveStore';
import {
  makeAlarm,
  makeAlarmEvent,
  makeEquipment,
  makeFleetSummary,
  makeOpcUa,
  makeReading,
  makeSystemStatus,
  makeVessel,
} from '@/test/fixtures';
import { installApi } from '@/test/mockApi';
import { FakeSocket, renderApp } from '@/test/render';

afterEach(() => {
  vi.restoreAllMocks();
});

const header = () => document.querySelector<HTMLElement>('header.shell__header')!;

describe('application shell', () => {
  it('has landmarks, a skip link and the permanent simulation indicator', async () => {
    installApi();
    renderApp({ route: '/' });
    await screen.findByRole('heading', { name: 'Fleet overview' });
    expect(screen.getByRole('link', { name: 'Skip to main content' })).toHaveAttribute(
      'href',
      '#main',
    );
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main');
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
    expect(screen.getByRole('contentinfo')).toHaveTextContent(
      /not affiliated with or endorsed by NACOS Marine/,
    );
    expect(within(header()).getByRole('note')).toHaveTextContent(
      'Simulated data — not a real vessel',
    );
  });

  it('shows fleet-wide alarm counters with icon-backed text labels linking to filtered lists', async () => {
    installApi({
      'GET /api/v1/fleet/summary': () =>
        makeFleetSummary({ open_alarms: { info: 0, warning: 2, critical: 5, unacknowledged: 6 } }),
    });
    renderApp({ route: '/about' });
    const counters = await within(header()).findByRole('navigation', { name: 'Open alarms' });
    const critical = within(counters).getByRole('link', { name: /Critical\s*5/ });
    expect(critical).toHaveAttribute('href', '/alarms?severity=critical');
    expect(within(counters).getByRole('link', { name: /Warning\s*2/ })).toBeInTheDocument();
    expect(within(counters).getByRole('link', { name: /Unacknowledged\s*6/ })).toBeInTheDocument();
  });

  it('shows the OPC UA source status and the live channel status as text chips', async () => {
    installApi({
      'GET /api/v1/system/status': () =>
        makeSystemStatus({ opcua: makeOpcUa({ state: 'disconnected' }) }),
    });
    renderApp({ route: '/about' });
    expect(await within(header()).findByText('Disconnected')).toBeInTheDocument();
    expect(within(header()).getByTestId('live-state')).toHaveTextContent('Connecting');
  });

  it('lists vessels in the navigation', async () => {
    installApi();
    renderApp({ route: '/about' });
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(await within(nav).findByRole('link', { name: /MV Aurora Tide/ })).toHaveAttribute(
      'href',
      '/vessels/VES-001',
    );
  });

  it('switches between UTC and local time and keeps the choice', async () => {
    installApi();
    const user = userEvent.setup();
    renderApp({ route: '/about' });
    const group = within(header()).getByRole('group', { name: 'Time zone' });
    expect(within(group).getByRole('button', { name: 'UTC' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.click(within(group).getByRole('button', { name: 'Local' }));
    expect(within(group).getByRole('button', { name: 'Local' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(window.localStorage.getItem('seatrace.settings')).toContain('"timeMode":"local"');
  });

  it('toggles the theme on the document and persists it', async () => {
    installApi();
    const user = userEvent.setup();
    renderApp({ route: '/about' });
    await user.click(
      within(header()).getByRole('button', { name: /Switch to (light|dark) theme/ }),
    );
    const theme = document.documentElement.getAttribute('data-theme');
    expect(['light', 'dark']).toContain(theme);
    expect(window.localStorage.getItem('seatrace.settings')).toContain(
      `"theme":"${String(theme)}"`,
    );
  });

  it('opens and closes the navigation drawer from the menu button', async () => {
    installApi();
    const user = userEvent.setup();
    renderApp({ route: '/about' });
    const menu = within(header()).getByRole('button', { name: 'Open navigation' });
    await user.click(menu);
    expect(within(header()).getByRole('button', { name: 'Close navigation' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(document.getElementById('primary-nav')).toHaveClass('is-open');
    await user.keyboard('{Escape}');
    expect(document.getElementById('primary-nav')).not.toHaveClass('is-open');
  });

  it('renders a 404 page for unknown routes', async () => {
    installApi();
    renderApp({ route: '/nope' });
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
  });

  it('about page carries the disclaimer', async () => {
    installApi();
    renderApp({ route: '/about' });
    expect(await screen.findByRole('heading', { name: 'About SeaTrace' })).toBeInTheDocument();
    expect(screen.getByText(/not certified maritime software/)).toBeInTheDocument();
    expect(screen.getAllByText(/NACOS Marine/).length).toBeGreaterThan(0);
  });
});

describe('connectivity banners', () => {
  it('shows the offline banner when the browser is offline', async () => {
    installApi();
    renderApp({ route: '/about' });
    await screen.findByRole('heading', { name: 'About SeaTrace' });
    act(() => {
      useLive.getState().setOnline(false);
    });
    expect(screen.getByText('You are offline.')).toBeInTheDocument();
    act(() => {
      useLive.getState().setOnline(true);
    });
    expect(screen.queryByText('You are offline.')).toBeNull();
  });

  it('shows "Live updates paused" while reconnecting and hides it once the channel is open', async () => {
    installApi();
    renderApp({ route: '/about' });
    await screen.findByRole('heading', { name: 'About SeaTrace' });
    expect(screen.queryByText(/Live updates paused/)).toBeNull(); // initial connect is not an outage
    const ws = FakeSocket.instances[0]!;
    act(() => {
      ws.open();
      ws.close(1006);
    });
    expect(
      await screen.findByText('Live updates paused — showing last known data; retrying…'),
    ).toBeInTheDocument();
    expect(within(header()).getByTestId('live-state')).toHaveTextContent('Reconnecting');
  });
});

describe('real-time updates reach the UI', () => {
  async function connect() {
    const ws = FakeSocket.instances[0]!;
    act(() => {
      ws.open();
      ws.receive({
        type: 'hello',
        protocol: 1,
        auth_timeout_s: 5,
        server_time: new Date().toISOString(),
      });
      ws.receive({
        type: 'ready',
        seq: 1,
        resync_required: false,
        user: { username: 'operator', role: 'operator' },
      });
    });
    await waitFor(() => {
      expect(useLive.getState().connection).toBe('open');
    });
    return ws;
  }

  it('authenticates with the session token over the same-origin websocket URL', async () => {
    installApi();
    renderApp({ route: '/about' });
    const ws = await connect();
    expect(ws.url).toMatch(/^ws:\/\/[^/]+\/api\/v1\/ws$/);
    expect(JSON.parse(ws.sent[0]!)).toEqual({
      type: 'auth',
      token: 'token-operator',
      resume_from: null,
    });
    expect(within(header()).getByTestId('live-state')).toHaveTextContent('Connected');
  });

  it('updates a vessel reading in place from a telemetry message', async () => {
    installApi({
      'GET /api/v1/vessels/VES-001': () =>
        makeVessel({ equipment: [makeEquipment({ readings: [makeReading({ value: 80 })] })] }),
      'GET /api/v1/telemetry/history': () => ({
        vessel_code: 'VES-001',
        equipment_code: 'ME1',
        from: '',
        to: '',
        bucket_s: null,
        units: {},
        items: [],
        buckets: [],
        next_cursor: null,
        truncated: false,
      }),
      'GET /api/v1/anomalies/VES-001': () => ({
        vessel_code: 'VES-001',
        equipment_code: 'ME1',
        status: 'normal',
        score: 0.1,
        explanation: 'ok',
        features: {},
        alarm_active: false,
        evaluated_at: new Date().toISOString(),
        disclaimer: 'd',
      }),
    });
    renderApp({ route: '/vessels/VES-001' });
    const reading = await screen.findByTestId('reading-temperature');
    expect(within(reading).getByTestId('reading-value')).toHaveTextContent('80');
    const ws = await connect();
    const nowIso = new Date().toISOString();
    act(() => {
      ws.receive({
        seq: 2,
        type: 'telemetry',
        ts: nowIso,
        data: {
          items: [
            {
              vessel_code: 'VES-001',
              equipment_code: 'ME1',
              measurement: 'temperature',
              unit: '°C',
              value: 93.4,
              quality: 'good',
              source_ts: nowIso,
              ingested_ts: nowIso,
            },
          ],
        },
      });
    });
    await waitFor(() => {
      expect(within(reading).getByTestId('reading-value')).toHaveTextContent('93.4');
    });
  });

  it('adds new alarms to the open list, highlights them and announces critical ones politely', async () => {
    let items = [makeAlarm({ id: 1, message: 'Older alarm' })];
    installApi({
      'GET /api/v1/alarms': () => ({ items, total: items.length, limit: 25, offset: 0 }),
    });
    renderApp({ route: '/alarms' });
    await screen.findByText('Older alarm');
    const ws = await connect();
    const fresh = makeAlarm({ id: 2, severity: 'critical', message: 'Very high temperature' });
    items = [fresh, ...items];
    act(() => {
      ws.receive({
        seq: 2,
        type: 'alarm',
        ts: new Date().toISOString(),
        data: {
          event: 'raised',
          alarm: fresh,
          alarm_event: makeAlarmEvent({ id: 5, alarm_id: 2 }),
        },
      });
    });
    const row = (await screen.findByText('Very high temperature')).closest('tr')!;
    expect(row).toHaveClass('is-flash');
    const announcer = screen.getAllByRole('status').find((el) => el.classList.contains('sr-only'))!;
    expect(announcer).toHaveAttribute('aria-live', 'polite');
    expect(announcer).toHaveTextContent(
      /Critical alarm raised on MV Aurora Tide Main engine: Very high temperature/,
    );
  });

  it('refetches everything when the server demands a resync', async () => {
    const api = installApi();
    renderApp({ route: '/about' });
    await screen.findByRole('heading', { name: 'About SeaTrace' });
    await waitFor(() => {
      expect(api.callsTo('GET', '/api/v1/fleet/summary').length).toBeGreaterThan(0);
    });
    const before = api.callsTo('GET', '/api/v1/fleet/summary').length;
    const ws = FakeSocket.instances[0]!;
    act(() => {
      ws.open();
      ws.receive({
        type: 'hello',
        protocol: 1,
        auth_timeout_s: 5,
        server_time: new Date().toISOString(),
      });
      ws.receive({
        type: 'ready',
        seq: 9,
        resync_required: true,
        user: { username: 'operator', role: 'operator' },
      });
    });
    await waitFor(() => {
      expect(api.callsTo('GET', '/api/v1/fleet/summary').length).toBeGreaterThan(before);
    });
  });

  it('signs the user out when the server closes the channel with 4401', async () => {
    installApi();
    renderApp({ route: '/about' });
    const ws = await connect();
    act(() => {
      ws.close(4401);
    });
    expect(await screen.findByLabelText('Username')).toBeInTheDocument();
    expect(screen.getByText(/no longer valid/i)).toBeInTheDocument();
  });

  it('computes the clock offset from server time so local ages are not skewed', async () => {
    installApi();
    renderApp({ route: '/about' });
    const ws = FakeSocket.instances[0]!;
    const skewed = new Date(Date.now() + 5000).toISOString();
    act(() => {
      ws.open();
      ws.receive({ type: 'hello', protocol: 1, auth_timeout_s: 5, server_time: skewed });
    });
    expect(useLive.getState().clockOffsetMs).toBeGreaterThan(4000);
    expect(useLive.getState().clockOffsetMs).toBeLessThan(6000);
  });
});
