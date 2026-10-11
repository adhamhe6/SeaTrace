import { expect, test, type Page } from '@playwright/test';
import { listAlarms, login, operator, sessionToken, viewer } from './helpers';

const SCENARIO_NAME = 'Engine overheating';
const VESSEL = 'VES-001';

async function scenarioCard(page: Page, name: string) {
  return page.getByRole('heading', { name, level: 3 }).locator('xpath=ancestor::section[1]');
}

test.describe('sign-in', () => {
  test('rejects invalid credentials and keeps the user on the login page', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Username').fill('nobody');
    await page.getByLabel('Password').fill('definitely-wrong');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText('Invalid username or password.')).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test('redirects unauthenticated deep links to the login page and returns after sign-in', async ({ page }) => {
    await page.goto('/alarms?severity=critical');
    await expect(page).toHaveURL(/\/login\?next=/);
    const account = operator();
    await page.getByLabel('Username').fill(account.user);
    await page.getByLabel('Password').fill(account.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { name: 'Alarm center' })).toBeVisible();
    await expect(page).toHaveURL(/severity=critical/);
  });
});

test.describe('operator incident workflow', () => {
  test.describe.configure({ mode: 'serial' });

  test('fleet overview lists both vessels and values update live', async ({ page }) => {
    await login(page, operator());
    const table = page.getByRole('table', { name: 'Vessel inventory' });
    await expect(table.getByRole('row')).toHaveCount(3); // header + 2 vessels
    await expect(page.getByTestId('live-state')).toHaveText('Connected');
    await expect(page.getByTestId('opcua-state')).toHaveText('Connected');

    await page.getByRole('link', { name: /MV Aurora Tide/ }).first().click();
    const reading = page.getByTestId('reading-vibration').getByTestId('reading-value');
    await expect(reading).toHaveText(/\d/);
    const first = await reading.innerText();
    // the simulator adds noise each tick, so the value must change without a page reload
    await expect.poll(async () => reading.innerText(), { timeout: 30_000 }).not.toBe(first);
  });

  test('activate a fault, see the alarm, acknowledge it, inspect history, replay it and clear the scenario', async ({ page, request }) => {
    await login(page, operator());
    const token = await sessionToken(page);
    // Start from a clean simulator (a previous aborted run may have left a scenario active) and wait
    // until no condition alarm on ME1 is still active.
    await request.post('/api/v1/simulator/reset', { headers: { Authorization: `Bearer ${token}` } });
    await expect
      .poll(
        async () => {
          const items = await listAlarms(request, token, `vessel=${VESSEL}&equipment=ME1&kind=condition&open=true&limit=50`);
          return items.filter((a) => a.state.startsWith('active')).length;
        },
        { timeout: 90_000, intervals: [2000] },
      )
      .toBe(0);

    // 1. Activate the scenario from the simulator page
    await page.goto('/simulator');
    const card = await scenarioCard(page, SCENARIO_NAME);
    await expect(card.getByLabel('Vessel')).toHaveValue(VESSEL);
    await card.getByRole('button', { name: `Activate ${SCENARIO_NAME}` }).click();
    await expect(card.getByText(/Scenario activated on VES-001/)).toBeVisible();
    await expect(page.getByRole('list', { name: 'Active scenarios' })).toContainText(SCENARIO_NAME);

    // 2. Wait (generously) for an unacknowledged condition alarm on ME1 caused by this scenario.
    //    A re-triggered alarm is reactivated (same id), so we select by state rather than by a new id.
    let alarmId = 0;
    await expect
      .poll(
        async () => {
          const items = await listAlarms(request, token, `vessel=${VESSEL}&equipment=ME1&kind=condition&state=active_unacknowledged&limit=20`);
          alarmId = items.at(-1)?.id ?? 0;
          return alarmId > 0;
        },
        { timeout: 180_000, intervals: [2000], message: 'overheating needs tens of seconds to cross the alarm threshold' },
      )
      .toBe(true);

    // 3. It shows up in the alarm center, unacknowledged
    await page.goto(`/alarms?vessel=${VESSEL}&equipment=ME1&kind=condition`);
    const row = page.getByRole('row').filter({ has: page.getByRole('link', { name: `Details of alarm ${String(alarmId)}` }) });
    await expect(row).toBeVisible();
    await expect(row.getByText('Active - unacknowledged')).toBeVisible();

    // 4. Acknowledge with a note
    await row.getByRole('button', { name: `Acknowledge alarm ${String(alarmId)}` }).click();
    const dialog = page.getByRole('dialog', { name: `Acknowledge alarm #${String(alarmId)}` });
    await dialog.getByLabel(/Note/).fill('e2e: seen on the bridge');
    await dialog.getByRole('button', { name: 'Acknowledge' }).click();
    await expect(page.getByText(`Alarm #${String(alarmId)} acknowledged`)).toBeVisible();
    await expect(row.getByText(/Active - acknowledged|Closed/)).toBeVisible();

    // 5. Detail page shows the history entry with actor and note
    await page.goto(`/alarms/${String(alarmId)}`);
    const history = page.getByRole('list', { name: 'Alarm history, oldest first' });
    await expect(history.getByRole('listitem').first()).toContainText('Raised');
    const ack = history.getByRole('listitem').filter({ hasText: /^Acknowledged/ });
    await expect(ack).toContainText(operator().user);
    await expect(ack).toContainText('e2e: seen on the bridge');

    // 6. Replay the incident: charts render and playback advances
    await page.getByRole('link', { name: 'Replay incident' }).click();
    await expect(page.getByTestId('replay-workbench')).toBeVisible();
    await expect(page.getByTestId('replay-charts').locator('canvas').first()).toBeVisible();
    expect(await page.getByTestId('replay-charts').locator('canvas').count()).toBeGreaterThanOrEqual(2);
    const cursor = page.getByTestId('cursor-time');
    const before = await cursor.innerText();
    await page.getByRole('button', { name: '30x' }).click();
    await page.getByRole('button', { name: 'Play' }).click();
    await expect.poll(async () => cursor.innerText(), { timeout: 20_000 }).not.toBe(before);
    await page.getByRole('button', { name: 'Pause' }).click();
    await page.getByRole('button', { name: 'Jump to alarm raised' }).click();
    await expect(page.getByTestId('phase')).toContainText('During alarm');
    await expect(page.getByRole('list', { name: 'Open alarms at cursor' })).toContainText(`#${String(alarmId)}`);

    // 7. Clear the scenario again
    await page.goto('/simulator');
    const again = await scenarioCard(page, SCENARIO_NAME);
    await again.getByRole('button', { name: `Clear ${SCENARIO_NAME}` }).click();
    await expect(again.getByText(/Scenario cleared on VES-001/)).toBeVisible();
    await expect(page.getByRole('list', { name: 'Active scenarios' })).toHaveCount(0, { timeout: 30_000 });
  });
});

test.describe('viewer role', () => {
  test('cannot use operator controls and the UI says why', async ({ page, request }) => {
    await login(page, viewer());
    const token = await sessionToken(page);
    const posts: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST') posts.push(r.url());
    });

    await page.goto('/simulator');
    await expect(page.getByText('Read-only access.')).toBeVisible();
    const card = await scenarioCard(page, SCENARIO_NAME);
    const activate = card.getByRole('button', { name: `Activate ${SCENARIO_NAME}` });
    await expect(activate).toHaveAttribute('aria-disabled', 'true');
    await activate.hover();
    await expect(card.getByRole('tooltip')).toHaveText('Operator role required');
    await activate.click({ force: true });
    await expect(page.getByRole('button', { name: 'Reset all scenarios' })).toHaveAttribute('aria-disabled', 'true');

    await page.goto('/alarms');
    for (const button of await page.getByRole('button', { name: /^Acknowledge alarm/ }).all()) {
      await expect(button).toHaveAttribute('aria-disabled', 'true');
    }
    expect(posts).toEqual([]);

    // The backend enforces the same rule independently of the UI
    const forbidden = await request.post('/api/v1/simulator/reset', { headers: { Authorization: `Bearer ${token}` } });
    expect(forbidden.status()).toBe(403);
  });
});
