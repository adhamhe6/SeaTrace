import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { ScenarioResult } from '@/api/types';
import { iso, makeOpcUa, makeScenario, makeSimStatus, makeSystemStatus } from '@/test/fixtures';
import { apiError, installApi } from '@/test/mockApi';
import { renderApp } from '@/test/render';

const main = () => screen.getByRole('main');
const ok = (message: string): ScenarioResult => ({
  accepted: true,
  message,
  simulator: makeSimStatus(),
});

const scenarios = [
  makeScenario(),
  makeScenario({
    id: 'sensor_stuck',
    name: 'Stuck sensor',
    category: 'sensor',
    target: 'ME1 temperature sensor',
    expected_alarms: ['SENSOR_QUALITY'],
  }),
  makeScenario({
    id: 'opcua_outage',
    name: 'OPC UA server outage',
    category: 'communication',
    scope: 'server',
    default_duration_s: 20,
    max_duration_s: 120,
    expected_alarms: ['SOURCE_COMM_LOSS'],
  }),
];

const base = { 'GET /api/v1/simulator/scenarios': () => scenarios };

async function card(name: string) {
  const heading = await within(main()).findByRole('heading', { name, level: 3 });
  return within(heading.closest('section')!);
}

describe('Simulator controls', () => {
  it('identifies itself as a simulation and groups scenarios by category with their metadata', async () => {
    installApi(base);
    renderApp({ route: '/simulator' });
    expect(await within(main()).findByText(/^SIMULATION/)).toBeInTheDocument();
    expect(
      await within(main()).findByRole('heading', { name: 'Equipment faults' }),
    ).toBeInTheDocument();
    expect(within(main()).getByRole('heading', { name: 'Sensor faults' })).toBeInTheDocument();
    expect(
      within(main()).getByRole('heading', { name: 'Communication faults' }),
    ).toBeInTheDocument();
    const c = await card('Engine overheating');
    expect(c.getByText('Main engine ME1', { exact: false })).toBeInTheDocument();
    expect(c.getByText('ME_TEMP_HIGH')).toBeInTheDocument();
    expect(c.getByText('Cooling effectiveness degrades gradually.')).toBeInTheDocument();
    const server = await card('OPC UA server outage');
    expect(server.getByText('Server-wide')).toBeInTheDocument();
    expect(server.queryByLabelText('Vessel')).toBeNull();
  });

  it('shows the OPC UA connection details and ingestion stats from the API', async () => {
    installApi({
      ...base,
      'GET /api/v1/system/status': () =>
        makeSystemStatus({
          opcua: makeOpcUa({
            state: 'backoff',
            reconnect_attempts: 4,
            last_error: 'timeout',
            security: 'none',
          }),
        }),
      'GET /api/v1/simulator/status': () =>
        makeSimStatus({ connected: false, heartbeat_age_s: 12.5 }),
    });
    renderApp({ route: '/simulator' });
    await within(main()).findByText('backoff');
    const panel = within(main())
      .getByRole('heading', { name: 'OPC UA connection' })
      .closest('section')!;
    expect(within(panel).getByText('opc.tcp://sim:4840/seatrace/simulator')).toBeInTheDocument();
    expect(within(panel).getByText('None')).toBeInTheDocument(); // security mode
    expect(within(panel).getByText('4')).toBeInTheDocument(); // reconnect attempts
    expect(within(panel).getByText(/changed 12.5 s ago/)).toBeInTheDocument();
    expect(within(panel).getByText('timeout')).toBeInTheDocument();
    expect(within(panel).getByText('1000 / 990')).toBeInTheDocument();
    expect(await within(main()).findByText('Simulator not connected.')).toBeInTheDocument();
  });

  it('activates a scenario for the chosen vessel with an optional duration and reports success inline and as a toast', async () => {
    const api = installApi({
      ...base,
      'POST /api/v1/simulator/scenarios/engine_overheat/activate': () =>
        ok("scenario 'engine_overheat' activated on vessel 'VES-002'"),
    });
    const user = userEvent.setup();
    renderApp({ route: '/simulator' });
    const c = await card('Engine overheating');
    await waitFor(() => {
      expect(c.getByRole('option', { name: /VES-002/ })).toBeInTheDocument();
    });
    await user.selectOptions(c.getByLabelText('Vessel'), 'VES-002');
    await user.type(c.getByLabelText(/Duration/), '120');
    await user.click(c.getByRole('button', { name: 'Activate Engine overheating' }));
    expect(await c.findByText(/activated on vessel 'VES-002'/)).toBeInTheDocument();
    expect(
      api.lastCall('POST', '/api/v1/simulator/scenarios/engine_overheat/activate')?.body,
    ).toEqual({
      vessel_code: 'VES-002',
      duration_s: 120,
    });
    expect(
      await screen.findByText('Engine overheating activated on VES-002', {
        selector: '.st-toast__title',
      }),
    ).toBeInTheDocument();
  });

  it('omits the duration when left empty and defaults to the first vessel', async () => {
    const api = installApi({
      ...base,
      'POST /api/v1/simulator/scenarios/sensor_stuck/activate': () => ok('ok'),
    });
    const user = userEvent.setup();
    renderApp({ route: '/simulator' });
    const c = await card('Stuck sensor');
    await waitFor(() => {
      expect(c.getByRole('option', { name: /VES-001/ })).toBeInTheDocument();
    });
    await user.click(c.getByRole('button', { name: 'Activate Stuck sensor' }));
    await waitFor(() => {
      expect(
        api.lastCall('POST', '/api/v1/simulator/scenarios/sensor_stuck/activate')?.body,
      ).toEqual({ vessel_code: 'VES-001', duration_s: null });
    });
  });

  it('clears a scenario', async () => {
    const api = installApi({
      ...base,
      'POST /api/v1/simulator/scenarios/engine_overheat/clear': () => ok('cleared'),
    });
    const user = userEvent.setup();
    renderApp({ route: '/simulator' });
    const c = await card('Engine overheating');
    await waitFor(() => {
      expect(c.getByRole('option', { name: /VES-001/ })).toBeInTheDocument();
    });
    await user.click(c.getByRole('button', { name: 'Clear Engine overheating' }));
    expect(await c.findByText(/Scenario cleared on VES-001/)).toBeInTheDocument();
    expect(api.lastCall('POST', '/api/v1/simulator/scenarios/engine_overheat/clear')?.body).toEqual(
      { vessel_code: 'VES-001' },
    );
  });

  it('sends no vessel for server-scope scenarios', async () => {
    const api = installApi({
      ...base,
      'POST /api/v1/simulator/scenarios/opcua_outage/activate': () => ok('ok'),
    });
    const user = userEvent.setup();
    renderApp({ route: '/simulator' });
    const c = await card('OPC UA server outage');
    await user.click(c.getByRole('button', { name: 'Activate OPC UA server outage' }));
    await waitFor(() => {
      expect(
        api.lastCall('POST', '/api/v1/simulator/scenarios/opcua_outage/activate')?.body,
      ).toEqual({ vessel_code: null, duration_s: null });
    });
  });

  it.each([
    [503, 'simulator_unavailable', 'x', /cannot reach the simulator over OPC UA/],
    [
      409,
      'scenario_rejected',
      "scenario 'engine_overheat' is already active",
      /Command rejected by the simulator\.\s+scenario 'engine_overheat' is already active/,
    ],
    [
      422,
      'invalid_duration',
      'duration_s must be <= 3600',
      /Invalid duration\.\s+duration_s must be <= 3600/,
    ],
  ])(
    'maps backend error %s %s to a clear inline message',
    async (status, code, message, expected) => {
      installApi({
        ...base,
        'POST /api/v1/simulator/scenarios/engine_overheat/activate': () =>
          apiError(status, code, message),
      });
      const user = userEvent.setup();
      renderApp({ route: '/simulator' });
      const c = await card('Engine overheating');
      await waitFor(() => {
        expect(c.getByRole('option', { name: /VES-001/ })).toBeInTheDocument();
      });
      await user.click(c.getByRole('button', { name: 'Activate Engine overheating' }));
      expect(await c.findByRole('alert')).toHaveTextContent(expected);
    },
  );

  it('validates the duration client-side against the scenario maximum', async () => {
    const api = installApi(base);
    const user = userEvent.setup();
    renderApp({ route: '/simulator' });
    const c = await card('OPC UA server outage');
    await user.type(c.getByLabelText(/Duration/), '999');
    expect(c.getByText(/At most 120 s/)).toBeInTheDocument();
    expect(c.getByRole('button', { name: 'Activate OPC UA server outage' })).toBeDisabled();
    expect(api.callsTo('POST', '/api/v1/simulator/scenarios/opcua_outage/activate')).toHaveLength(
      0,
    );
  });

  it('disables the buttons while a command is pending (no double submit)', async () => {
    let release: () => void = () => undefined;
    const api = installApi({
      ...base,
      'POST /api/v1/simulator/scenarios/engine_overheat/activate': () =>
        new Promise((resolve) => {
          release = () => {
            resolve(ok('done'));
          };
        }),
    });
    const user = userEvent.setup();
    renderApp({ route: '/simulator' });
    const c = await card('Engine overheating');
    await waitFor(() => {
      expect(c.getByRole('option', { name: /VES-001/ })).toBeInTheDocument();
    });
    const activate = c.getByRole('button', { name: 'Activate Engine overheating' });
    await user.click(activate);
    await waitFor(() => {
      expect(activate).toBeDisabled();
    });
    expect(c.getByRole('button', { name: 'Clear Engine overheating' })).toBeDisabled();
    await user.click(activate);
    expect(
      api.callsTo('POST', '/api/v1/simulator/scenarios/engine_overheat/activate'),
    ).toHaveLength(1);
    release();
    await c.findByText(/Scenario activated/);
    expect(activate).toBeEnabled();
  });

  it('lists active scenarios from the simulator status and clears them from there', async () => {
    const api = installApi({
      ...base,
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
      'POST /api/v1/simulator/scenarios/engine_overheat/clear': () => ok('cleared'),
    });
    const user = userEvent.setup();
    renderApp({ route: '/simulator' });
    const list = await within(main()).findByRole('list', { name: 'Active scenarios' });
    expect(within(list).getByText('Engine overheating')).toBeInTheDocument();
    await user.click(
      within(list).getByRole('button', { name: 'Clear Engine overheating on VES-001' }),
    );
    await waitFor(() => {
      expect(
        api.lastCall('POST', '/api/v1/simulator/scenarios/engine_overheat/clear')?.body,
      ).toEqual({ vessel_code: 'VES-001' });
    });
  });

  it('resets all scenarios only after confirmation', async () => {
    const api = installApi({
      ...base,
      'POST /api/v1/simulator/reset': () => ok('all scenarios cleared'),
    });
    const user = userEvent.setup();
    renderApp({ route: '/simulator' });
    await user.click(await within(main()).findByRole('button', { name: 'Reset all scenarios' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reset all scenarios?' });
    expect(api.callsTo('POST', '/api/v1/simulator/reset')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.callsTo('POST', '/api/v1/simulator/reset')).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Reset all scenarios' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Reset all' }),
    );
    expect(
      await screen.findByText('All scenarios cleared', { selector: '.st-toast__title' }),
    ).toBeInTheDocument();
    expect(api.callsTo('POST', '/api/v1/simulator/reset')).toHaveLength(1);
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('keeps the reset dialog open and explains a failure', async () => {
    installApi({
      ...base,
      'POST /api/v1/simulator/reset': () => apiError(503, 'simulator_unavailable', 'down'),
    });
    const user = userEvent.setup();
    renderApp({ route: '/simulator' });
    await user.click(await within(main()).findByRole('button', { name: 'Reset all scenarios' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Reset all' }));
    expect(await within(dialog).findByText('Simulator unavailable')).toBeInTheDocument();
  });

  it('shows the audit trail of recent commands', async () => {
    installApi({
      ...base,
      'GET /api/v1/simulator/events': () => [
        {
          id: 2,
          at: iso(10),
          actor: 'operator',
          action: 'activate',
          scenario_id: 'engine_overheat',
          vessel_code: 'VES-001',
          params: null,
          result: 'accepted',
          message: 'activated',
        },
        {
          id: 1,
          at: iso(0),
          actor: 'operator',
          action: 'clear',
          scenario_id: 'sensor_stuck',
          vessel_code: 'VES-001',
          params: null,
          result: 'failed',
          message: 'unreachable',
        },
      ],
    });
    renderApp({ route: '/simulator' });
    await within(main()).findByText('accepted');
    const table = within(main()).getByRole('table', { name: 'Simulator command audit' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(within(rows[1]!).getByText('accepted')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('failed')).toBeInTheDocument();
  });

  describe('viewer role', () => {
    it('shows every operator-only control as unavailable with an explanation and never sends a command', async () => {
      const api = installApi(base);
      const user = userEvent.setup();
      renderApp({ route: '/simulator', role: 'viewer' });
      const c = await card('Engine overheating');
      expect(within(main()).getByText('Read-only access.')).toBeInTheDocument();
      for (const button of [
        c.getByRole('button', { name: 'Activate Engine overheating' }),
        c.getByRole('button', { name: 'Clear Engine overheating' }),
        within(main()).getByRole('button', { name: 'Reset all scenarios' }),
      ]) {
        expect(button).toHaveAttribute('aria-disabled', 'true');
        await user.click(button);
      }
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(api.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
      const activate = c.getByRole('button', { name: 'Activate Engine overheating' });
      await user.hover(activate);
      expect(await within(activate.closest('.st-tip')!).findByRole('tooltip')).toHaveTextContent(
        'Operator role required',
      );
    });
  });
});
