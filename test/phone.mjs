// Phone app checks (part of npm test). The built web bundle runs in Chromium exactly as in the Android app: the database
// worker, sqlite-wasm and its OPFS storage are real. Only the Android side (the Folder plugin: All files access, the
// system folder picker and file writes) is played by this script, on a throwaway "phone storage" folder on disk.
// A browser profile is the app's private storage: same profile = app restart, new profile = uninstall + reinstall.
import { chromium } from '@playwright/test';
import { build } from 'vite';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../server/db.js';
import { createRules, storedName } from '../core/rules.js';

const executablePath = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find((p) => fs.existsSync(p));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-desk-phone-'));
const dist = path.join(tmp, 'dist');
const storage = path.join(tmp, 'storage'); // stands for /storage/emulated/0
const PHONE_ROOT = '/storage/emulated/0';
const DEFAULT_DIR = path.join(storage, 'Documents', 'Contract Desk');
const treeOf = (rel) => `content://com.android.externalstorage.documents/tree/${encodeURIComponent(`primary:${rel}`)}`;

await build({ configFile: path.resolve('vite.config.js'), logLevel: 'error', build: { outDir: dist, emptyOutDir: true } });

// ---------- the "phone" ----------

// die: 'before' / 'after' makes the next contracts.db replace hang before / after it happens, so the test can "kill" the app there.
// bio: what the fingerprint / face check reports; bioFail: the next fingerprint doesn't match (or is cancelled).
const device = { access: false, grantOnRequest: true, pick: null, calls: [], die: null, hung: false, free: 8 * 1024 ** 3, bio: { isAvailable: true, deviceIsSecure: true }, bioFail: false, exited: false };
const hang = () => ((device.hung = true), new Promise(() => {}));
// Folder (path or picker link) + name -> file on disk.
function disk(folder, name = '') {
  if (folder.startsWith('content://')) {
    const [, id] = folder.match(/\/tree\/([^/]+)/);
    folder = `${PHONE_ROOT}/${decodeURIComponent(id).split(':')[1]}`;
  }
  assert.ok(folder.startsWith(PHONE_ROOT), folder);
  return path.join(storage, folder.slice(PHONE_ROOT.length), name);
}
const plugin = {
  hasAllFilesAccess: () => ({ granted: device.access }),
  requestAllFilesAccess: () => ((device.access = device.grantOnRequest), { granted: device.access }),
  pickFolder: () => device.pick || {},
  prepare: ({ folder }) => void fs.mkdirSync(disk(folder, 'files'), { recursive: true }),
  stat: ({ folder, name }) => {
    const s = fs.statSync(disk(folder, name), { throwIfNoEntry: false });
    return s ? { exists: true, size: s.size, mtime: Math.floor(s.mtimeMs) } : { exists: false, size: 0, mtime: 0 };
  },
  write: ({ folder, name, data, append }) => void (append ? fs.appendFileSync : fs.writeFileSync)(disk(folder, name), Buffer.from(data, 'base64')),
  rename: ({ folder, from, to }) => {
    if (device.die === 'before' && to === 'contracts.db') return hang();
    fs.renameSync(disk(folder, from), disk(folder, to));
    if (device.die === 'after' && to === 'contracts.db') return hang();
  },
  remove: ({ folder, name }) => fs.rmSync(disk(folder, name), { force: true }),
  list: ({ folder, dir }) => ({ names: fs.existsSync(disk(folder, dir)) ? fs.readdirSync(disk(folder, dir)) : [] }),
  copy: ({ from, to, name }) => (fs.copyFileSync(disk(from, name), disk(to, name)), { bytes: fs.statSync(disk(to, name)).size }),
  freeSpace: () => ({ free: device.free }),
  // BiometricAuthNative (@aparajita/capacitor-biometric-auth) and App (@capacitor/app)
  checkBiometry: () => device.bio,
  internalAuthenticate: () => {
    if (device.bioFail) throw new Error('Authentication failed');
  },
  exitApp: () => void (device.exited = true),
};

// Serves the bundle, plus phone files at the URL the fake convertFileSrc gives (the WebView's file server on Android).
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file;
  if (url.startsWith('/__folder__/')) {
    const src = url.slice('/__folder__/'.length);
    if (src.startsWith('content://')) {
      const [tree, doc] = src.split('/document/');
      file = disk(tree, decodeURIComponent(doc).slice(decodeURIComponent(tree.split('/tree/')[1]).length + 1));
    } else file = disk(decodeURIComponent(src.replace('file://', '')));
  } else file = path.join(dist, url === '/' ? 'index.html' : url);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return res.writeHead(404).end();
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm' };
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' }).end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/`;

let app; // { context, page }
const errors = [];
async function launch(profile, { oldWebView = false } = {}) {
  const context = await chromium.launchPersistentContext(path.join(tmp, profile), { executablePath, viewport: { width: 412, height: 915 }, hasTouch: true });
  await context.exposeBinding('__native', (src, method, opts) => (device.calls.push(method), plugin[method](opts) ?? {}));
  await context.addInitScript(() => {
    window.Capacitor = {
      isNativePlatform: () => true,
      convertFileSrc: (u) => `/__folder__/${encodeURIComponent(u)}`,
      nativePromise: (name, method, opts) => window.__native(method, opts),
      nativeCallback: (name, method, opts, callback) => (window.__backButton = callback), // App.addListener('backButton')
    };
  });
  if (oldWebView) {
    // An Android System WebView without the storage the phone database needs.
    await context.route('**/phone-worker-*.js', async (route) => {
      const body = await (await route.fetch()).text();
      await route.fulfill({ contentType: 'text/javascript', body: `delete self.FileSystemSyncAccessHandle; delete FileSystemFileHandle.prototype.createSyncAccessHandle;\n${body}` });
    });
  }
  const page = context.pages()[0] || (await context.newPage());
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  await page.goto(BASE);
  app = { context, page };
  return page;
}
const quit = async () => (await app.context.close(), (app = null));

const folderDb = (dir, sql) => {
  const d = new DatabaseSync(path.join(dir, 'contracts.db'), { readOnly: true });
  try {
    return d.prepare(sql).all();
  } finally {
    d.close();
  }
};
async function until(fn, what, ms = 10_000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 150))) {
    try {
      if (fn()) return;
    } catch {}
  }
  assert.fail(`timed out waiting for: ${what}`);
}
const contractNos = (dir) => folderDb(dir, 'SELECT contract_no FROM contracts ORDER BY contract_no').map((r) => r.contract_no);
const indentNos = (dir) => folderDb(dir, 'SELECT indent_no FROM nocs ORDER BY indent_no').map((r) => r.indent_no);
const text = (page) => page.locator('body').innerText();

let passed = 0;
const check = async (name, fn) => {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

// The Android back button; canGoBack is what the WebView reports.
const back = (page, canGoBack = true) => page.evaluate((c) => window.__backButton({ canGoBack: c }), canGoBack);
// The app goes to the background for `ms` and comes back.
const away = (page, ms) =>
  page.evaluate((ms) => {
    const now = Date.now;
    const hidden = (h) => (Object.defineProperty(document, 'hidden', { configurable: true, get: () => h }), document.dispatchEvent(new Event('visibilitychange')));
    hidden(true);
    Date.now = () => now() + ms;
    hidden(false);
    Date.now = now;
  }, ms);
const lockBox = (page) => page.getByLabel('Lock with fingerprint or face');

async function addContract(page, no) {
  await page.goto(`${BASE}#/contracts?new=1`);
  const form = page.locator('.modal');
  await form.getByLabel('Contract No.').fill(no);
  await form.getByLabel('Amount').fill('1500');
  await form.getByRole('button', { name: 'Create contract' }).click();
}

try {
  console.log('Phone app checks (built bundle in Chromium, phone database in a worker, simulated Android folder)');

  await check('a WebView too old for the database shows "Update Android System WebView"', async () => {
    const page = await launch('old-webview', { oldWebView: true });
    await page.getByRole('heading', { name: 'Update Android System WebView' }).waitFor();
    await quit();
  });

  await check('first launch asks for All files access and writes nothing before a folder is set', async () => {
    const page = await launch('install-1');
    await page.getByText('Contract Desk keeps your records in a folder on the phone').waitFor();
    assert.ok(!fs.existsSync(DEFAULT_DIR));
    await page.getByRole('button', { name: 'Allow All files access' }).click();
    await page.locator('#q').waitFor(); // Search, the front door
    assert.ok(fs.existsSync(path.join(DEFAULT_DIR, 'contracts.db')) && fs.statSync(path.join(DEFAULT_DIR, 'files')).isDirectory());
  });

  await check('desktop-only parts are hidden; the data folder control is the phone one', async () => {
    const { page } = app;
    assert.equal(await page.getByText('Connect phone').count(), 0);
    assert.equal(await page.getByText('Export to Excel').count(), 0);
    await page.locator('.phone-folder').getByText(`${PHONE_ROOT}/Documents/Contract Desk`).waitFor();
    await page.getByRole('button', { name: 'Change folder…' }).waitFor();
  });

  await check('add a contract; ct-001 is refused as a duplicate of CT-001; the folder copy is saved ~2 s later', async () => {
    const { page } = app;
    await addContract(page, 'CT-001');
    await page.getByRole('heading', { name: 'CT-001' }).waitFor();
    await addContract(page, 'ct-001');
    await page.getByText('That Contract No. already exists').waitFor();
    await until(() => contractNos(DEFAULT_DIR).includes('CT-001'), 'CT-001 in the folder copy');
    assert.ok(!fs.existsSync(path.join(DEFAULT_DIR, 'contracts.db.tmp')));
    assert.equal(fs.readFileSync(path.join(DEFAULT_DIR, 'contracts.db'))[18], 1, 'folder copy is a plain (non-WAL) database');
  });

  await check('restart: the contract is still there, and nothing is re-saved when nothing changed', async () => {
    await quit();
    const before = fs.statSync(path.join(DEFAULT_DIR, 'contracts.db')).mtimeMs;
    device.calls = [];
    const page = await launch('install-1');
    await page.goto(`${BASE}#/contracts`);
    await page.getByText('CT-001').first().waitFor();
    assert.equal(fs.statSync(path.join(DEFAULT_DIR, 'contracts.db')).mtimeMs, before);
    assert.ok(!device.calls.includes('write'));
  });

  await check('storage: shows what the data folder uses and the free space; warns when the phone is nearly full', async () => {
    const { page } = app;
    await page.goto(BASE);
    const kb = (fs.statSync(path.join(DEFAULT_DIR, 'contracts.db')).size / 1024).toFixed(0); // no documents yet
    await page.getByText(`Uses ${kb} KB · 8.0 GB free on the phone`).waitFor();
    assert.equal(await page.getByText('The phone is nearly full').count(), 0);
    device.free = 300 * 1024 ** 2;
    await page.reload();
    await page.getByText('The phone is nearly full: only 300.0 MB free. Free up space before adding documents').waitFor();
    device.free = 8 * 1024 ** 3;
  });

  await check('Android back button: closes a dialog first, then goes back through screens; only Search exits the app', async () => {
    const { page } = app;
    await page.goto(BASE);
    await page.goto(`${BASE}#/contracts`);
    await page.getByRole('button', { name: 'New contract' }).click();
    await page.locator('.modal').waitFor();
    await back(page);
    await page.locator('.modal').waitFor({ state: 'detached' });
    assert.ok(page.url().endsWith('#/contracts'));
    await back(page);
    await page.locator('#q').waitFor();
    assert.ok(!device.exited);
    await page.goto(`${BASE}#/nocs`);
    await back(page, false); // nothing to go back to (e.g. right after start): Search
    await page.locator('#q').waitFor();
    assert.ok(!device.exited);
    await back(page);
    await until(() => device.exited, 'the app exits from Search');
    device.exited = false;
  });

  await check('fingerprint lock: off by default; turning it on asks for a fingerprint first', async () => {
    const { page } = app;
    await page.goto(BASE);
    assert.equal(await lockBox(page).isChecked(), false);
    device.bioFail = true; // a failed check leaves it off
    device.calls = [];
    await lockBox(page).click();
    await until(() => device.calls.includes('internalAuthenticate'), 'the fingerprint check');
    assert.equal(await lockBox(page).isChecked(), false);
    device.bioFail = false;
    await lockBox(page).click();
    await page.locator('.phone-lock input:checked').waitFor();
  });

  await check('fingerprint lock: asks on opening and after a while in the background; back exits; a half-filled form survives it', async () => {
    await quit();
    device.bioFail = true;
    const page = await launch('install-1');
    const lock = page.locator('.lock-screen');
    await page.getByRole('heading', { name: 'Contract Desk is locked' }).waitFor();
    await page.locator('#q').waitFor({ state: 'attached' }); // the desk opens underneath…
    assert.ok(await page.evaluate(() => !!document.elementFromPoint(200, 300).closest('.lock-screen')), '…but stays covered');
    await back(page);
    await until(() => device.exited, 'back on the lock screen exits');
    device.exited = false;
    device.bioFail = false;
    await page.getByRole('button', { name: 'Unlock' }).click();
    await lock.waitFor({ state: 'detached' });
    await page.goto(`${BASE}#/contracts?new=1`);
    await page.locator('.modal').getByLabel('Contract No.').fill('CT-HALF');
    await away(page, 10_000); // a short switch to another app: still open
    assert.equal(await lock.count(), 0);
    device.bioFail = true;
    await away(page, 4 * 60_000);
    await page.getByRole('heading', { name: 'Contract Desk is locked' }).waitFor();
    device.bioFail = false;
    await page.getByRole('button', { name: 'Unlock' }).click();
    await lock.waitFor({ state: 'detached' });
    assert.equal(await page.locator('.modal').getByLabel('Contract No.').inputValue(), 'CT-HALF');
    await back(page); // close the form unsaved
    await page.locator('.modal').waitFor({ state: 'detached' });
  });

  await check('fingerprint lock never locks the owner out: with no fingerprint, face or PIN left, the app opens; the switch explains why', async () => {
    await quit();
    device.bio = { isAvailable: false, deviceIsSecure: false };
    device.bioFail = true;
    const page = await launch('install-1'); // lock still on
    await page.locator('#q').waitFor();
    await page.getByText('Set a screen lock (PIN, pattern, fingerprint or face)').waitFor();
    await lockBox(page).click(); // can always be turned off
    assert.equal(await lockBox(page).isChecked(), false);
    assert.ok(await lockBox(page).isDisabled(), 'and can\'t be turned on without a screen lock');
    device.bio = { isAvailable: true, deviceIsSecure: true };
    device.bioFail = false;
  });

  await check('killed before the autosave: the next start saves the unsaved change to the folder', async () => {
    const { page } = app;
    await page.goto(`${BASE}#/nocs?new=1`);
    const form = page.locator('.modal');
    await form.getByLabel('Indent No.').fill('IND-7');
    await form.getByLabel('NOC Name').fill('Port clearance');
    await form.getByRole('button', { name: 'Create NOC' }).click();
    await page.getByRole('heading', { name: 'IND-7' }).waitFor();
    await quit(); // well inside the 2 s wait
    assert.ok(!indentNos(DEFAULT_DIR).includes('IND-7'));
    await launch('install-1');
    await until(() => indentNos(DEFAULT_DIR).includes('IND-7'), 'IND-7 saved at start-up');
    await quit();
  });

  // The app dies in the middle of a save while a newer change is waiting: that change must win at the next start.
  for (const [when, a, b] of [
    ['after replacing contracts.db, before noting it as saved', 'CT-A', 'CT-B'],
    ['after writing contracts.db.tmp, before the replace', 'CT-C', 'CT-D'],
  ]) {
    await check(`killed during a save (${when}): the change made meanwhile is kept`, async () => {
      const db = path.join(DEFAULT_DIR, 'contracts.db');
      const page = await launch('install-1');
      device.die = when.startsWith('after replacing') ? 'after' : 'before';
      device.hung = false;
      await addContract(page, a);
      await page.getByRole('heading', { name: a }).waitFor();
      await until(() => device.hung, 'the save reaching the replace', 15_000);
      await addContract(page, b);
      await page.getByRole('heading', { name: b }).waitFor();
      await quit();
      device.die = null;
      assert.ok(!contractNos(DEFAULT_DIR).includes(b));
      assert.equal(fs.existsSync(`${db}.tmp`), device.hung && when.startsWith('after writing'));
      const again = await launch('install-1');
      await until(() => contractNos(DEFAULT_DIR).includes(a) && contractNos(DEFAULT_DIR).includes(b), `${a} and ${b} both in the folder copy`);
      assert.ok(!fs.existsSync(`${db}.tmp`));
      await again.goto(`${BASE}#/contracts`);
      await again.getByText(b).waitFor();
      await quit();
    });
  }

  // A desktop data folder (desktop engine, WAL mode) with a contract, an NOC and documents, copied over the phone's folder.
  const desk = path.join(tmp, 'desktop');
  const deskDb = openDb(desk);
  const deskRules = createRules({ db: deskDb, files: { remove: () => {}, list: () => [], exists: () => true } });
  const fileFor = (name, bytes) => {
    const storage_name = storedName(name);
    fs.writeFileSync(path.join(desk, 'files', storage_name), bytes);
    return { original_name: name, storage_name, file_path: `files/${storage_name}`, size_bytes: bytes.length };
  };
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64');
  const deskC = deskRules.createContract({ contract_no: 'DESK-9', project_name: 'Harbor', firm_name: 'Northwind', amount: 10, currency: 'USD' });
  deskRules.addDocuments('contract', deskC.id, [fileFor('invoice.pdf', Buffer.from('%PDF-1.1 sample')), fileFor('scan.png', PNG)], JSON.stringify([{ category: 'Commercial Invoice', tags: ['Urgent'] }, { category: 'Packing List' }]));
  const deskN = deskRules.createNoc({ indent_no: 'IND-DESK', noc_name: 'Desk NOC' });
  deskRules.addDocuments('noc', deskN.id, [fileFor('noc.pdf', Buffer.from('%PDF-1.1 noc'))], '[]');
  deskDb.close();
  assert.equal(fs.readFileSync(path.join(desk, 'contracts.db'))[18], 2, 'desktop file is in WAL mode');

  await check('a folder made by the desktop app (WAL mode) opens on the phone', async () => {
    fs.rmSync(DEFAULT_DIR, { recursive: true });
    fs.cpSync(desk, DEFAULT_DIR, { recursive: true });
    const page = await launch('install-1');
    await page.goto(`${BASE}#/contracts/${deskC.id}`);
    await page.getByRole('heading', { name: 'DESK-9' }).waitFor();
    await page.getByText('invoice', { exact: true }).waitFor();
  });

  await check('Android back button closes the open document first; the next press leaves the record without re-opening it', async () => {
    const { page } = app;
    await page.getByRole('button', { name: 'scan', exact: true }).click();
    const drawer = page.getByRole('complementary', { name: 'Document' });
    await drawer.waitFor();
    await back(page);
    await drawer.waitFor({ state: 'detached' });
    await page.getByRole('heading', { name: 'DESK-9' }).waitFor();
    await back(page);
    await page.locator('#q').waitFor(); // where the record was opened from
    assert.equal(await drawer.count(), 0);
    await page.goto(`${BASE}#/contracts/${deskC.id}`);
  });

  await check('documents: rename, category, Reference No. and tags (Urgent = " urgent "); the image shows from the folder', async () => {
    const { page } = app;
    await page.getByRole('button', { name: 'scan', exact: true }).click();
    const drawer = page.getByRole('complementary', { name: 'Document' });
    await drawer.locator('.preview img').waitFor();
    assert.ok(await drawer.locator('.preview img').evaluate((img) => img.complete && img.naturalWidth === 2));
    await drawer.getByLabel('Display name').fill('Scan renamed');
    await drawer.getByLabel('Category').selectOption('Other Documents');
    await drawer.getByLabel('Reference No.').fill('REF-77');
    const tagInput = drawer.locator('.tag-input input');
    await tagInput.fill(' urgent ');
    await tagInput.press('Enter');
    await drawer.getByRole('button', { name: 'Save changes' }).click();
    await drawer.getByRole('button', { name: 'Saved' }).waitFor();
    await until(() => {
      const [d] = folderDb(DEFAULT_DIR, `SELECT d.display_name, d.category, d.reference_no, (SELECT group_concat(t.name) FROM document_tags dt JOIN tags t ON t.id = dt.tag_id WHERE dt.document_id = d.id) AS tags FROM documents d WHERE original_name = 'scan.png'`);
      return d.display_name === 'Scan renamed' && d.category === 'Other Documents' && d.reference_no === 'REF-77' && d.tags === 'Urgent';
    }, 'document edits in the folder copy, one "Urgent" tag');
  });

  await check('deleting a contract warns about its documents and removes their files from the folder', async () => {
    const { page } = app;
    await page.goto(`${BASE}#/contracts/${deskC.id}`);
    await page.locator('.record-head').getByRole('button', { name: 'Delete' }).click();
    await page.getByText('This also deletes all 2 attached documents').waitFor();
    await page.getByRole('button', { name: 'Delete contract and 2 documents' }).click();
    await page.waitForURL(/#\/contracts$/);
    await until(() => fs.readdirSync(path.join(DEFAULT_DIR, 'files')).length === 1, 'only the NOC file left');
    await until(() => !contractNos(DEFAULT_DIR).includes('DESK-9'), 'DESK-9 gone from the folder copy');
    await quit();
  });

  await check('start-up recovers a newer, healthy contracts.db.tmp left by a crash mid-save', async () => {
    const db = path.join(DEFAULT_DIR, 'contracts.db');
    fs.renameSync(db, `${db}.tmp`); // the picker-mode crash window: old file deleted, .tmp not yet renamed
    const page = await launch('install-1');
    await page.goto(`${BASE}#/nocs`);
    await page.getByText('IND-DESK').waitFor();
    assert.ok(fs.existsSync(db) && !fs.existsSync(`${db}.tmp`));
    await quit();
  });

  await check('start-up deletes a damaged contracts.db.tmp and keeps contracts.db', async () => {
    const db = path.join(DEFAULT_DIR, 'contracts.db');
    const before = fs.readFileSync(db);
    fs.writeFileSync(`${db}.tmp`, before.subarray(0, 5000)); // half-written
    const page = await launch('install-1');
    await page.goto(`${BASE}#/nocs`);
    await page.getByText('IND-DESK').waitFor();
    assert.ok(!fs.existsSync(`${db}.tmp`));
    assert.deepEqual(fs.readFileSync(db), before);
    await quit();
  });

  await check('the phone folder opens on the desktop', async () => {
    const d = openDb(DEFAULT_DIR); // desktop engine, read-write, switches it to WAL as usual
    assert.equal(d.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(d.prepare('SELECT indent_no FROM nocs ORDER BY indent_no').all().map((r) => r.indent_no), ['IND-DESK']); // IND-7 went when the desktop folder replaced the phone's (the folder copy wins)
    d.close();
  });

  await check('reinstall with All files access already on: the records open by themselves', async () => {
    device.access = true;
    const page = await launch('install-2'); // new profile = empty phone database
    await page.goto(`${BASE}#/nocs`);
    await page.getByText('IND-DESK').waitFor();
    await quit();
  });

  await check('permission refused after reinstall: picking the folder with the system picker opens the records, and saving works', async () => {
    device.access = false;
    device.grantOnRequest = false;
    const page = await launch('install-3');
    await page.getByText('Allow ‘All files access’, or choose a folder.').waitFor();
    device.pick = { uri: treeOf('Documents/Contract Desk'), path: `${PHONE_ROOT}/Documents/Contract Desk` };
    await page.getByRole('button', { name: 'Choose folder' }).click();
    await page.locator('#q').waitFor();
    await addContract(page, 'CT-PICK');
    await page.getByRole('heading', { name: 'CT-PICK' }).waitFor();
    await until(() => contractNos(DEFAULT_DIR).includes('CT-PICK'), 'CT-PICK saved through the picker link');
    assert.deepEqual(indentNos(DEFAULT_DIR), ['IND-DESK']); // IND-7 went when the desktop folder replaced the phone's (the folder copy wins)
  });

  await check('choose an empty folder: "Move my records here?" copies the records and files; the old folder stays', async () => {
    const { page } = app;
    const moved = path.join(storage, 'Documents', 'Moved');
    fs.mkdirSync(moved, { recursive: true });
    const oldFiles = fs.readdirSync(path.join(DEFAULT_DIR, 'files'));
    device.pick = { uri: treeOf('Documents/Moved'), path: `${PHONE_ROOT}/Documents/Moved` };
    await page.goto(BASE);
    await page.getByRole('button', { name: 'Change folder…' }).click();
    await page.locator('.phone-folder').getByText(`${PHONE_ROOT}/Documents/Moved`).waitFor();
    assert.deepEqual(contractNos(moved), ['CT-PICK']);
    assert.deepEqual(fs.readdirSync(path.join(moved, 'files')), oldFiles);
    assert.deepEqual(contractNos(DEFAULT_DIR), ['CT-PICK']);
  });

  await check('choose a folder that already has records: "Open the records in this folder?" opens them', async () => {
    const { page } = app;
    fs.rmSync(DEFAULT_DIR, { recursive: true });
    fs.cpSync(desk, DEFAULT_DIR, { recursive: true }); // DESK-9 and IND-DESK, made on the desktop
    device.pick = { uri: treeOf('Documents/Contract Desk'), path: `${PHONE_ROOT}/Documents/Contract Desk` };
    await page.getByRole('button', { name: 'Change folder…' }).click();
    await page.locator('.phone-folder').getByText(`${PHONE_ROOT}/Documents/Contract Desk`).waitFor();
    await page.goto(`${BASE}#/contracts`);
    await page.getByText('DESK-9').waitFor();
    assert.equal(await page.getByText('CT-PICK').count(), 0);
    assert.deepEqual(contractNos(path.join(storage, 'Documents', 'Moved')), ['CT-PICK'], 'the previous folder keeps its records');
    await quit();
  });

  await check('a folder still open on a computer (unmerged contracts.db-wal) is refused, not opened half-way', async () => {
    device.access = true;
    fs.writeFileSync(path.join(DEFAULT_DIR, 'contracts.db-wal'), 'pending desktop changes');
    const before = fs.readFileSync(path.join(DEFAULT_DIR, 'contracts.db'));
    const page = await launch('install-4');
    await page.getByText('still open in Contract Desk on a computer').waitFor();
    assert.deepEqual(fs.readFileSync(path.join(DEFAULT_DIR, 'contracts.db')), before);
    await quit();
  });

  await check('with All files access, a reinstall opens the folder the owner chose, not the default one', async () => {
    fs.rmSync(path.join(DEFAULT_DIR, 'contracts.db-wal'));
    device.access = true;
    const moved = `${PHONE_ROOT}/Documents/Moved`;
    const page = await launch('install-5');
    await page.locator('.phone-folder').getByText(`${PHONE_ROOT}/Documents/Contract Desk`).waitFor();
    device.pick = { uri: treeOf('Documents/Moved'), path: moved };
    await page.getByRole('button', { name: 'Change folder…' }).click(); // it has records: "Open the records…?" is accepted
    await page.locator('.phone-folder').getByText(moved).waitFor();
    assert.equal(fs.readFileSync(path.join(storage, 'Documents', '.contract-desk-folder'), 'utf8'), moved);
    await quit();
    const again = await launch('install-6'); // uninstall + reinstall
    await again.locator('.phone-folder').getByText(moved).waitFor();
    await again.goto(`${BASE}#/contracts`);
    await again.getByText('CT-PICK').waitFor();
    await quit();
  });

  await check('a folder picked while All files access was off is the one a later reinstall opens', async () => {
    const pointer = () => fs.readFileSync(path.join(storage, 'Documents', '.contract-desk-folder'), 'utf8');
    const x = `${PHONE_ROOT}/Documents/Moved`; // in use from the check above (access on)
    const y = `${PHONE_ROOT}/Documents/Contract Desk`;
    assert.equal(pointer(), x);
    device.access = false; // the owner turns All files access off: the app asks again
    const page = await launch('install-6');
    await page.getByText('All files access is off.').waitFor();
    device.pick = { uri: treeOf('Documents/Contract Desk'), path: y };
    await page.getByRole('button', { name: 'Choose folder' }).click(); // picker link; "Open the records…?" accepted
    await page.locator('.phone-folder').getByText(y).waitFor();
    assert.equal(pointer(), x, 'without access the note cannot be updated yet');
    await quit();
    device.access = true; // the owner turns All files access on
    await launch('install-6');
    await until(() => pointer() === y, 'note updated to the picked folder');
    await quit();
    const again = await launch('install-7'); // uninstall + reinstall
    await again.locator('.phone-folder').getByText(y).waitFor();
    await quit();
  });

  assert.deepEqual(errors, [], 'no page errors');
  console.log(`\nAll ${passed} phone checks passed.`);
} finally {
  if (app) await app.context.close();
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
