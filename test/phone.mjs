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
// writes: pieces written to files/; failWrite: the n-th next write to files/ fails (phone storage full); opened/shared:
// what the phone's own apps were handed.
const device = { access: false, grantOnRequest: true, pick: null, calls: [], die: null, hung: false, writes: [], failWrite: 0, opened: null, shared: null, slow: 0 };
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
    await camera.setInputFiles(src('JPEG_20261021_101500_123.jpg', PNG)); // the name Capacitor gives a camera photo
    await modal(page).locator('.apply-all select').selectOption('Other Documents');
    await modal(page).getByRole('button', { name: 'Upload 1 file' }).click();
    await modal(page).waitFor({ state: 'detached' });
    await until(() => docsOf('CT-UP').some((d) => d.original_name === 'JPEG_20261021_101500_123.jpg' && d.file_type === 'image'), 'the photo filed');
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

  assert.deepEqual(errors, [], 'no page errors');
  console.log(`\nAll ${passed} phone checks passed.`);
} finally {
  if (app) await app.context.close();
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
