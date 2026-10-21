// The desktop app (Electron): starts its own server, shows the app, keeps settings, and turns phone access on.
// Runs with the window hidden and a throwaway settings + data folder.
import { test, expect, _electron as electron } from '@playwright/test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
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

// WATCH=1 shows the real window and slows down; otherwise the window stays hidden.
const WATCH = !!process.env.WATCH;
const appEnv = () => ({ ...process.env, CONTRACT_DESK_PORT: PORT, CONTRACT_DESK_USER_DATA: userData, ...(WATCH ? { CONTRACT_DESK_TEST: '1' } : { CONTRACT_DESK_HIDDEN: '1' }) });
const launch = () => electron.launch({ args: ['.'], env: appEnv() });
// Fixed size: a tiling window manager may squeeze the visible window into the phone layout.
const sized = async (app) => {
  const w = await app.firstWindow();
  await w.setViewportSize({ width: 1280, height: 800 });
  return w;
};
const beat = (ms = 1400) => (WATCH ? new Promise((r) => setTimeout(r, ms)) : null);
// Banner at the top of the window narrating what the test does (watch mode only).
async function say(win, text, ms = 2200) {
  if (!WATCH) return;
  await win.evaluate((text) => {
    let el = document.getElementById('__say');
    if (!el) {
      el = document.createElement('div');
      el.id = '__say';
      el.style.cssText = "position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:2147483647;background:#b23416;color:#fff;padding:10px 18px;font:600 15px/1.4 'Archivo Variable',sans-serif;box-shadow:0 10px 30px rgb(0 0 0/.35);max-width:90vw";
      document.documentElement.append(el);
    }
    el.textContent = text;
  }, text);
  await beat(ms);
}
const menu = (app) =>
  app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.map((i) => ({ label: i.label, items: i.submenu.items.map((s) => s.label).filter(Boolean) })));

test('opens the app in its own window, stores data in the chosen folder, phone access off by default', async () => {
  const app = await launch();
  const win = await sized(app);
  await expect(win.getByRole('heading', { name: 'The desk is empty.' })).toBeVisible();
  await say(win, 'Desktop app started: its own window, data in the folder from settings');
  expect(await win.title()).toBe('Contract Desk');
  await expect(win.getByRole('button', { name: 'Connect phone' })).toHaveCount(0);
  await expect(win.getByText('Local only · offline')).toBeVisible();

  await say(win, 'Creating a contract so there are records to move later');
  await win.getByRole('link', { name: 'New contract' }).click();
  await beat(600);
  await win.getByRole('dialog').getByLabel('Contract No.').fill('DESK-001');
  await win.getByRole('dialog').getByLabel('Amount').fill('100');
  await win.getByRole('dialog').getByRole('button', { name: 'Create contract' }).click();
  await expect(win.getByRole('heading', { level: 1, name: 'DESK-001' })).toBeVisible();
  await say(win, 'Saved: DESK-001 is in the data folder');
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
  await sized(first);
  const second = await electron.launch({ args: ['.'], env: appEnv() }).catch((e) => e);
  // The second process quits on its own right away (single-instance lock).
  if (!(second instanceof Error)) await expect.poll(() => second.process().exitCode, { timeout: 10_000 }).not.toBeNull();
  expect((await fetch(`http://127.0.0.1:${PORT}/api/meta`)).status).toBe(200);
  await first.close();
});

test('with phone access on: passcode is created and kept, phones need it, the QR button appears', async () => {
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ dataDir, phoneAccess: true }));
  const app = await launch();
  const win = await sized(app);
  await expect(win.getByRole('heading', { level: 1 }).or(win.locator('.search-hero')).first()).toBeVisible();
  const { passcode } = settings();
  expect(passcode).toMatch(/^[a-z2-9]{8}$/);
  await expect(win.getByRole('button', { name: 'Connect phone' })).toBeVisible();
  await say(win, 'Phone access on: a passcode was created and the Connect phone button appears');
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
  await sized(again);
  expect(settings().passcode).toBe(passcode);
  await again.close();
});

// The system folder picker and question boxes are stubbed: the test answers them like a person would.
const answer = (app, folder, button) =>
  app.evaluate(
    ({ dialog }, { folder, button }) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
      dialog.showMessageBox = async () => ({ response: button });
    },
    { folder, button },
  );
const contractCount = (dir) => {
  const db = new (require('node:sqlite').DatabaseSync)(path.join(dir, 'contracts.db'), { readOnly: true });
  const n = db.prepare('SELECT count(*) AS n FROM contracts').get().n;
  db.close();
  return n;
};

test('change the data folder from the sidebar and move the records there; old folder untouched', async () => {
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ dataDir }));
  const moved = path.join(root, 'moved-here');
  let app = await launch();
  let win = await sized(app);
  await expect(win.getByRole('button', { name: 'Change…' })).toBeVisible();
  await say(win, 'Data folder: the sidebar now has Open and Change… (bottom left)', 2600);
  await win.getByRole('button', { name: 'Change…' }).hover();
  await say(win, 'Clicking Change… · the folder picker is answered with “moved-here”, then “Move my records there”', 3000);
  await answer(app, moved, 0); // "Move my records there"
  const closed = app.waitForEvent('close');
  await win.getByRole('button', { name: 'Change…' }).click();
  await closed; // restarts to switch
  expect(settings()).toMatchObject({ dataDir: moved, moveFrom: dataDir });

  app = await launch();
  win = await sized(app);
  await expect(win.locator('.rail-foot code')).toHaveText(moved);
  await say(win, 'After the restart: the data folder is now “moved-here” (bottom left)', 2800);
  await win.locator('#q').fill('DESK-001');
  await expect(win.locator('a.tr').filter({ hasText: 'DESK-001' })).toBeVisible();
  await say(win, 'DESK-001 came along. The old folder is checked too: still intact', 2800);
  expect(settings().moveFrom).toBeUndefined();
  expect(contractCount(moved)).toBe(1);
  expect(contractCount(dataDir)).toBe(1); // the old folder is left as it was
  await app.close();
});

test('choosing a folder that already has records opens them', async () => {
  const app = await launch();
  const win = await sized(app);
  await say(win, 'Change… again · picking the original folder, which already has records → “Open these records”', 3000);
  await answer(app, dataDir, 0); // "Open these records"
  const closed = app.waitForEvent('close');
  await win.getByRole('button', { name: 'Change…' }).click();
  await closed;
  expect(settings().dataDir).toBe(dataDir);
  expect(settings().moveFrom).toBeUndefined();
});

test('a move that cannot finish leaves everything as it was', async () => {
  // Target already holds a database: the move must refuse and keep using the old folder.
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ dataDir: path.join(root, 'moved-here'), moveFrom: dataDir }));
  const app = await launch();
  const win = await sized(app);
  await expect(win.locator('.rail-foot code')).toHaveText(dataDir);
  await say(win, 'A move into a folder that already has a database is refused: still using the original folder, nothing overwritten', 3200);
  expect(settings()).toMatchObject({ dataDir });
  expect(settings().moveFrom).toBeUndefined();
  expect(contractCount(path.join(root, 'moved-here'))).toBe(1); // nothing overwritten
  await app.close();
});

test('a backup counts for the reminder only once its file is saved, not when the save dialog is cancelled', async () => {
  const app = await launch();
  const win = await sized(app);
  const lastBackup = async () => (await (await fetch(`http://127.0.0.1:${PORT}/api/meta`)).json()).lastBackup;
  // Stands in for the owner's answer to the save dialog: cancel, or save to `file`.
  const answerSave = (file) =>
    app.evaluate(({ session }, file) => {
      global.__download = null;
      session.defaultSession.once('will-download', (e, item) => {
        item.once('done', (e, state) => (global.__download = state));
        file ? item.setSavePath(file) : item.cancel();
      });
    }, file);
  const finished = () => expect.poll(() => app.evaluate(() => global.__download)).not.toBeNull();
  const before = await lastBackup();
  await answerSave(null);
  await win.locator('.rail-foot').getByRole('link', { name: 'Back up…' }).click();
  await finished();
  expect(await app.evaluate(() => global.__download)).toBe('cancelled');
  expect(await lastBackup()).toBe(before);
  const file = path.join(root, 'saved-backup.tar');
  await answerSave(file);
  await win.locator('.rail-foot').getByRole('link', { name: 'Back up…' }).click();
  await finished();
  expect(await app.evaluate(() => global.__download)).toBe('completed');
  expect(fs.statSync(file).size).toBeGreaterThan(1024);
  await expect.poll(lastBackup).not.toBe(before);
  await app.close();
});
