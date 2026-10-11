import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  iso,
  makeFleetSummary,
  makeRecentEvent,
  makeSimStatus,
  makeVesselSummary,
} from '@/test/fixtures';
import { apiError, installApi } from '@/test/mockApi';
import { renderApp } from '@/test/render';

const main = () => screen.getByRole('main');

describe('Fleet overview', () => {
  it('shows a loading state before data arrives', () => {
    installApi({ 'GET /api/v1/fleet/summary': () => new Promise<never>(() => undefined) });
    renderApp({ route: '/' });
    expect(screen.getByRole('heading', { name: 'Fleet overview' })).toBeInTheDocument();
    expect(within(main()).getByRole('table', { name: 'Vessel inventory' })).toHaveAttribute(
      'aria-busy',
      'true',
    );
  });

  it('renders vessels, alarm counts, equipment condition and communication from the API', async () => {
    installApi({
      'GET /api/v1/vessels': () => [
        makeVesselSummary({
          health: 'critical',
          open_alarms: { info: 0, warning: 1, critical: 2, unacknowledged: 3 },
          equipment_count: 4,
        }),
        makeVesselSummary({
          id: 2,
          code: 'VES-002',
          name: 'MV Baltic Meridian',
          communication: 'offline',
          health: 'offline',
        }),
      ],
      'GET /api/v1/fleet/summary': () =>
        makeFleetSummary({
          vessels_by_health: { normal: 0, warning: 0, critical: 1, offline: 1 },
          equipment_by_health: { normal: 5, warning: 1, critical: 1, offline: 1 },
          communication: { online: 1, degraded: 0, offline: 1 },
          open_alarms: { info: 1, warning: 2, critical: 3, unacknowledged: 4 },
        }),
      'GET /api/v1/events/recent': () => [
        makeRecentEvent({
          id: 'e1',
          message: 'Alarm raised: Engine temperature above limit',
          alarm_id: 7,
        }),
      ],
    });
    renderApp({ route: '/' });

    await within(main()).findByRole('link', { name: 'MV Aurora Tide' });
    const table = within(main()).getByRole('table', { name: 'Vessel inventory' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3); // header + 2 vessels
    expect(within(rows[1]!).getByRole('link', { name: 'MV Aurora Tide' })).toHaveAttribute(
      'href',
      '/vessels/VES-001',
    );
    expect(within(rows[1]!).getByText('2 Critical')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('3 unack.')).toBeInTheDocument();
    expect(within(rows[2]!).getAllByText('Offline')).toHaveLength(2); // health and communication, each with a text label

    // Fleet banner, with text as well as colour
    expect(await within(main()).findByText(/Fleet status: Critical/)).toBeInTheDocument();
    // Alarm card
    const alarmCard = within(main())
      .getByRole('heading', { name: 'Open alarms' })
      .closest('section')!;
    expect(within(alarmCard).getByText('6')).toBeInTheDocument(); // 1 + 2 + 3
    expect(within(alarmCard).getByText('4 unacknowledged')).toBeInTheDocument();
    expect(within(alarmCard).getByText('3 Critical')).toBeInTheDocument();
    // Equipment health & communication
    const equipmentCard = within(main())
      .getByRole('heading', { name: 'Equipment condition' })
      .closest('section')!;
    expect(within(equipmentCard).getByText('5 Normal')).toBeInTheDocument();
    expect(within(equipmentCard).getByText('1 Offline')).toBeInTheDocument();
    expect(within(main()).getByTestId('fleet-opcua')).toHaveTextContent('connected');
    // Events feed links to the alarm
    expect(within(main()).getByRole('link', { name: 'Alarm #7' })).toHaveAttribute(
      'href',
      '/alarms/7',
    );
  });

  it('announces active scenarios', async () => {
    installApi({
      'GET /api/v1/fleet/summary': () => makeFleetSummary({ active_scenarios: 1 }),
      'GET /api/v1/simulator/status': () =>
        makeSimStatus({
          active_scenarios: [
            {
              scenario_id: 'engine_overheat',
              vessel_code: 'VES-001',
              started_at: iso(0),
              ends_at: null,
            },
          ],
        }),
    });
    renderApp({ route: '/' });
    expect(await within(main()).findByText(/Fault scenarios are active/)).toBeInTheDocument();
    expect(await within(main()).findByText(/Engine overheat on VES-001/)).toBeInTheDocument();
  });

  it('shows an empty state for an empty fleet and no events', async () => {
    installApi({
      'GET /api/v1/vessels': () => [],
      'GET /api/v1/events/recent': () => [],
      'GET /api/v1/fleet/summary': () =>
        makeFleetSummary({ vessels_total: 0, vessels_by_health: {} }),
    });
    renderApp({ route: '/' });
    expect(await within(main()).findByText('No vessels configured')).toBeInTheDocument();
    expect(within(main()).getByText('No events yet')).toBeInTheDocument();
  });

  it('shows a retryable error when the backend fails', async () => {
    let fail = true;
    installApi({
      'GET /api/v1/fleet/summary': () =>
        fail
          ? apiError(503, 'database_unavailable', 'The database is temporarily unavailable')
          : makeFleetSummary(),
    });
    renderApp({ route: '/' });
    const alert = await within(main()).findByRole('alert');
    expect(alert).toHaveTextContent('Could not load fleet status');
    expect(alert).toHaveTextContent('The database is temporarily unavailable');
    expect(alert).toHaveTextContent('Request ID req-test');
    fail = false;
    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await within(main()).findByText(/Fleet status/)).toBeInTheDocument();
  });

  it('reports a source outage and warns that values may be out of date', async () => {
    installApi({
      'GET /api/v1/fleet/summary': () =>
        makeFleetSummary({
          opcua_state: 'disconnected',
          vessels_by_health: { offline: 2 },
          communication: { online: 0, degraded: 0, offline: 2 },
        }),
    });
    renderApp({ route: '/' });
    expect(await within(main()).findByText(/Fleet status: Telemetry offline/)).toBeInTheDocument();
    expect(within(main()).getByText(/Values shown may be out of date/)).toBeInTheDocument();
  });
});
