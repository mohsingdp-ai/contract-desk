// The desktop app (Electron): starts its own server, shows the app, keeps settings, and turns phone access on.
// Runs with the window hidden and a throwaway settings + data folder.
import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test.describe.configure({ mode: 'serial' });
const PORT = '4797';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-desk-desktop-'));
const userData = path.join(root, 'settings');
const dataDir = path.join(root, 'data');
const settings = () => JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8'));
const lanIp = Object.values(os.networkInterfaces()).flat().find((n) => n.family === 'IPv4' && !n.internal)?.address;

test.beforeAll(() => {
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ dataDir }));
});
test.afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const launch = () => electron.launch({ args: ['.'], env: { ...process.env, CONTRACT_DESK_PORT: PORT, CONTRACT_DESK_HIDDEN: '1', CONTRACT_DESK_USER_DATA: userData } });
const menu = (app) =>
  app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.map((i) => ({ label: i.label, items: i.submenu.items.map((s) => s.label).filter(Boolean) })));

test('opens the app in its own window, stores data in the chosen folder, phone access off by default', async () => {
  const app = await launch();
  const win = await app.firstWindow();
  await expect(win.getByRole('heading', { name: 'The desk is empty.' })).toBeVisible();
  expect(await win.title()).toBe('Contract Desk');
  await expect(win.getByRole('button', { name: 'Connect phone' })).toHaveCount(0);
  await expect(win.getByText('Local only · offline')).toBeVisible();

  await win.getByRole('link', { name: 'New contract' }).click();
  await win.getByRole('dialog').getByLabel('Contract No.').fill('DESK-001');
  await win.getByRole('dialog').getByLabel('Amount').fill('100');
  await win.getByRole('dialog').getByRole('button', { name: 'Create contract' }).click();
  await expect(win.getByRole('heading', { level: 1, name: 'DESK-001' })).toBeVisible();
  expect(fs.existsSync(path.join(dataDir, 'contracts.db'))).toBe(true);

  const m = await menu(app);
  expect(m.map((x) => x.label)).toEqual(['File', 'Phone', 'View']);
  expect(m[0].items).toEqual(expect.arrayContaining(['Open data folder', 'Change data folder…', 'Start when the computer starts']));
  expect(m[1].items).toEqual(['Turn phone access on…']);
  if (lanIp) expect((await fetch(`http://${lanIp}:${PORT}/api/meta`).catch(() => null))?.status ?? 'refused').toBe('refused'); // not on the network
  await app.close();
});

test('a second copy just focuses the first one instead of starting another server', async () => {
  const first = await launch();
  await first.firstWindow();
  const second = await electron.launch({ args: ['.'], env: { ...process.env, CONTRACT_DESK_PORT: PORT, CONTRACT_DESK_HIDDEN: '1', CONTRACT_DESK_USER_DATA: userData } }).catch((e) => e);
  // The second process quits on its own right away (single-instance lock).
  if (!(second instanceof Error)) await expect.poll(() => second.process().exitCode, { timeout: 10_000 }).not.toBeNull();
  expect((await fetch(`http://127.0.0.1:${PORT}/api/meta`)).status).toBe(200);
  await first.close();
});

test('with phone access on: passcode is created and kept, phones need it, the QR button appears', async () => {
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ dataDir, phoneAccess: true }));
  const app = await launch();
  const win = await app.firstWindow();
  await expect(win.getByRole('heading', { level: 1 }).or(win.locator('.search-hero')).first()).toBeVisible();
  const { passcode } = settings();
  expect(passcode).toMatch(/^[a-z2-9]{8}$/);
  await expect(win.getByRole('button', { name: 'Connect phone' })).toBeVisible();
  await expect(win.getByText('Wi-Fi access on · passcode')).toBeVisible();
  const m = await menu(app);
  expect(m[1].items).toEqual(expect.arrayContaining(['Phone access is on', 'Show passcode…', 'Turn phone access off']));
  if (lanIp) {
    expect((await fetch(`http://${lanIp}:${PORT}/api/contracts`)).status).toBe(401);
    const login = await fetch(`http://${lanIp}:${PORT}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passcode }) });
    expect(login.status).toBe(200);
  }
  await app.close();

  // Restarting keeps the same passcode, so connected phones stay connected.
  const again = await launch();
  await again.firstWindow();
  expect(settings().passcode).toBe(passcode);
  await again.close();
});
