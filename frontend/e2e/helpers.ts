import { expect, type APIRequestContext, type Page } from '@playwright/test';

export function credential(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Environment variable ${name} is required for the e2e tests (demo account credentials are never hardcoded).`);
  }
  return value;
}

export const operator = () => ({ user: credential('E2E_OPERATOR_USER'), password: credential('E2E_OPERATOR_PASSWORD') });
export const viewer = () => ({ user: credential('E2E_VIEWER_USER'), password: credential('E2E_VIEWER_PASSWORD') });

export async function login(page: Page, account: { user: string; password: string }, target = '/'): Promise<void> {
  await page.goto(target);
  await page.getByLabel('Username').fill(account.user);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page).not.toHaveURL(/\/login/);
}

/** Bearer token of the signed-in session (kept in sessionStorage by the app). */
export async function sessionToken(page: Page): Promise<string> {
  const token = await page.evaluate(() => {
    const raw = window.sessionStorage.getItem('seatrace.auth');
    return raw ? (JSON.parse(raw) as { token: string }).token : null;
  });
  if (!token) throw new Error('Not signed in');
  return token;
}

interface AlarmRow {
  id: number;
  state: string;
  severity: string;
  equipment_code: string;
  kind: string;
}

export async function listAlarms(request: APIRequestContext, token: string, query: string): Promise<AlarmRow[]> {
  const response = await request.get(`/api/v1/alarms?${query}`, { headers: { Authorization: `Bearer ${token}` } });
  expect(response.ok()).toBeTruthy();
  return ((await response.json()) as { items: AlarmRow[] }).items;
}

export async function highestAlarmId(request: APIRequestContext, token: string): Promise<number> {
  const items = await listAlarms(request, token, 'limit=1');
  return items[0]?.id ?? 0;
}
