/**
 * Smoke E2E: the built app boots, exposes the typed bridge, and renders
 * either the first-run Setup view or the Library. Run `npm run build` first.
 * Recording flows are covered by later specs (they need macOS Screen
 * Recording permission on the Electron binary; see docs in SPEC section 7).
 */
import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('boots to Setup or Library without renderer errors', async () => {
  const mainEntry = path.resolve(__dirname, '../apps/desktop/out/main/index.js');
  test.skip(!fs.existsSync(mainEntry), 'Build the app first: npm run build');

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'openloom-e2e-'));
  const app = await electron.launch({
    args: [mainEntry],
    env: {
      ...process.env,
      OPENLOOM_USER_DATA: userData,
      ELECTRON_ENABLE_LOGGING: '1',
    },
  });

  const errors: string[] = [];
  const window = await app.firstWindow();
  window.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });

  await expect(window).toHaveTitle('Open Loom');

  // The bridge must be present and typed calls must round-trip.
  const info = await window.evaluate(() => window.openloom.appInfo());
  expect(info.version).toBeTruthy();
  expect(['darwin', 'win32', 'linux']).toContain(info.platform);

  // First run on a clean profile: Setup (or Library if everything is granted).
  const heading = window.locator('h1, h2').first();
  await expect(heading).toHaveText(/Welcome to Open Loom|Library/);

  expect(errors, `renderer console errors:\n${errors.join('\n')}`).toEqual([]);

  await app.close();
  fs.rmSync(userData, { recursive: true, force: true });
});
