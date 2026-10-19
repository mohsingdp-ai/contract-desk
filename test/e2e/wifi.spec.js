// A phone on the same Wi-Fi: reaches the app through this machine's network address and must enter the passcode.
import { test, expect, devices } from '@playwright/test';
import os from 'node:os';
import { LAN_PORT, LAN_PASSCODE } from '../../playwright.config.js';

const lanIp = Object.values(os.networkInterfaces()).flat().find((n) => n.family === 'IPv4' && !n.internal)?.address;
const { defaultBrowserType, ...pixel } = devices['Pixel 7'];
test.use({ ...pixel, baseURL: `http://${lanIp}:${LAN_PORT}` });
test.skip(!lanIp, 'no network address on this machine');

test('phone on Wi-Fi: passcode screen, wrong code refused, right code unlocks and is remembered', async ({ page, request }) => {
  await request.post(`http://127.0.0.1:${LAN_PORT}/api/contracts`, { data: { contract_no: 'WIFI-001', project_name: 'Wi-Fi check', firm_name: 'LAN Firm', amount: 10, currency: 'USD' } });

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Enter passcode' })).toBeVisible();
  await expect(page.getByText('WIFI-001')).toHaveCount(0);

  await page.getByLabel('Passcode').fill('not-it');
  await page.getByRole('button', { name: 'Unlock' }).tap();
  await expect(page.locator('.form-error')).toHaveText('Wrong passcode');

  await page.getByLabel('Passcode').fill(LAN_PASSCODE);
  await page.getByRole('button', { name: 'Unlock' }).tap();
  await expect(page.locator('.search-hero')).toBeVisible();
  await expect(page.getByText('Wi-Fi access on · passcode')).toHaveCount(1);

  await page.locator('#q').fill('WIFI-001');
  await page.locator('a.tr').filter({ hasText: 'WIFI-001' }).tap();
  await expect(page.getByRole('heading', { level: 1, name: 'WIFI-001' })).toBeVisible();

  // remembered after reload
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'WIFI-001' })).toBeVisible();
});
