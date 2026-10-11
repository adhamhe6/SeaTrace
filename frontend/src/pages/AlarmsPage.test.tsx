import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { AlarmOut } from '@/api/types';
import { iso, makeAlarm, makeAlarmDetail, makeAlarmEvent } from '@/test/fixtures';
import { apiError, installApi } from '@/test/mockApi';
import { renderApp } from '@/test/render';

const list =
  (items: AlarmOut[], total = items.length) =>
  () => ({ items, total, limit: 25, offset: 0 });
const main = () => screen.getByRole('main');

const unack = makeAlarm({ id: 7 });
const acked = makeAlarm({
  id: 8,
  state: 'active_acknowledged',
  acknowledged: true,
  acknowledged_by: 'operator',
  acknowledged_at: iso(40),
  severity: 'critical',
  message: 'Vibration above limit',
});
const clearedUnack = makeAlarm({
  id: 9,
  state: 'cleared_unacknowledged',
  condition_active: false,
  cleared_at: iso(60),
  message: 'Bilge level high',
  occurrence_count: 3,
});

describe('Alarm center rendering', () => {
  it('renders severity, state, condition indicator, acknowledgement and counts for each row', async () => {
    installApi({ 'GET /api/v1/alarms': list([unack, acked, clearedUnack]) });
    renderApp({ route: '/alarms' });
    const table = await within(main()).findByRole('table', { name: /Open alarms/ });
    await within(table).findByText('Vibration above limit');
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(4);
    const r7 = rows[1]!;
    expect(within(r7).getByText('Warning')).toBeInTheDocument();
    expect(within(r7).getByText('Active - unacknowledged')).toBeInTheDocument();
    expect(within(r7).getByText('Condition: active')).toBeInTheDocument();
    expect(within(r7).getByRole('button', { name: 'Acknowledge alarm 7' })).toBeEnabled();
    const r8 = rows[2]!;
    expect(within(r8).getByText('Critical')).toBeInTheDocument();
    expect(within(r8).getByText('operator')).toBeInTheDocument();
    expect(within(r8).queryByRole('button', { name: /Acknowledge alarm/ })).toBeNull();
    const r9 = rows[3]!;
    expect(within(r9).getByText('Condition: returned to normal')).toBeInTheDocument();
    expect(within(r9).getByText('Cleared - unacknowledged')).toBeInTheDocument();
    expect(within(r9).getByRole('button', { name: 'Acknowledge alarm 9' })).toBeInTheDocument();
    expect(within(r9).getByText('3')).toBeInTheDocument();
    expect(within(r7).getByRole('link', { name: 'Details of alarm 7' })).toHaveAttribute(
      'href',
      '/alarms/7',
    );
  });

  it('shows an empty state and an error state', async () => {
    installApi({ 'GET /api/v1/alarms': list([]) });
    const first = renderApp({ route: '/alarms' });
    expect(await within(main()).findByText('No open alarms match')).toBeInTheDocument();
    expect(within(main()).getByText('Nothing needs attention right now.')).toBeInTheDocument();
    first.unmount();

    installApi({
      'GET /api/v1/alarms': () => apiError(500, 'internal_error', 'An internal error occurred'),
    });
    renderApp({ route: '/alarms' });
    expect(await within(main()).findByText('Could not load alarms')).toBeInTheDocument();
  });
});

describe('Alarm center filters change the API query and the URL', () => {
  it('requests open=true for Open and open=false for History', async () => {
    const api = installApi({ 'GET /api/v1/alarms': list([unack]) });
    const user = userEvent.setup();
    renderApp({ route: '/alarms' });
    await within(main()).findByText(unack.message);
    expect(api.lastCall('GET', '/api/v1/alarms')?.query.get('open')).toBe('true');
    await user.click(screen.getByRole('tab', { name: /History/ }));
    await waitFor(() => {
      expect(api.lastCall('GET', '/api/v1/alarms')?.query.get('open')).toBe('false');
    });
    expect(screen.getByRole('tab', { name: /History/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('applies severity, vessel, equipment, kind and time filters to the request', async () => {
    const api = installApi({ 'GET /api/v1/alarms': list([unack]) });
    const user = userEvent.setup();
    renderApp({ route: '/alarms' });
    await within(main()).findByText(unack.message);

    await user.click(within(main()).getByRole('button', { name: 'Critical' }));
    await user.click(within(main()).getByRole('button', { name: 'Warning' }));
    await waitFor(() => {
      expect(api.lastCall('GET', '/api/v1/alarms')?.query.getAll('severity')).toEqual([
        'critical',
        'warning',
      ]);
    });

    await user.selectOptions(within(main()).getByLabelText('Vessel'), 'VES-002');
    await waitFor(() => {
      expect(api.lastCall('GET', '/api/v1/alarms')?.query.get('vessel')).toBe('VES-002');
    });
    const equipment = within(main()).getByLabelText('Equipment');
    await waitFor(() => {
      expect(within(equipment).getByRole('option', { name: 'ME1' })).toBeInTheDocument();
    });
    await user.selectOptions(equipment, 'ME1');
    await user.selectOptions(within(main()).getByLabelText('Kind'), 'data_quality');
    fireEvent.change(within(main()).getByLabelText('Raised from (UTC)'), {
      target: { value: '2026-03-01T10:00:00' },
    });
    await waitFor(() => {
      const q = api.lastCall('GET', '/api/v1/alarms')!.query;
      expect(q.get('equipment')).toBe('ME1');
      expect(q.get('kind')).toBe('data_quality');
      expect(q.get('from')).toBe('2026-03-01T10:00:00.000Z');
      expect(q.get('open')).toBe('true');
    });
  });

  it('is driven by the URL (deep links) and clearing filters resets the query', async () => {
    const api = installApi({ 'GET /api/v1/alarms': list([unack]) });
    const user = userEvent.setup();
    renderApp({ route: '/alarms?tab=history&severity=critical&vessel=VES-001&state=cleared' });
    await within(main()).findByText(unack.message);
    const q = api.lastCall('GET', '/api/v1/alarms')!.query;
    expect(q.get('open')).toBe('false');
    expect(q.getAll('severity')).toEqual(['critical']);
    expect(q.get('vessel')).toBe('VES-001');
    expect(within(main()).getByRole('button', { name: 'Critical' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.click(within(main()).getAllByRole('button', { name: 'Clear filters' })[0]!);
    await waitFor(() => {
      const next = api.lastCall('GET', '/api/v1/alarms')!.query;
      expect(next.getAll('severity')).toEqual([]);
      expect(next.get('vessel')).toBeNull();
    });
  });

  it('paginates with limit/offset and shows the total', async () => {
    const api = installApi({
      'GET /api/v1/alarms': ({ url }) => ({
        items: [unack],
        total: 60,
        limit: Number(url.searchParams.get('limit')),
        offset: Number(url.searchParams.get('offset')),
      }),
    });
    const user = userEvent.setup();
    renderApp({ route: '/alarms' });
    expect(await within(main()).findByText('Page 1 of 3')).toBeInTheDocument();
    expect(within(main()).getByText(/Showing/)).toHaveTextContent('Showing 1–25 of 60');
    await user.click(within(main()).getByRole('button', { name: 'Next' }));
    expect(await within(main()).findByText('Page 2 of 3')).toBeInTheDocument();
    expect(api.lastCall('GET', '/api/v1/alarms')?.query.get('offset')).toBe('25');
    await user.selectOptions(within(main()).getByLabelText('Per page'), '50');
    await waitFor(() => {
      const q = api.lastCall('GET', '/api/v1/alarms')!.query;
      expect(q.get('limit')).toBe('50');
      expect(q.get('offset')).toBe('0'); // back to page 1
    });
  });
});

describe('Acknowledgement flow', () => {
  it('lets an operator acknowledge with a note and shows a success toast', async () => {
    let state: AlarmOut = unack;
    const api = installApi({
      'GET /api/v1/alarms': () => ({ items: [state], total: 1, limit: 25, offset: 0 }),
      'POST /api/v1/alarms/7/acknowledge': ({ body }) => {
        state = makeAlarm({
          id: 7,
          state: 'active_acknowledged',
          acknowledged: true,
          acknowledged_by: 'operator',
          acknowledged_at: iso(5),
        });
        return makeAlarmDetail({
          ...state,
          events: [makeAlarmEvent({ note: (body as { note?: string }).note ?? null })],
        });
      },
    });
    const user = userEvent.setup();
    renderApp({ route: '/alarms' });
    await user.click(await within(main()).findByRole('button', { name: 'Acknowledge alarm 7' }));
    const dialog = await screen.findByRole('dialog', { name: 'Acknowledge alarm #7' });
    await user.type(within(dialog).getByLabelText(/Note/), 'Checked on site');
    await user.click(within(dialog).getByRole('button', { name: 'Acknowledge' }));
    expect(await screen.findByText('Alarm #7 acknowledged')).toBeInTheDocument();
    expect(api.lastCall('POST', '/api/v1/alarms/7/acknowledge')?.body).toEqual({
      note: 'Checked on site',
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    // the list is refetched and shows the acknowledged state
    expect(
      await within(within(main()).getByRole('table')).findByText('Active - acknowledged'),
    ).toBeInTheDocument();
    expect(within(main()).queryByRole('button', { name: 'Acknowledge alarm 7' })).toBeNull();
  });

  it('prevents double submission while the request is pending', async () => {
    let release: () => void = () => undefined;
    const api = installApi({
      'GET /api/v1/alarms': () => ({ items: [unack], total: 1, limit: 25, offset: 0 }),
      'POST /api/v1/alarms/7/acknowledge': () =>
        new Promise((resolve) => {
          release = () => {
            resolve(makeAlarmDetail());
          };
        }),
    });
    const user = userEvent.setup();
    renderApp({ route: '/alarms' });
    await user.click(await within(main()).findByRole('button', { name: 'Acknowledge alarm 7' }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Acknowledge' });
    await user.click(confirm);
    await waitFor(() => {
      expect(confirm).toBeDisabled();
    });
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await user.click(confirm);
    await user.keyboard('{Escape}'); // cannot be dismissed mid-flight
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(api.callsTo('POST', '/api/v1/alarms/7/acknowledge')).toHaveLength(1);
    release();
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('handles 409 already-acknowledged sensibly: info toast, dialog closes, list refreshes', async () => {
    const api = installApi({
      'GET /api/v1/alarms': () => ({ items: [unack], total: 1, limit: 25, offset: 0 }),
      'POST /api/v1/alarms/7/acknowledge': () =>
        apiError(409, 'alarm_already_acknowledged', 'Alarm is already acknowledged'),
    });
    const user = userEvent.setup();
    renderApp({ route: '/alarms' });
    await user.click(await within(main()).findByRole('button', { name: 'Acknowledge alarm 7' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Acknowledge' }),
    );
    expect(await screen.findByText('Already acknowledged')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    const before = api.callsTo('GET', '/api/v1/alarms').length;
    await waitFor(() => {
      expect(api.callsTo('GET', '/api/v1/alarms').length).toBeGreaterThan(before - 1);
    });
  });

  it('keeps the dialog open and shows an error for unexpected failures so the operator can retry', async () => {
    installApi({
      'GET /api/v1/alarms': () => ({ items: [unack], total: 1, limit: 25, offset: 0 }),
      'POST /api/v1/alarms/7/acknowledge': () =>
        apiError(500, 'internal_error', 'An internal error occurred'),
    });
    const user = userEvent.setup();
    renderApp({ route: '/alarms' });
    await user.click(await within(main()).findByRole('button', { name: 'Acknowledge alarm 7' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Acknowledge' }));
    expect(await screen.findByText('Acknowledgement failed')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Acknowledge' })).toBeEnabled();
  });

  it('shows the operator-only control as unavailable for viewers, with an explanation, and never calls the API', async () => {
    const api = installApi({ 'GET /api/v1/alarms': list([unack]) });
    const user = userEvent.setup();
    renderApp({ route: '/alarms', role: 'viewer' });
    const button = await within(main()).findByRole('button', { name: 'Acknowledge alarm 7' });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    await user.click(button);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.callsTo('POST', '/api/v1/alarms/7/acknowledge')).toHaveLength(0);
    await user.hover(button);
    expect(await screen.findByRole('tooltip', { hidden: false })).toHaveTextContent(
      'Operator role required',
    );
  });

  it('handles a 403 from the backend gracefully', async () => {
    installApi({
      'GET /api/v1/alarms': list([unack]),
      'POST /api/v1/alarms/7/acknowledge': () =>
        apiError(403, 'forbidden', 'This action requires the operator role'),
    });
    const user = userEvent.setup();
    renderApp({ route: '/alarms' });
    await user.click(await within(main()).findByRole('button', { name: 'Acknowledge alarm 7' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Acknowledge' }),
    );
    expect(
      await screen.findByText('Operator role required', { selector: '.st-toast__title' }),
    ).toBeInTheDocument();
  });
});
