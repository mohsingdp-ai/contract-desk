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

  // Settings (the gear in the top bar): a backup can be made from here, but a restore only on the computer itself.
  await page.getByRole('link', { name: 'Settings' }).tap();
  await expect(page.getByRole('link', { name: 'Back up now' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Restore/ })).toHaveCount(0);
  await expect(page.getByText('Restore works only on the computer that runs Contract Desk.')).toBeVisible();
  await page.getByRole('link', { name: 'Search' }).tap();

  await page.locator('#q').fill('WIFI-001');
  await page.locator('a.tr').filter({ hasText: 'WIFI-001' }).tap();
  await expect(page.getByRole('heading', { level: 1, name: 'WIFI-001' })).toBeVisible();

  // remembered after reload
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'WIFI-001' })).toBeVisible();
});

test('phone scans the QR code shown on the computer and is unlocked without the passcode', async ({ browser }) => {
  // The computer: open the app locally and show a code.
  const computer = await browser.newPage({ baseURL: `http://127.0.0.1:${LAN_PORT}` });
  await computer.goto('/');
  await computer.getByRole('button', { name: 'Connect phone' }).click();
  const dialog = computer.getByRole('dialog');
  await expect(dialog.getByRole('img', { name: 'QR code to connect a phone' }).first()).toBeVisible();
  await expect(dialog).toContainText('Works once');
  const src = await dialog.getByRole('img').first().getAttribute('src');
  expect(src).toMatch(/^data:image\/svg\+xml/);
  // What the camera reads: ask the server for the same kind of link the QR encodes.
  const { links } = await (await computer.request.post('/api/pair')).json();
  const link = links.find((l) => l.url.includes(lanIp)).url;
  await computer.close();

  // The phone: a fresh device that never entered the passcode.
  const phone = await browser.newContext({ ...pixel, baseURL: `http://${lanIp}:${LAN_PORT}` });
  const page = await phone.newPage();
  await page.goto(link);
  await expect(page).toHaveURL(`http://${lanIp}:${LAN_PORT}/`);
  await expect(page.locator('.search-hero')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Enter passcode' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Connect phone' })).toHaveCount(0); // only the computer can add devices

  // A second phone scanning the same (used) code gets a clear message.
  const other = await (await browser.newContext({ ...pixel })).newPage();
  await other.goto(link);
  await expect(other.getByRole('heading', { name: 'Enter passcode' })).toBeVisible();
  await expect(other.locator('.form-error')).toContainText('already used or has expired');
  await expect(other).toHaveURL(`http://${lanIp}:${LAN_PORT}/`); // message shown, address cleaned up
  await phone.close();
});
