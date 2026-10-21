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
import { randomBytes, randomUUID } from 'node:crypto';
import { openDb } from '../server/db.js';
import { createRules, storedName } from '../core/rules.js';
import { callRoute } from '../core/routes.js';
import { DEFAULT_CATEGORIES, tx } from '../core/schema.js';
import { exportWorkbook } from '../core/export.js';
import ExcelJS from 'exceljs';

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
// writes: pieces written to files/; failWrite: the n-th next write to files/ fails (phone storage full); opened/shared:
// what the phone's own apps were handed.
const device = { access: false, grantOnRequest: true, pick: null, calls: [], die: null, hung: false, free: 8 * 1024 ** 3, bio: { isAvailable: true, deviceIsSecure: true },
  bioFail: false, exited: false, writes: [], failWrite: 0, opened: null, shared: null, slow: 0 };
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
// A file:// or picker content:// link (as phone.js builds them) -> file on disk.
function uriFile(src) {
  if (!src.startsWith('content://')) return disk(decodeURIComponent(src.replace('file://', '')));
  const [tree, doc] = src.split('/document/');
  return disk(tree, decodeURIComponent(doc).slice(decodeURIComponent(tree.split('/tree/')[1]).length + 1));
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
  write: ({ folder, name, data, append }) => {
    const bytes = Buffer.from(data, 'base64');
    assert.ok(bytes.length <= 4 * 1024 * 1024, `a ${bytes.length}-byte write: big writes crash the app (decision-1)`);
    if (name.startsWith('files/')) {
      if (device.failWrite && !--device.failWrite) throw new Error('No space left on device');
      device.writes.push({ folder, name, size: bytes.length, append });
    }
    (append ? fs.appendFileSync : fs.writeFileSync)(disk(folder, name), bytes);
  },
  rename: ({ folder, from, to }) => {
    if (device.die === 'before' && to === 'contracts.db') return hang();
    fs.renameSync(disk(folder, from), disk(folder, to));
    if (device.die === 'after' && to === 'contracts.db') return hang();
  },
  remove: ({ folder, name }) => fs.rmSync(disk(folder, name), { force: true }),
  list: ({ folder, dir }) => ({ names: fs.existsSync(disk(folder, dir)) ? fs.readdirSync(disk(folder, dir)) : [] }),
  copy: ({ from, to, name }) => (fs.copyFileSync(disk(from, name), disk(to, name)), { bytes: fs.statSync(disk(to, name)).size }),
  cacheFolder: () => (fs.mkdirSync(disk(`${PHONE_ROOT}/app-cache`), { recursive: true }), { path: `${PHONE_ROOT}/app-cache` }), // really under /data/user/0
  freeSpace: () => ({ free: device.free }),
  clearCaptures: () => {}, // deletes the camera's own copies of photos (Android/data/.../files/Pictures)
  // BiometricAuthNative (@aparajita/capacitor-biometric-auth) and App (@capacitor/app)
  checkBiometry: () => device.bio,
  internalAuthenticate: () => {
    if (device.bioFail) throw new Error('Authentication failed');
  },
  exitApp: () => void (device.exited = true),
  saveToDownloads: ({ folder, name, as }) => {
    fs.mkdirSync(path.join(storage, 'Download'), { recursive: true });
    fs.copyFileSync(disk(folder, name), path.join(storage, 'Download', as));
    return { name: as };
  },
  share: ({ folder, name, as, mime }) => void (device.shared = { folder, bytes: fs.readFileSync(disk(folder, name)), as, mime }),
};
// @capacitor-community/file-opener: hands the file to the phone's own app.
const fileOpener = { open: ({ filePath, contentType }) => void (device.opened = { filePath, bytes: fs.readFileSync(uriFile(filePath)), contentType }) };

// Serves the bundle, plus phone files at the URL the fake convertFileSrc gives (the WebView's file server on Android).
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = url.startsWith('/__folder__/') ? uriFile(url.slice('/__folder__/'.length)) : path.join(dist, url === '/' ? 'index.html' : url);
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
  await context.exposeBinding('__native', async (src, name, method, opts) => {
    device.calls.push(method);
    const result = (await (name === 'FileOpener' ? fileOpener : plugin)[method](opts)) ?? {};
    if (device.slow) await new Promise((r) => setTimeout(r, device.slow)); // a slow phone, so the progress bar can be seen
    return result;
  });
  await context.addInitScript(() => {
    window.Capacitor = {
      isNativePlatform: () => true,
      convertFileSrc: (u) => `/__folder__/${encodeURIComponent(u)}`,
      nativePromise: (name, method, opts) => window.__native(name, method, opts),
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

// A desktop data folder the size of decision-2's realistic database: 3,000 contracts, 300 NOCs, 10,000 documents,
// 20,000 tag links. Distinct times, so every list has one right order.
function seedBig(dir) {
  const d = openDb(dir);
  const projects = ['Port Expansion', 'Solar Farm', 'Metro Line', 'Water Works', 'Grid Upgrade', 'Harbor Wall'];
  const firms = ['Northwind', 'Harbor Freight', 'Abacus Trading', 'Contoso', 'Fabrikam'];
  const currencies = ['USD', 'EUR', 'PKR', 'AED'];
  const kinds = ['Invoice', 'Packing list', 'Bill of lading', 'Bank slip', 'Declaration'];
  const types = [['pdf', 'application/pdf', 'pdf'], ['image', 'image/png', 'png'], ['excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx']];
  const at = (n) => new Date(Date.UTC(2026, 0, 1) + n * 60_000).toISOString();
  tx(d, () => {
    const c = d.prepare('INSERT INTO contracts (id, contract_no, project_name, firm_name, amount, currency, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (let i = 1; i <= 3000; i++) c.run(i, `CT-${i}`, projects[i % 6], firms[i % 5], (i * 137.25) % 100_000, currencies[i % 4], at(i), at((i * 7) % 3001));
    const n = d.prepare('INSERT INTO nocs (id, indent_no, noc_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
    for (let i = 1; i <= 300; i++) n.run(i, `IND-${i}`, `NOC ${projects[i % 6]}`, at(i), at((i * 7) % 307));
    ['Urgent', 'Original', 'Copy', 'Signed', 'Pending'].forEach((name, i) => d.prepare('INSERT INTO tags (id, name, key) VALUES (?, ?, ?)').run(i + 1, name, name.toLowerCase()));
    const doc = d.prepare(`INSERT INTO documents (id, contract_id, noc_id, display_name, original_name, storage_name, file_path, mime_type, file_type,
      size_bytes, category, reference_no, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const link = d.prepare('INSERT INTO document_tags (document_id, tag_id) VALUES (?, ?)');
    for (let k = 1; k <= 10_000; k++) {
      const [type, mime, ext] = types[k % 3];
      const stored = `00000000-0000-4000-8000-${String(k).padStart(12, '0')}.${ext}`;
      const noc = k > 9700;
      doc.run(k, noc ? null : (k % 3000) + 1, noc ? (k % 300) + 1 : null, `${kinds[k % 5]} ${k}`, `scan-${k}.${ext}`, stored, `files/${stored}`, mime, type,
        k * 10, noc ? null : DEFAULT_CATEGORIES[k % 6], k % 2 ? `INV-2026-${k}` : null, at(k));
      link.run(k, (k % 5) + 1);
      link.run(k, ((k + 2) % 5) + 1);
    }
  });
  d.close(); // merges the WAL: one complete contracts.db, ready to copy to the phone
}

// Asks the app's real database worker directly, with the same message phone.js sends, and times the answer inside the
// worker (the test catches the reply before phone.js sees it).
const ask = (page, url) =>
  page
    .workers()
    .find((w) => w.url().includes('phone-worker'))
    .evaluate(
      (url) =>
        new Promise((resolve) => {
          const post = self.postMessage;
          const t0 = performance.now();
          self.postMessage = (msg, transfer) => {
            if (msg.id !== 'test') return post.call(self, msg, transfer);
            self.postMessage = post;
            resolve({ ...msg.result, ms: performance.now() - t0 });
          };
          self.onmessage({ data: { id: 'test', op: 'request', method: 'GET', url } });
        }),
      url,
    );
const sheets = async (bytes) => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes);
  return wb.worksheets.map((ws) => ({ name: ws.name, rows: JSON.parse(JSON.stringify(ws.getSheetValues())) }));
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

  await check('desktop-only parts are hidden; Excel export and the data folder control are the phone ones', async () => {
    const { page } = app;
    assert.equal(await page.getByText('Connect phone').count(), 0);
    assert.equal(await page.getByRole('link', { name: /Export to Excel/ }).count(), 0); // no download link: Open and Share buttons
    await page.getByRole('button', { name: 'Open Excel' }).waitFor();
    await page.getByRole('button', { name: 'Share Excel export' }).waitFor();
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
    // the same warning in the upload dialog
    await page.goto(`${BASE}#/contracts`);
    await page.getByText('CT-001').first().click();
    await page.locator('.page-actions').getByRole('button', { name: 'Add documents' }).click();
    await page.locator('.modal').getByText('The phone is nearly full: only 300.0 MB free. Free up space before adding documents').waitFor();
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
    device.calls = [];
    const page = await launch('install-1');
    const lock = page.locator('.lock-screen');
    await page.getByRole('heading', { name: 'Contract Desk is locked' }).waitFor();
    // The lock screen asks by itself as soon as it shows. Only once that ask has reached the phone (and failed) may the
    // fingerprint start matching, or that first ask unlocks and there is no Unlock button left to press.
    await until(() => device.calls.includes('internalAuthenticate'), 'the lock screen asks for a fingerprint by itself');
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
    device.calls = [];
    await away(page, 4 * 60_000);
    await page.getByRole('heading', { name: 'Contract Desk is locked' }).waitFor();
    await until(() => device.calls.includes('internalAuthenticate'), 'the lock screen asks again by itself'); // see above
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

  // ---------- documents on the phone (TASK-3) ----------

  const up = path.join(tmp, 'uploads'); // files on the "phone" to upload
  fs.mkdirSync(up);
  const src = (name, bytes) => (fs.writeFileSync(path.join(up, name), bytes), path.join(up, name));
  const PIECE = 4 * 1024 * 1024;
  const sources = [
    ...Array.from({ length: 6 }, (_, i) => src(`contract-${i + 1}.pdf`, Buffer.from(`%PDF-1.4 contract ${i + 1}`))),
    src('scan-big.pdf', randomBytes(2 * PIECE + 12345)), // three pieces
    ...Array.from({ length: 7 }, (_, i) => src(`photo-${i + 1}.png`, PNG)),
    ...Array.from({ length: 5 }, (_, i) => src(`sheet-${i + 1}.xlsx`, randomBytes(3000 + i))),
    src('list.csv', 'a,b\n1,2\n'),
  ];
  const filesDir = path.join(DEFAULT_DIR, 'files');
  const docsOf = (no) =>
    folderDb(DEFAULT_DIR, `SELECT d.* FROM documents d JOIN contracts c ON c.id = d.contract_id WHERE c.contract_no = '${no}' ORDER BY d.id`);
  const modal = (page) => page.locator('.modal');
  const openUpload = async (page) => {
    await page.locator('.page-actions').getByRole('button', { name: 'Add documents' }).click();
    await modal(page).locator('.dropzone input[type=file]').waitFor({ state: 'attached' });
  };
  const drawer = (page) => page.getByRole('complementary', { name: 'Document' });
  const openDrawer = async (page, name) => {
    if (await drawer(page).count()) await drawer(page).getByRole('button', { name: 'Close document' }).click();
    await page.getByRole('button', { name, exact: true }).first().click();
    return drawer(page);
  };
  let upId;

  await check('upload 20 mixed files (PDF, image, Excel) with category, Reference No. and tags; written in 4 MB pieces, with progress', async () => {
    const page = await launch('install-1');
    await addContract(page, 'CT-UP');
    await page.getByRole('heading', { name: 'CT-UP' }).waitFor();
    await openUpload(page);
    await modal(page).locator('.dropzone input[type=file]').setInputFiles(sources);
    await modal(page).locator('.apply-all select').selectOption('Commercial Invoice');
    const first = modal(page).locator('.stage-row').first();
    await first.getByLabel('Category').selectOption('Packing List');
    await first.getByLabel('Reference No.').fill('INV-UP-1');
    await first.locator('.tag-input input').fill('Urgent');
    await first.locator('.tag-input input').press('Enter');
    device.writes = [];
    device.slow = 60;
    await modal(page).getByRole('button', { name: 'Upload 20 files' }).click();
    await modal(page).getByRole('button', { name: /Uploading \d+%/ }).waitFor();
    await modal(page).waitFor({ state: 'detached', timeout: 20_000 });
    device.slow = 0;
    await until(() => docsOf('CT-UP').length === 20, '20 documents in the folder copy');
    const docs = docsOf('CT-UP');
    upId = docs[0].contract_id;
    for (const d of docs) {
      assert.match(d.storage_name, /^[0-9a-f-]{36}\.(pdf|png|xlsx|csv)$/);
      assert.equal(d.file_path, `files/${d.storage_name}`);
      assert.deepEqual(fs.readFileSync(path.join(DEFAULT_DIR, d.file_path)), fs.readFileSync(path.join(up, d.original_name)), d.original_name);
    }
    assert.deepEqual(docs.map((d) => d.file_type).sort(), [...Array(6).fill('excel'), ...Array(7).fill('image'), ...Array(7).fill('pdf')]);
    const [one] = folderDb(DEFAULT_DIR, `SELECT d.category, d.reference_no, (SELECT group_concat(t.name) FROM document_tags dt JOIN tags t ON t.id = dt.tag_id WHERE dt.document_id = d.id) AS tags FROM documents d WHERE original_name = 'contract-1.pdf'`);
    assert.deepEqual({ ...one }, { category: 'Packing List', reference_no: 'INV-UP-1', tags: 'Urgent' });
    assert.equal(docs.filter((d) => d.category === 'Commercial Invoice').length, 19);
    const big = docs.find((d) => d.original_name === 'scan-big.pdf');
    const pieces = device.writes.filter((w) => w.name === big.file_path);
    assert.deepEqual(pieces.map((w) => [w.size, w.append]), [[PIECE, false], [PIECE, true], [12345, true]]);
    assert.ok(device.writes.every((w) => w.size <= PIECE));
  });

  await check('images preview inside the app; PDFs and Excel open in the phone\'s own apps; save to Downloads and share', async () => {
    const { page } = app;
    const stored = (name) => docsOf('CT-UP').find((d) => d.original_name === name);
    await page.goto(`${BASE}#/contracts/${upId}`);
    let d = await openDrawer(page, 'photo-3');
    assert.ok(await d.locator('.preview img').evaluate(async (img) => (await img.decode(), img.naturalWidth === 2)));

    d = await openDrawer(page, 'contract-2');
    await d.getByRole('button', { name: 'Open PDF' }).click();
    await until(() => device.opened, 'PDF handed to the phone');
    assert.equal(device.opened.contentType, 'application/pdf');
    assert.equal(device.opened.filePath, `file://${PHONE_ROOT}/Documents/Contract%20Desk/${stored('contract-2.pdf').file_path}`);
    assert.deepEqual(device.opened.bytes, fs.readFileSync(path.join(up, 'contract-2.pdf')));

    await d.getByRole('button', { name: 'Save to Downloads' }).click();
    await d.getByText('Saved to Downloads as contract-2.pdf').waitFor();
    assert.deepEqual(fs.readFileSync(path.join(storage, 'Download', 'contract-2.pdf')), fs.readFileSync(path.join(up, 'contract-2.pdf')));
    await d.getByRole('button', { name: 'Share' }).click();
    await until(() => device.shared, 'shared');
    assert.equal(device.shared.as, 'contract-2.pdf');
    assert.equal(device.shared.mime, 'application/pdf');
    assert.deepEqual(device.shared.bytes, fs.readFileSync(path.join(up, 'contract-2.pdf')));

    device.opened = null;
    d = await openDrawer(page, 'sheet-4');
    await d.getByRole('button', { name: 'Open XLSX' }).click();
    await until(() => device.opened, 'spreadsheet handed to the phone');
    assert.equal(device.opened.contentType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    assert.deepEqual(device.opened.bytes, fs.readFileSync(path.join(up, 'sheet-4.xlsx')));
    await d.getByRole('button', { name: 'Close document' }).click();
  });

  await check('"Take photo" in the upload dialog opens the camera (capture input), and the photo is filed as a document', async () => {
    const { page } = app;
    await openUpload(page);
    await modal(page).getByRole('button', { name: 'Take photo' }).waitFor();
    const camera = modal(page).locator('input[capture]');
    assert.equal(await camera.getAttribute('accept'), 'image/*');
    assert.equal(await camera.getAttribute('capture'), 'environment');
    const shot = 'JPEG_20261021_161350_3021510589735462447.jpg'; // the name Capacitor gives a camera photo (seen on the S24+)
    await camera.setInputFiles(src(shot, PNG));
    await modal(page).locator('.apply-all select').selectOption('Other Documents');
    device.calls = [];
    await modal(page).getByRole('button', { name: 'Upload 1 file' }).click();
    await modal(page).waitFor({ state: 'detached' });
    await until(() => docsOf('CT-UP').some((d) => d.original_name === shot && d.file_type === 'image'), 'the photo filed');
    await until(() => device.calls.includes('clearCaptures'), 'the camera\'s own copy removed once the photo is saved');
    // Its long unbroken name must wrap: on the phone it widened the whole page, so every screen and dialog slid sideways.
    await page.locator('.doc-name', { hasText: shot.slice(0, -4) }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0, 'page wider than the screen');
  });

  await check('a file over 500 MB gets a clear message, and nothing is written', async () => {
    const { page } = app;
    const huge = path.join(up, 'huge.pdf');
    fs.closeSync(fs.openSync(huge, 'w'));
    fs.truncateSync(huge, 501 * 1024 * 1024); // sparse: takes no disk space
    const before = fs.readdirSync(filesDir).sort();
    device.writes = [];
    await openUpload(page);
    await modal(page).locator('.dropzone input[type=file]').setInputFiles([sources[0], huge]);
    await modal(page).locator('.apply-all select').selectOption('Other Documents');
    await modal(page).getByRole('button', { name: 'Upload 2 files' }).click();
    await modal(page).getByText('"huge.pdf" is 501 MB; one file can be at most 500 MB. Nothing was saved').waitFor();
    assert.equal(device.writes.length, 0);
    assert.deepEqual(fs.readdirSync(filesDir).sort(), before);
    await modal(page).getByRole('button', { name: 'Cancel' }).click();
  });

  await check('a failed upload leaves no record and no stray file (phone storage full; a file type the rules refuse)', async () => {
    const { page } = app;
    const before = fs.readdirSync(filesDir).sort();
    const count = docsOf('CT-UP').length;
    for (const [files, failWrite, message] of [
      [[sources[0], sources[6]], 3, 'Could not save "scan-big.pdf"'], // the 2nd piece of the 2nd file fails
      [[sources[1], src('notes.txt', 'hello')], 0, '"notes.txt" is not a PDF, image or Excel file'],
    ]) {
      await openUpload(page);
      await modal(page).locator('.dropzone input[type=file]').setInputFiles(files);
      await modal(page).locator('.apply-all select').selectOption('Other Documents');
      device.failWrite = failWrite;
      await modal(page).getByRole('button', { name: 'Upload 2 files' }).click();
      await modal(page).getByText(message).waitFor();
      await modal(page).getByText('Nothing was saved').waitFor();
      device.failWrite = 0;
      await until(() => JSON.stringify(fs.readdirSync(filesDir).sort()) === JSON.stringify(before), 'no stray files left');
      await modal(page).getByRole('button', { name: 'Cancel' }).click();
    }
    await page.reload();
    await page.getByRole('heading', { name: 'CT-UP' }).waitFor();
    assert.equal(await page.locator('.doc-row').count(), count);
    assert.equal(docsOf('CT-UP').length, count);
  });

  await check('deleting one document removes only its file; the others stay intact', async () => {
    const { page } = app;
    const docs = docsOf('CT-UP');
    const gone = docs.find((d) => d.original_name === 'contract-3.pdf');
    const others = Object.fromEntries(fs.readdirSync(filesDir).filter((n) => n !== gone.storage_name).map((n) => [n, fs.readFileSync(path.join(filesDir, n))]));
    const d = await openDrawer(page, 'contract-3');
    await d.getByRole('button', { name: 'Delete' }).click();
    await page.locator('.modal').getByRole('button', { name: 'Delete' }).click();
    await until(() => !fs.existsSync(path.join(filesDir, gone.storage_name)), 'its file removed');
    await until(() => docsOf('CT-UP').length === docs.length - 1, 'its record removed from the folder copy');
    assert.deepEqual(Object.fromEntries(fs.readdirSync(filesDir).map((n) => [n, fs.readFileSync(path.join(filesDir, n))])), others);
    // a delete from the search screen's drawer updates its storage line (8 MB less)
    await page.goto(`${BASE}#/?q=scan-big`);
    const was = await page.locator('.phone-space').innerText();
    const big = await openDrawer(page, 'scan-big');
    await big.getByRole('button', { name: 'Delete' }).click();
    await page.locator('.modal').getByRole('button', { name: 'Delete' }).click();
    await page.waitForFunction((was) => document.querySelector('.phone-space')?.innerText !== was, was);
    await quit();
  });

  await check('on start, files no record points to are removed (only names the app makes); the owner\'s own files stay', async () => {
    const stray = path.join(filesDir, `${randomUUID()}.pdf`); // e.g. left by a crash mid-upload
    const own = path.join(filesDir, 'my notes.pdf');
    fs.writeFileSync(stray, 'half an upload');
    fs.writeFileSync(own, 'mine');
    const page = await launch('install-1');
    await page.locator('#q').waitFor();
    await until(() => !fs.existsSync(stray), 'stray file removed');
    assert.ok(fs.existsSync(own));
    fs.rmSync(own);
    // Tidy up for the checks below: deleting the contract removes all its files.
    await page.goto(`${BASE}#/contracts/${upId}`);
    await page.locator('.record-head').getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('button', { name: /^Delete contract and \d+ documents$/ }).click();
    await page.waitForURL(/#\/contracts$/);
    await until(() => fs.readdirSync(filesDir).length === 1 && !contractNos(DEFAULT_DIR).includes('CT-UP'), 'CT-UP and its files gone');
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

  await check('picker mode: upload in 4 MB pieces through the picker link; image preview, open PDF, save and share work', async () => {
    const { page } = app;
    const tree = treeOf('Documents/Contract Desk');
    await openUpload(page);
    await modal(page).locator('.dropzone input[type=file]').setInputFiles([sources[6], sources[7]]); // scan-big.pdf, photo-1.png
    await modal(page).locator('.apply-all select').selectOption('Other Documents');
    device.writes = [];
    await modal(page).getByRole('button', { name: 'Upload 2 files' }).click();
    await modal(page).waitFor({ state: 'detached' });
    await until(() => docsOf('CT-PICK').length === 2, 'both in the folder copy');
    const [pdf, png] = docsOf('CT-PICK');
    assert.deepEqual(device.writes.map((w) => [w.name, w.size]), [[pdf.file_path, PIECE], [pdf.file_path, PIECE], [pdf.file_path, 12345], [png.file_path, PNG.length]]);
    assert.deepEqual(fs.readFileSync(path.join(DEFAULT_DIR, pdf.file_path)), fs.readFileSync(sources[6]));
    let d = await openDrawer(page, 'photo-1');
    assert.ok(await d.locator('.preview img').evaluate(async (img) => (await img.decode(), img.naturalWidth === 2)));
    assert.ok((await d.locator('.preview img').getAttribute('src')).includes(encodeURIComponent(`${tree}/document/`)));
    device.opened = device.shared = null;
    d = await openDrawer(page, 'scan-big');
    await d.getByRole('button', { name: 'Open PDF' }).click();
    await until(() => device.opened, 'PDF handed to the phone');
    assert.equal(device.opened.filePath, `${tree}/document/${encodeURIComponent(`primary:Documents/Contract Desk/${pdf.file_path}`)}`);
    assert.deepEqual(device.opened.bytes, fs.readFileSync(sources[6]));
    await d.getByRole('button', { name: 'Save to Downloads' }).click();
    await d.getByText('Saved to Downloads as scan-big.pdf').waitFor();
    await d.getByRole('button', { name: 'Share' }).click();
    await until(() => device.shared?.as === 'scan-big.pdf', 'shared');
    assert.ok(device.writes.every((w) => w.folder === tree) && device.shared.folder === tree, 'all through the picker link');
    await d.getByRole('button', { name: 'Close document' }).click();
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

  // ---------- search, filters, paging and Excel export on 3,000 contracts (TASK-4) ----------

  // The same folder is opened by the phone and by the desktop rules; every answer must match exactly.
  const big = path.join(tmp, 'desktop-3000');
  seedBig(big);
  fs.rmSync(DEFAULT_DIR, { recursive: true });
  fs.cpSync(big, DEFAULT_DIR, { recursive: true });
  const bigRules = createRules({ db: openDb(big), files: { remove: () => {}, list: () => [], exists: () => true } });
  const onDesktop = (url) => JSON.parse(JSON.stringify(callRoute(bigRules, 'GET', url)));
  const phoneSays = async (page, url) => {
    const { ms, ...r } = await ask(page, url);
    return r;
  };
  const lists = ['contracts', 'nocs', 'documents'];
  // As the search screen asks: page_size=10.
  const searchUrl = (list, query) => `/api/${list}?${new URLSearchParams({ ...query, page_size: 10, page: 1 })}`;

  await check('search: same results in the same order as the desktop, exact matches first (3,000 contracts, 10,000 documents)', async () => {
    device.access = true;
    const page = await launch('install-8'); // new install: opens the folder copy
    await page.locator('.phone-folder').waitFor();
    for (const q of ['CT-30', 'ct-30', 'INV-2026-31', 'IND-12', 'harbor', 'urgent', 'ab', 'V-2026', 'Packing list 42']) {
      for (const list of lists) {
        const url = searchUrl(list, { q });
        assert.deepEqual(await phoneSays(page, url), onDesktop(url), url);
      }
    }
    const first = async (list, q) => (await phoneSays(page, searchUrl(list, { q }))).data;
    for (const [list, q, field, want] of [
      ['contracts', 'CT-30', 'contract_no', 'CT-30'],
      ['contracts', 'ct-30', 'contract_no', 'CT-30'],
      ['documents', 'INV-2026-31', 'reference_no', 'INV-2026-31'],
      ['nocs', 'IND-12', 'indent_no', 'IND-12'],
    ]) {
      const d = await first(list, q);
      assert.ok(d.total > 1, `${q}: more than the exact match`);
      assert.equal(d.items[0][field], want, `${q}: exact match first`);
      assert.equal(d.items[0].rank, 0);
      assert.ok(d.items.slice(1).every((x) => x.rank > 0));
    }
  });

  await check('every filter (project, firm, category, file type, tag, amount range, currency) narrows the same way as the desktop', async () => {
    const { page } = app;
    const all = await Promise.all(lists.map(async (l) => (await phoneSays(page, searchUrl(l, {}))).data.total));
    for (const query of [
      { project: 'Solar Farm' },
      { firm: 'Contoso' },
      { category: 'Packing List' },
      { file_type: 'image' },
      { tag: 'Signed' },
      { tag: ' SIGNED ' },
      { min: '1000', max: '5000' },
      { min: '99000' },
      { currency: 'EUR' },
      { q: 'CT-1', currency: 'usd', category: 'Commercial Invoice', tag: 'Urgent', file_type: 'image' },
    ]) {
      const totals = [];
      for (const list of lists) {
        const url = searchUrl(list, query);
        const r = await phoneSays(page, url);
        assert.deepEqual(r, onDesktop(url), url);
        totals.push(r.data.total);
      }
      assert.ok(totals.some((t) => t > 0) && totals.some((t, i) => t < all[i]), `${JSON.stringify(query)} narrows the results`);
    }
  });

  await check('long result lists page correctly: every page as on the desktop, each record once', async () => {
    const { page } = app;
    for (const base of ['/api/documents?tag=Urgent', '/api/contracts?q=CT-1', '/api/nocs?q=IND']) {
      const { total, pages } = onDesktop(`${base}&page_size=200`).data;
      assert.ok(pages > 1, base);
      const ids = [];
      for (let p = 1; p <= pages; p++) {
        const url = `${base}&page_size=200&page=${p}`;
        const r = await phoneSays(page, url);
        assert.deepEqual(r, onDesktop(url), url);
        ids.push(...r.data.items.map((x) => x.id));
      }
      assert.equal(ids.length, total);
      assert.equal(new Set(ids).size, total);
    }
  });

  await check('search screen: Next shows the second page; a result opens its contract, a document opens its NOC or contract', async () => {
    const { page } = app;
    await page.goto(`${BASE}#/?q=CT-30`);
    const section = page.locator('.result-section').filter({ has: page.locator('.section-label', { hasText: 'Contracts' }) });
    const p2 = onDesktop(`/api/contracts?q=CT-30&page_size=10&page=2`).data;
    await section.getByRole('button', { name: 'Next' }).click();
    await section.getByText(`11–${Math.min(20, p2.total)} of ${p2.total}`).waitFor();
    await section.locator('a.tr').first().getByText(p2.items[0].contract_no, { exact: true }).waitFor();
    await section.locator('a.tr').first().click();
    await page.waitForURL(new RegExp(`#/contracts/${p2.items[0].id}$`));
    await page.getByRole('heading', { name: p2.items[0].contract_no }).waitFor();
    for (const [q, url, heading] of [
      ['Declaration 9704', '#/nocs/105', 'IND-105'], // 9704 is an NOC document
      ['Invoice 9700', '#/contracts/701', 'CT-701'],
    ]) {
      await page.goto(`${BASE}#/?q=${encodeURIComponent(q)}`);
      await page.locator('.doc-row .parent-link').click();
      await page.waitForURL(new RegExp(`${url}$`));
      await page.getByRole('heading', { name: heading }).waitFor();
    }
  });

  await check('Excel export, filtered and all: built on the phone, in 4 MB pieces, opened in the spreadsheet app or shared; same sheets as the desktop', async () => {
    const { page } = app;
    const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    const exportDir = disk(`${PHONE_ROOT}/app-cache`, 'export');
    for (const [hash, query, note] of [
      ['#/?q=harbor&category=Packing+List', { scope: 'all', q: 'harbor', category: 'Packing List' }, 'filtered'],
      ['#/', { scope: 'all' }, 'all'],
      ['#/contracts?currency=EUR', { scope: 'contracts', currency: 'EUR' }, 'filtered'],
    ]) {
      await page.goto(`${BASE}${hash}`);
      const want = await sheets(await exportWorkbook(bigRules.exportData(query)).xlsx.writeBuffer());
      const same = async (bytes) => {
        const got = await sheets(bytes);
        assert.deepEqual(got, want, hash);
        assert.deepEqual(got.map((s) => s.name), query.scope === 'contracts' ? ['Contracts', 'Documents'] : ['Contracts', 'NOCs', 'Documents']);
        assert.ok(got.at(-1).rows.length > 2, 'the Documents sheet has rows');
      };
      // Open: "Open with" (like a document's Open XLSX), named as the desktop download; an older export is cleaned up.
      fs.mkdirSync(exportDir, { recursive: true });
      fs.writeFileSync(path.join(exportDir, 'contract-desk-export-2020-01-01.xlsx'), 'old');
      device.opened = null;
      await page.getByRole('button', { name: `Open Excel ${note}` }).click();
      await until(() => device.opened, `spreadsheet app for ${hash}`, 30_000);
      assert.match(device.opened.filePath, /^file:\/\/.*\/app-cache\/export\/contract-desk-export-\d{4}-\d\d-\d\d\.xlsx$/);
      assert.equal(device.opened.contentType, XLSX);
      await same(device.opened.bytes);
      assert.deepEqual(fs.readdirSync(exportDir), [path.basename(device.opened.filePath)], 'only the latest export is kept');
      // Share: Android's share menu, same file.
      device.shared = null;
      await page.getByRole('button', { name: 'Share Excel export' }).click();
      await until(() => device.shared, `share menu for ${hash}`, 30_000);
      assert.match(device.shared.as, /^contract-desk-export-\d{4}-\d\d-\d\d\.xlsx$/);
      assert.equal(device.shared.mime, XLSX);
      await same(device.shared.bytes);
      assert.equal(fs.readdirSync(exportDir).length, 1);
    }
  });

  await check('search speed with 3,000 contracts on a slow phone (Chromium CPU slowed 4×): under half a second', async () => {
    const { page } = app;
    await page.goto(`${BASE}#/`);
    await page.locator('#q').waitFor();
    // Chromium can only slow a page's main thread, not its workers ("only supported for pages, not workers"), so the
    // database time measured in the worker is counted 3 more times on top of the slowed screen time.
    const cdp = await app.context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const report = [];
    for (const q of ['CT-30', 'INV-2026-31', 'harbor', 'ab', 'urgent', 'Packing list 42']) {
      const want = Object.fromEntries(lists.map((l) => [l, onDesktop(searchUrl(l, { q })).data.total]));
      const t0 = await page.evaluate(() => performance.now());
      await page.locator('#q').fill(q);
      await page.waitForFunction((want) => {
        const shown = Object.fromEntries([...document.querySelectorAll('.result-section')].map((s) => [s.querySelector('.section-label').firstChild.textContent, s.querySelector('.section-count')?.textContent]));
        return shown.Contracts === want.contracts.toLocaleString() && shown.NOCs === want.nocs.toLocaleString() && shown.Documents === want.documents.toLocaleString();
      }, want);
      const screen = (await page.evaluate(() => performance.now())) - t0;
      let db = 0;
      for (const l of lists) db += (await ask(page, searchUrl(l, { q }))).ms;
      const slowPhone = screen + 3 * db;
      report.push(`${q}: ${Math.round(screen)} ms on screen (incl. 120 ms typing pause), ${db.toFixed(1)} ms database → ${Math.round(slowPhone)} ms`);
      assert.ok(slowPhone < 500, report.at(-1));
    }
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    console.log(report.map((r) => `      ${r}`).join('\n'));
    await quit();
  });

  assert.deepEqual(errors, [], 'no page errors');
  console.log(`\nAll ${passed} phone checks passed.`);
} finally {
  if (app) await app.context.close();
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
