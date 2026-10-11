import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { AlarmState } from '@/api/types';
import { iso, makeAlarmDetail, makeAlarmEvent } from '@/test/fixtures';
import { apiError, installApi } from '@/test/mockApi';
import { renderApp } from '@/test/render';
import { sortEvents } from './AlarmDetailPage';

const main = () => screen.getByRole('main');

describe('Alarm detail', () => {
  it('lists the transition history in chronological order with actor, note and timestamps', async () => {
    const events = [
      makeAlarmEvent({
        id: 3,
        event_type: 'cleared',
        from_state: 'active_acknowledged',
        to_state: 'cleared',
        ts: iso(120),
        actor: 'system',
      }),
      makeAlarmEvent({ id: 1, event_type: 'raised', ts: iso(0) }),
      makeAlarmEvent({
        id: 2,
        event_type: 'acknowledged',
        from_state: 'active_unacknowledged',
        to_state: 'active_acknowledged',
        ts: iso(60),
        actor: 'operator',
        note: 'Looking into it',
        value: null,
      }),
    ];
    installApi({
      'GET /api/v1/alarms/7': () =>
        makeAlarmDetail({
          state: 'cleared',
          condition_active: false,
          acknowledged: true,
          cleared_at: iso(120),
          acknowledged_by: 'operator',
          acknowledged_at: iso(60),
          events,
        }),
    });
    renderApp({ route: '/alarms/7' });
    const history = await screen.findByRole('list', { name: 'Alarm history, oldest first' });
    const items = within(history).getAllByRole('listitem');
    expect(items.map((i) => i.querySelector('.timeline__title span')?.textContent)).toEqual([
      'Raised',
      'Acknowledged',
      'Returned to normal',
    ]);
    expect(items[1]).toHaveTextContent('operator');
    expect(items[1]).toHaveTextContent('Looking into it');
    expect(items[1]).toHaveTextContent('2026-03-01 10:01:00.000');
    expect(items[2]).toHaveTextContent('Closed');
  });

  it('sortEvents orders by time, then id, without mutating the input', () => {
    const input = [
      makeAlarmEvent({ id: 5, ts: iso(10) }),
      makeAlarmEvent({ id: 4, ts: iso(10) }),
      makeAlarmEvent({ id: 6, ts: iso(1) }),
    ];
    expect(sortEvents(input).map((e) => e.id)).toEqual([6, 4, 5]);
    expect(input.map((e) => e.id)).toEqual([5, 4, 6]);
  });

  it('shows rule, threshold, trigger value and a replay link', async () => {
    installApi({ 'GET /api/v1/alarms/7': () => makeAlarmDetail() });
    renderApp({ route: '/alarms/7' });
    await screen.findByRole('heading', { name: /Engine temperature above limit/ });
    expect(within(main()).getByText('ME_TEMP_HIGH')).toBeInTheDocument();
    expect(within(main()).getByText('temperature > 95 °C')).toBeInTheDocument();
    expect(within(main()).getByText('Trigger value').nextElementSibling).toHaveTextContent(
      '96.1 °C at 2026-03-01 10:00:00.000',
    );
    expect(within(main()).getByRole('link', { name: 'Replay incident' })).toHaveAttribute(
      'href',
      '/replay?alarm=7',
    );
  });

  it.each<[AlarmState, RegExp]>([
    ['active_unacknowledged', /no operator has acknowledged it yet/],
    ['active_acknowledged', /still present/],
    ['cleared_unacknowledged', /returned to normal, but the alarm still needs to be acknowledged/],
    ['cleared', /alarm is closed/],
  ])('explains the lifecycle state %s in plain text', async (state, text) => {
    installApi({
      'GET /api/v1/alarms/7': () =>
        makeAlarmDetail({
          state,
          condition_active: state.startsWith('active'),
          acknowledged: state === 'cleared' || state === 'active_acknowledged',
        }),
    });
    renderApp({ route: '/alarms/7' });
    expect(await screen.findByTestId('state-explanation')).toHaveTextContent(text);
  });

  it('acknowledges from the detail page and reflects the new state', async () => {
    let detail = makeAlarmDetail();
    installApi({
      'GET /api/v1/alarms/7': () => detail,
      'POST /api/v1/alarms/7/acknowledge': () => {
        detail = makeAlarmDetail({
          state: 'active_acknowledged',
          acknowledged: true,
          acknowledged_by: 'operator',
          acknowledged_at: iso(30),
          events: [
            makeAlarmEvent(),
            makeAlarmEvent({
              id: 2,
              event_type: 'acknowledged',
              from_state: 'active_unacknowledged',
              to_state: 'active_acknowledged',
              actor: 'operator',
              ts: iso(30),
            }),
          ],
        });
        return detail;
      },
    });
    const user = userEvent.setup();
    renderApp({ route: '/alarms/7' });
    await user.click(await screen.findByRole('button', { name: 'Acknowledge alarm 7' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Acknowledge' }),
    );
    expect(await screen.findByTestId('state-explanation')).toHaveTextContent(
      /Active - acknowledged/,
    );
    const history = screen.getByRole('list', { name: 'Alarm history, oldest first' });
    expect(within(history).getAllByRole('listitem')).toHaveLength(2);
  });

  it('shows not-found and invalid-id states', async () => {
    installApi({
      'GET /api/v1/alarms/99': () => apiError(404, 'not_found', "Alarm '99' was not found"),
    });
    const first = renderApp({ route: '/alarms/99' });
    expect(await screen.findByText('Alarm #99 was not found')).toBeInTheDocument();
    first.unmount();
    renderApp({ route: '/alarms/abc' });
    expect(await screen.findByText('Invalid alarm id')).toBeInTheDocument();
  });
});
