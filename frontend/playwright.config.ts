import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

/** Chromium is pre-installed (never downloaded): honour PLAYWRIGHT_CHROMIUM_EXECUTABLE, else look under /opt/pw-browsers. */
function findChromium(): string | undefined {
  const fromEnv = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (fromEnv) return fromEnv;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  if (!existsSync(root)) return undefined; // fall back to Playwright's own browser resolution
  const candidates = readdirSync(root)
    .filter((name) => name.startsWith('chromium-'))
    .sort()
    .reverse()
    .flatMap((name) => [
      join(root, name, 'chrome-linux', 'chrome'),
      join(root, name, 'chrome-linux64', 'chrome'),
    ]);
  return candidates.find((path) => existsSync(path));
}

export default defineConfig({
  testDir: './e2e',
  timeout: 240_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1440, height: 900 },
    launchOptions: { executablePath: findChromium(), args: ['--no-sandbox'] },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
