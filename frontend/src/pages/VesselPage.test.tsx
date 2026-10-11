import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { HistoryResponse } from '@/api/types';
import {
  iso,
  makeAlarm,
  makeAnomaly,
  makeEquipment,
  makeReading,
  makeSystemStatus,
  makeVessel,
} from '@/test/fixtures';
import { apiError, installApi } from '@/test/mockApi';
import { renderApp } from '@/test/render';

const history = (over: Partial<HistoryResponse> = {}): HistoryResponse => ({
  vessel_code: 'VES-001',
  equipment_code: 'ME1',
  from: iso(0),
  to: iso(900),
  bucket_s: null,
  units: { temperature: '°C', rpm: 'rpm' },
  items: [
    { ts: iso(1), measurement: 'temperature', value: 80, quality: 'good' },
    { ts: iso(2), measurement: 'temperature', value: 81, quality: 'good' },
  ],
  buckets: [],
  next_cursor: null,
  truncated: false,
  ...over,
});

const routes = (vesselOver = {}) => ({
  'GET /api/v1/vessels/VES-001': () => makeVessel(vesselOver),
  'GET /api/v1/telemetry/history': () => history(),
  'GET /api/v1/anomalies/VES-001': () => makeAnomaly(),
});

describe('Vessel details', () => {
  it('shows identification and every equipment panel with state, health and readings', async () => {
    installApi(routes());
    renderApp({ route: '/vessels/VES-001' });
    expect(await screen.findByRole('heading', { name: 'MV Aurora Tide' })).toBeInTheDocument();
    const inventory = screen.getByLabelText('Equipment inventory');
    const me = within(inventory)
      .getByRole('heading', { name: /Main engine/ })
      .closest('section')!;
    expect(within(me).getByText('RUNNING')).toBeInTheDocument();
    expect(within(me).getByText('Normal')).toBeInTheDocument();
    const temp = within(me).getByTestId('reading-temperature');
    expect(within(temp).getByTestId('reading-value')).toHaveTextContent('82.5');
    expect(temp).toHaveTextContent('°C');
    expect(within(temp).getByText('Good')).toBeInTheDocument();
    expect(
      within(temp).getByRole('img', { name: /Within nominal range 78 to 88 °C/ }),
    ).toBeInTheDocument();
    expect(within(inventory).getByRole('heading', { name: /Generator 1/ })).toBeInTheDocument();
  });

  it('shows quality as text for bad, invalid and stuck readings and flags out-of-range values', async () => {
    installApi(
      routes({
        equipment: [
          makeEquipment({
            readings: [
              makeReading({ measurement: 'temperature', quality: 'bad', value: 0 }),
              makeReading({
                measurement: 'rpm',
                name: 'Engine speed',
                unit: 'rpm',
                quality: 'invalid',
                value: 400,
              }),
              makeReading({
                measurement: 'load',
                name: 'Engine load',
                unit: '%',
                quality: 'stuck',
                value: 70,
              }),
              makeReading({
                measurement: 'vibration',
                name: 'Engine vibration',
                unit: 'mm/s',
                quality: 'good',
                value: 9,
                nominal_min: 2,
                nominal_max: 4,
              }),
            ],
          }),
        ],
      }),
    );
    renderApp({ route: '/vessels/VES-001' });
    await screen.findByRole('heading', { name: 'MV Aurora Tide' });
    expect(screen.getByText('Bad')).toBeInTheDocument();
    expect(screen.getByText('Invalid')).toBeInTheDocument();
    expect(screen.getByText('Stuck')).toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: /Above nominal range 2 to 4 mm\/s/ }),
    ).toBeInTheDocument();
  });

  it('marks a reading stale locally from ingested_ts even if the server flag is false', async () => {
    const old = new Date(Date.now() - 60_000).toISOString();
    installApi({
      ...routes({
        equipment: [
          makeEquipment({
            readings: [
              makeReading({
                ingested_ts: old,
                source_ts: old,
                stale: false,
                age_s: 1,
                quality: 'good',
              }),
            ],
          }),
        ],
      }),
      'GET /api/v1/system/status': () => makeSystemStatus({ stale_after_s: 10 }),
    });
    renderApp({ route: '/vessels/VES-001' });
    const row = await screen.findByTestId('reading-temperature');
    // wait for system status (stale_after_s) to arrive
    expect(await within(row).findByText('Stale')).toBeInTheDocument();
    expect(within(row).getByTestId('reading-age')).toHaveTextContent(/1 min/);
  });

  it('shows "no sample yet" for sensors that never reported', async () => {
    installApi(
      routes({
        equipment: [
          makeEquipment({
            readings: [
              makeReading({
                value: null,
                quality: 'stale',
                source_ts: null,
                ingested_ts: null,
                age_s: null,
                stale: true,
              }),
            ],
          }),
        ],
      }),
    );
    renderApp({ route: '/vessels/VES-001' });
    expect(await screen.findByText('No sample received yet')).toBeInTheDocument();
    expect(screen.getByTestId('reading-value')).toHaveTextContent('—');
  });

  it('lists equipment-specific alarms with a replay link', async () => {
    const api = installApi({
      ...routes(),
      'GET /api/v1/alarms': ({ url }) => ({
        items:
          url.searchParams.get('open') === 'true'
            ? [makeAlarm({ id: 42, message: 'Engine temperature above limit' })]
            : [],
        total: 1,
        limit: 20,
        offset: 0,
      }),
    });
    renderApp({ route: '/vessels/VES-001' });
    const link = await screen.findByRole('link', { name: 'Investigate alarm 42 in replay' });
    expect(link).toHaveAttribute('href', '/replay?alarm=42');
    const openCall = api
      .callsTo('GET', '/api/v1/alarms')
      .find((c) => c.query.get('open') === 'true');
    expect(openCall?.query.get('vessel')).toBe('VES-001');
    expect(openCall?.query.get('equipment')).toBe('ME1');
  });

  it('requests raw history for 15 minutes and buckets for 60 minutes', async () => {
    const api = installApi(routes());
    const user = userEvent.setup();
    renderApp({ route: '/vessels/VES-001' });
    await screen.findByRole('heading', { name: 'Trends' });
    await screen.findAllByRole('img', { name: /Engine temperature \(°C\), last 15 minutes/ });
    const first = api.callsTo('GET', '/api/v1/telemetry/history')[0]!;
    expect(first.query.get('bucket_s')).toBeNull();
    expect(first.query.get('equipment')).toBe('ME1');
    await user.click(screen.getByRole('button', { name: '60 min' }));
    await screen.findAllByRole('img', { name: /last 60 minutes/ });
    const bucketed = api
      .callsTo('GET', '/api/v1/telemetry/history')
      .find((c) => c.query.get('bucket_s'));
    expect(bucketed?.query.get('bucket_s')).toBe('30');
  });

  it('switches the trends to another equipment item with the keyboard', async () => {
    const api = installApi(routes());
    const user = userEvent.setup();
    renderApp({ route: '/vessels/VES-001' });
    const tab = await screen.findByRole('tab', { name: /Main engine/ });
    tab.focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: /Generator 1/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await screen.findAllByRole('img', { name: /Frequency/ });
    expect(
      api
        .callsTo('GET', '/api/v1/telemetry/history')
        .some((c) => c.query.get('equipment') === 'GEN1'),
    ).toBe(true);
  });

  it('shows a clear not-found state for an unknown vessel', async () => {
    installApi({
      'GET /api/v1/vessels/NOPE': () => apiError(404, 'not_found', "Vessel 'NOPE' was not found"),
    });
    renderApp({ route: '/vessels/NOPE' });
    expect(await screen.findByText('Vessel NOPE was not found')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to fleet overview' })).toBeInTheDocument();
  });
});

describe('Anomaly insight panel', () => {
  it('shows status, score meter, explanation, features and the disclaimer', async () => {
    installApi(routes());
    renderApp({ route: '/vessels/VES-001' });
    const panel = (
      await screen.findByRole('heading', { name: /Anomaly insight \(experimental\)/ })
    ).closest('section')!;
    expect(await within(panel).findByText('Watch')).toBeInTheDocument();
    expect(within(panel).getByRole('meter', { name: 'Anomaly score' })).toHaveAttribute(
      'aria-valuenow',
      '0.64',
    );
    expect(within(panel).getByTestId('anomaly-score')).toHaveTextContent('0.64');
    expect(within(panel).getByTestId('anomaly-explanation')).toHaveTextContent(/robust sigma/);
    const table = within(panel).getByRole('table', { name: 'Anomaly features' });
    expect(within(table).getByText('Vibration deviation (robust sigma)')).toBeInTheDocument();
    expect(within(table).getByText('1.67')).toBeInTheDocument();
    expect(within(table).getAllByText('—').length).toBe(1); // null feature value
    expect(within(panel).getByText(/Experimental statistical heuristic/)).toBeInTheDocument();
  });

  it('explains insufficient data without a misleading score', async () => {
    installApi({
      ...routes(),
      'GET /api/v1/anomalies/VES-001': () =>
        makeAnomaly({
          status: 'insufficient_data',
          score: 0,
          explanation: 'Only 3 samples.',
          features: {},
        }),
    });
    renderApp({ route: '/vessels/VES-001' });
    const panel = (await screen.findByRole('heading', { name: /Anomaly insight/ })).closest(
      'section',
    )!;
    expect(await within(panel).findByText('Insufficient data')).toBeInTheDocument();
    expect(within(panel).getByText(/Not enough recent telemetry/)).toBeInTheDocument();
    expect(within(panel).queryByRole('meter')).toBeNull();
  });

  it('flags when an alarm is already active and handles load errors', async () => {
    installApi({
      ...routes(),
      'GET /api/v1/anomalies/VES-001': () => makeAnomaly({ status: 'anomaly', alarm_active: true }),
    });
    renderApp({ route: '/vessels/VES-001' });
    const panel = (await screen.findByRole('heading', { name: /Anomaly insight/ })).closest(
      'section',
    )!;
    expect(await within(panel).findByText('Anomaly')).toBeInTheDocument();
    expect(within(panel).getByText('Alarm already active')).toBeInTheDocument();
  });

  it('shows an error state with retry', async () => {
    installApi({
      ...routes(),
      'GET /api/v1/anomalies/VES-001': () => apiError(500, 'internal_error', 'boom'),
    });
    renderApp({ route: '/vessels/VES-001' });
    const panel = (await screen.findByRole('heading', { name: /Anomaly insight/ })).closest(
      'section',
    )!;
    expect(
      await within(panel).findByText('Could not load the anomaly assessment'),
    ).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
