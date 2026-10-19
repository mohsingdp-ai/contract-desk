// End-to-end acceptance checks against a real server with a throwaway data folder.
// Run: npm test
import { spawn } from 'node:child_process';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-desk-test-'));
const PORT = 4791;
const BASE = `http://127.0.0.1:${PORT}`;
const server = spawn(process.execPath, ['server/index.js'], {
  env: { ...process.env, DATA_DIR: dataDir, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((resolve, reject) => {
  server.stdout.on('data', (b) => String(b).includes('running at') && resolve());
  server.on('exit', (code) => reject(new Error(`server exited ${code}`)));
});

let passed = 0;
const check = async (name, fn) => {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
};
const api = async (method, url, body) => {
  const res = await fetch(BASE + url, {
    method,
    headers: body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {},
    body: body instanceof FormData ? body : body && JSON.stringify(body),
  });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, body: ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
};
const filesOnDisk = () => fs.readdirSync(path.join(dataDir, 'files')).sort();

// Tiny but real sample files (synthetic test data).
const PDF = Buffer.from('%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const xwb = new ExcelJS.Workbook();
xwb.addWorksheet('Lines').addRow(['Item', 'Qty']);
const XLSX = Buffer.from(await xwb.xlsx.writeBuffer());

const form = (files, meta) => {
  const fd = new FormData();
  for (const [name, buf] of files) fd.append('files', new Blob([buf]), name);
  fd.append('meta', JSON.stringify(meta));
  return fd;
};

try {
  console.log('Acceptance checks');
  let contract, other, noc, invoiceDoc;

  await check('create contract; duplicate Contract No. is rejected', async () => {
    const r = await api('POST', '/api/contracts', { contract_no: 'CT-2026-014', project_name: 'Harbor Pumps', firm_name: 'Northwind Trading', amount: '125000.50', currency: 'usd' });
    assert.equal(r.status, 201);
    contract = r.body;
    assert.equal(contract.currency, 'USD');
    const dup = await api('POST', '/api/contracts', { contract_no: 'ct-2026-014', project_name: 'x', firm_name: 'y', amount: 1, currency: 'USD' });
    assert.equal(dup.status, 409);
    other = (await api('POST', '/api/contracts', { contract_no: 'CT-2026-015', project_name: 'Valve Retrofit', firm_name: 'Oakline Ltd', amount: 9000, currency: 'EUR' })).body;
  });

  await check('upload multiple documents in different categories, one with tag + INV-2026-001', async () => {
    const r = await api(
      'POST',
      `/api/contracts/${contract.id}/documents`,
      form(
        [['invoice.pdf', PDF], ['packing-list.xlsx', XLSX], ['bl-scan-çödé.png', PNG]],
        [
          { category: 'Commercial Invoice', reference_no: 'INV-2026-001', tags: ['Urgent', ' urgent ', 'Q3'] },
          { category: 'Packing List', tags: ['q3'] },
          { category: 'Bill of Lading / Airway Bill', display_name: 'BL scan' },
        ],
      ),
    );
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.length, 3);
    invoiceDoc = r.body[0];
    assert.deepEqual(invoiceDoc.tags, ['Q3', 'Urgent'], 'case/space duplicate tags collapse to one');
    assert.deepEqual(r.body[1].tags, ['Q3'], 'existing tag reused regardless of case');
    assert.equal(new Set(r.body.map((d) => d.storage_name)).size, 3, 'unique storage names');
    assert.equal(r.body[2].original_name, 'bl-scan-çödé.png', 'non-ASCII filename kept');
    assert.equal(filesOnDisk().length, 3);
    await api('POST', `/api/contracts/${other.id}/documents`, form([['invoice.pdf', PDF]], [{ category: 'Commercial Invoice', reference_no: 'INV-2026-0010' }]));
  });

  await check('failed upload leaves no rows and no files', async () => {
    const before = filesOnDisk();
    const badCat = await api('POST', `/api/contracts/${contract.id}/documents`, form([['a.pdf', PDF], ['b.pdf', PDF]], [{ category: 'Packing List' }, { category: 'Nope' }]));
    assert.equal(badCat.status, 400);
    const badType = await api('POST', `/api/contracts/${contract.id}/documents`, form([['a.pdf', PDF], ['evil.exe', PDF]], [{ category: 'Packing List' }, { category: 'Packing List' }]));
    assert.equal(badType.status, 400);
    const noParent = await api('POST', `/api/contracts/99999/documents`, form([['a.pdf', PDF]], [{ category: 'Packing List' }]));
    assert.equal(noParent.status, 404);
    assert.deepEqual(filesOnDisk(), before);
    assert.equal((await api('GET', `/api/contracts/${contract.id}`)).body.documents.length, 3);
  });

  await check('find the document by Reference No. (exact match first) and by tag, then open its parent', async () => {
    const byRef = (await api('GET', '/api/documents?q=INV-2026-001')).body;
    assert.equal(byRef.total, 2, 'prefix match also found');
    assert.equal(byRef.items[0].id, invoiceDoc.id, 'exact Reference No. ranks first');
    assert.equal(byRef.items[0].rank, 0);
    const byTag = (await api('GET', '/api/documents?q=urgent')).body;
    assert.deepEqual(byTag.items.map((d) => d.id), [invoiceDoc.id]);
    const byTagFilter = (await api('GET', '/api/documents?tag=URGENT')).body;
    assert.deepEqual(byTagFilter.items.map((d) => d.id), [invoiceDoc.id]);
    const parent = byRef.items[0].parent;
    assert.deepEqual([parent.type, parent.id, parent.no], ['contract', contract.id, 'CT-2026-014']);
    const opened = (await api('GET', `/api/contracts/${parent.id}`)).body;
    assert.equal(opened.contract_no, 'CT-2026-014');
    assert.ok(opened.documents.some((d) => d.id === invoiceDoc.id));
  });

  await check('NOC Ind-1: create, reject duplicate, attach multiple files, find through search', async () => {
    const r = await api('POST', '/api/nocs', { indent_no: 'Ind-1', noc_name: 'Customs NOC for pumps' });
    assert.equal(r.status, 201);
    noc = r.body;
    assert.equal((await api('POST', '/api/nocs', { indent_no: ' IND-1 ', noc_name: 'dup' })).status, 409);
    const up = await api('POST', `/api/nocs/${noc.id}/documents`, form([['noc-letter.pdf', PDF], ['noc-stamp.png', PNG]], [{ tags: ['noc'] }, { reference_no: 'NOC-77' }]));
    assert.equal(up.status, 201, JSON.stringify(up.body));
    assert.ok(up.body.every((d) => d.parent.type === 'noc' && d.parent.no === 'Ind-1' && d.category === null));
    const nocs = (await api('GET', '/api/nocs?q=ind-1')).body;
    assert.equal(nocs.items[0].indent_no, 'Ind-1');
    assert.equal(nocs.items[0].doc_count, 2);
    const docs = (await api('GET', '/api/documents?q=noc-')).body;
    assert.equal(docs.total, 2);
    assert.ok(docs.items.every((d) => d.parent.id === noc.id));
  });

  await check('filters: project, firm, category, file type, currency, amount range', async () => {
    assert.equal((await api('GET', '/api/contracts?firm=northwind%20trading')).body.total, 1);
    assert.equal((await api('GET', '/api/contracts?currency=EUR&min=5000&max=10000')).body.items[0].contract_no, 'CT-2026-015');
    assert.equal((await api('GET', '/api/contracts?min=200000')).body.total, 0);
    assert.equal((await api('GET', '/api/documents?category=Packing%20List')).body.total, 1);
    assert.equal((await api('GET', '/api/documents?file_type=image')).body.total, 2);
    assert.equal((await api('GET', '/api/documents?project=Harbor%20Pumps')).body.total, 3);
    assert.equal((await api('GET', '/api/nocs?project=Harbor%20Pumps')).body.total, 0);
    const paged = (await api('GET', '/api/documents?page_size=2&page=2')).body;
    assert.equal(paged.items.length, 2);
    assert.equal(paged.pages, 3);
  });

  await check('database enforces exactly one parent per document', async () => {
    const db = new DatabaseSync(path.join(dataDir, 'contracts.db'));
    db.exec('PRAGMA foreign_keys = ON');
    assert.equal(db.prepare('SELECT count(*) AS n FROM documents WHERE (contract_id IS NULL) = (noc_id IS NULL)').get().n, 0);
    const ins = (c, n, cat) => () =>
      db
        .prepare(`INSERT INTO documents (contract_id, noc_id, display_name, original_name, storage_name, file_path, mime_type, file_type, size_bytes, category) VALUES (?, ?, 'x', 'x.pdf', ?, ?, 'application/pdf', 'pdf', 1, ?)`)
        .run(c, n, Math.random() + '', Math.random() + '', cat);
    assert.throws(ins(null, null, null), /CHECK constraint/);
    assert.throws(ins(contract.id, noc.id, 'Packing List'), /CHECK constraint/);
    assert.throws(ins(424242, null, 'Packing List'), /FOREIGN KEY/);
    assert.throws(ins(contract.id, null, null), /CHECK constraint/, 'contract docs need a category');
    db.close();
  });

  await check('filtered export: Documents sheet links every attachment to the correct parent', async () => {
    const r = await api('GET', '/api/export.xlsx?firm=Northwind%20Trading');
    assert.equal(r.status, 200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.body);
    const rows = (name) => {
      const ws = wb.getWorksheet(name);
      const head = ws.getRow(1).values;
      const out = [];
      ws.eachRow((row, i) => i > 1 && out.push(Object.fromEntries(head.map((h, j) => [h, row.values[j]]).filter(([h]) => h))));
      return out;
    };
    const cs = rows('Contracts');
    assert.deepEqual(cs.map((c) => c['Contract No.']), ['CT-2026-014'], 'filter applied');
    assert.equal(cs[0].Attachments, 3);
    assert.equal(cs[0]['Commercial Invoice'], 1);
    assert.equal(rows('NOCs').length, 0, 'firm filter excludes NOCs');
    const ds = rows('Documents');
    assert.equal(ds.length, 3);
    const all = (await api('GET', `/api/contracts/${contract.id}`)).body.documents;
    for (const d of ds) {
      const real = all.find((x) => x.id === d['Document ID']);
      assert.ok(real, 'every exported document exists');
      assert.equal(d['Parent Type'], 'Contract');
      assert.equal(d['Contract No. / Indent No.'], 'CT-2026-014');
      assert.equal(d['Original Filename'], real.original_name);
      assert.equal(d.Category, real.category);
    }
    const inv = ds.find((d) => d['Document ID'] === invoiceDoc.id);
    assert.equal(inv['Reference No.'], 'INV-2026-001');
    assert.equal(inv.Tags, 'Q3, Urgent');

    const full = new ExcelJS.Workbook();
    await full.xlsx.load((await api('GET', '/api/export.xlsx')).body);
    const nocDocs = [];
    full.getWorksheet('Documents').eachRow((row, i) => i > 1 && row.values[2] === 'NOC' && nocDocs.push(row.values[3]));
    assert.deepEqual(nocDocs, ['Ind-1', 'Ind-1']);
  });

  await check('renaming keeps file access and parent; metadata edits stick to the document', async () => {
    const before = (await api('GET', `/api/documents/${invoiceDoc.id}/file`)).body;
    const r = await api('PATCH', `/api/documents/${invoiceDoc.id}`, { display_name: 'Final invoice (signed)', tags: ['Urgent', 'Paid'] });
    assert.equal(r.status, 200);
    assert.equal(r.body.display_name, 'Final invoice (signed)');
    assert.equal(r.body.storage_name, invoiceDoc.storage_name);
    assert.equal(r.body.file_path, invoiceDoc.file_path);
    assert.equal(r.body.parent.id, contract.id);
    assert.equal(r.body.reference_no, 'INV-2026-001');
    const res = await fetch(`${BASE}/api/documents/${invoiceDoc.id}/file?download=1`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition'), /Final%20invoice%20\(signed\)\.pdf|Final invoice \(signed\)\.pdf/);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), before);
    const tags = (await api('GET', '/api/facets')).body.tags.map((t) => t.name);
    assert.ok(tags.includes('Paid') && tags.includes('Q3'));
  });

  await check('search index follows renames, tag edits and deletes', async () => {
    const ids = async (q) => (await api('GET', `/api/documents?q=${encodeURIComponent(q)}`)).body.items.map((d) => d.id);
    assert.deepEqual(await ids('(signed)'), [invoiceDoc.id], 'new display name is searchable');
    assert.deepEqual(await ids('paid'), [invoiceDoc.id], 'new tag is searchable');
    assert.ok(!(await ids('Q3')).includes(invoiceDoc.id), 'removed tag no longer matches (2-char fallback)');
    assert.ok((await ids('çödé')).length === 1, 'non-ASCII substring found');
    await api('PATCH', `/api/documents/${invoiceDoc.id}`, { reference_no: 'INV-2026-999' });
    assert.deepEqual(await ids('INV-2026-999'), [invoiceDoc.id]);
    assert.ok(!(await ids('INV-2026-001')).includes(invoiceDoc.id), 'old Reference No. gone');
    await api('PATCH', `/api/documents/${invoiceDoc.id}`, { reference_no: 'INV-2026-001' });
  });

  await check('deleting a document removes only its row and file', async () => {
    const victim = (await api('GET', `/api/contracts/${contract.id}`)).body.documents.find((d) => d.category === 'Packing List');
    const r = await api('DELETE', `/api/documents/${victim.id}`);
    assert.equal(r.status, 200);
    assert.ok(!filesOnDisk().includes(victim.storage_name));
    assert.equal((await api('GET', `/api/documents/${victim.id}`)).status, 404);
    assert.equal((await api('GET', `/api/contracts/${contract.id}`)).body.documents.length, 2);
    assert.equal(filesOnDisk().length, 5);
  });

  await check('deleting a contract or NOC removes its documents and files, nothing else', async () => {
    const keep = (await api('GET', `/api/contracts/${other.id}`)).body.documents[0].storage_name;
    assert.equal((await api('DELETE', `/api/contracts/${contract.id}`)).body.deletedDocuments, 2);
    assert.equal((await api('GET', `/api/documents/${invoiceDoc.id}`)).status, 404);
    assert.equal(filesOnDisk().length, 3);
    assert.equal((await api('DELETE', `/api/nocs/${noc.id}`)).body.deletedDocuments, 2);
    assert.deepEqual(filesOnDisk(), [keep]);
    assert.equal((await api('GET', '/api/documents')).body.total, 1);
    const tags = (await api('GET', '/api/facets')).body.tags;
    assert.deepEqual(tags, [], 'unused tags pruned');
    assert.equal((await api('GET', '/api/documents?q=noc-')).body.total, 0, 'deleted documents leave the search index');
    assert.equal((await api('GET', '/api/documents?q=invoice')).body.total, 1);
  });

  await check('cross-site writes and non-local Host headers are refused', async () => {
    const res = await fetch(`${BASE}/api/nocs`, { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 403);
    // fetch() drops custom Host headers, so use a raw request.
    const hostStatus = (host) =>
      new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: PORT, path: '/api/meta', headers: { Host: host } }, (r) => (r.resume(), resolve(r.statusCode))).on('error', reject));
    assert.equal(await hostStatus('evil.example'), 403);
    assert.equal(await hostStatus('192.168.1.20:4791'), 403, 'raw IPs only allowed when Wi-Fi access is on');
    assert.equal(await hostStatus(`localhost:${PORT}`), 200);
  });

  await check('categories: add, rename (documents follow), reorder, and remove only after moving documents', async () => {
    const names = async () => (await api('GET', '/api/categories')).body.map((c) => c.name);
    const byName = async (n) => (await api('GET', '/api/categories')).body.find((c) => c.name === n);
    assert.deepEqual((await names()).slice(0, 2), ['Bank Payment Documents', 'Commercial Invoice']);

    assert.equal((await api('POST', '/api/categories', { name: '  Insurance   Certificate ' })).status, 201);
    assert.ok((await names()).includes('Insurance Certificate'), 'trimmed and single-spaced');
    assert.equal((await api('POST', '/api/categories', { name: 'insurance certificate' })).status, 409, 'no case duplicates');
    assert.equal((await api('POST', '/api/categories', { name: '   ' })).status, 400);
    assert.deepEqual((await api('GET', '/api/meta')).body.categories, await names(), 'upload and filter lists follow');

    const c = (await api('POST', '/api/contracts', { contract_no: 'CAT-001', project_name: 'p', firm_name: 'f', amount: 1, currency: 'USD' })).body;
    const up = await api('POST', `/api/contracts/${c.id}/documents`, form([['policy.pdf', PDF], ['cert.pdf', PDF]], [{ category: 'insurance certificate' }, { category: 'Insurance Certificate' }]));
    assert.equal(up.status, 201, JSON.stringify(up.body));
    assert.ok(up.body.every((d) => d.category === 'Insurance Certificate'), 'stored with the category spelling');

    const ins = await byName('Insurance Certificate');
    assert.equal(ins.doc_count, 2);
    await api('PATCH', `/api/categories/${ins.id}`, { name: 'Insurance Policy' });
    const docs = (await api('GET', `/api/contracts/${c.id}`)).body.documents;
    assert.ok(docs.every((d) => d.category === 'Insurance Policy'), 'rename follows into every document');
    assert.equal((await api('GET', '/api/documents?category=Insurance%20Policy')).body.total, 2);

    const before = await names();
    await api('PATCH', `/api/categories/${ins.id}`, { move: 'up' });
    const after = await names();
    assert.equal(after.indexOf('Insurance Policy'), before.indexOf('Insurance Policy') - 1);

    const refused = await api('DELETE', `/api/categories/${ins.id}`);
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /still has 2 documents/);
    const other = await byName('Other Documents');
    assert.equal((await api('DELETE', `/api/categories/${ins.id}?move_to=${other.id}`)).status, 200);
    assert.ok(!(await names()).includes('Insurance Policy'));
    const moved = (await api('GET', `/api/contracts/${c.id}`)).body.documents;
    assert.equal(moved.length, 2, 'no document lost');
    assert.ok(moved.every((d) => d.category === 'Other Documents'));

    // Export columns follow the current list.
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await api('GET', '/api/export.xlsx?scope=contracts')).body);
    const head = wb.getWorksheet('Contracts').getRow(1).values;
    assert.ok(head.includes('Other Documents') && !head.includes('Insurance Policy'));

    await api('DELETE', `/api/contracts/${c.id}`);
  });

  await check('categories: an old database with the fixed list is upgraded with nothing lost', async () => {
    const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-desk-old-'));
    fs.mkdirSync(path.join(oldDir, 'files'));
    fs.writeFileSync(path.join(oldDir, 'files', 'a.pdf'), PDF);
    const old = new DatabaseSync(path.join(oldDir, 'contracts.db'));
    old.exec(`
      CREATE TABLE contracts (id INTEGER PRIMARY KEY, contract_no TEXT NOT NULL UNIQUE COLLATE NOCASE, project_name TEXT NOT NULL DEFAULT '', firm_name TEXT NOT NULL DEFAULT '',
        amount REAL NOT NULL, currency TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ')), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ')));
      CREATE TABLE nocs (id INTEGER PRIMARY KEY, indent_no TEXT NOT NULL UNIQUE COLLATE NOCASE, noc_name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ')), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ')));
      CREATE TABLE documents (id INTEGER PRIMARY KEY, contract_id INTEGER REFERENCES contracts (id) ON DELETE CASCADE, noc_id INTEGER REFERENCES nocs (id) ON DELETE CASCADE,
        display_name TEXT NOT NULL, original_name TEXT NOT NULL, storage_name TEXT NOT NULL UNIQUE, file_path TEXT NOT NULL UNIQUE, mime_type TEXT NOT NULL, file_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL, category TEXT CHECK (category IN ('Bank Payment Documents', 'Commercial Invoice', 'Packing List', 'Bill of Lading / Airway Bill', 'Goods Declaration (GD)', 'Other Documents')),
        reference_no TEXT, uploaded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ')), CHECK ((contract_id IS NULL) <> (noc_id IS NULL)), CHECK ((contract_id IS NOT NULL) = (category IS NOT NULL)));
      CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT NOT NULL, key TEXT NOT NULL UNIQUE);
      CREATE TABLE document_tags (document_id INTEGER NOT NULL REFERENCES documents (id) ON DELETE CASCADE, tag_id INTEGER NOT NULL REFERENCES tags (id) ON DELETE CASCADE, PRIMARY KEY (document_id, tag_id)) WITHOUT ROWID;
      INSERT INTO contracts (id, contract_no, amount, currency) VALUES (1, 'OLD-001', 5, 'USD');
      INSERT INTO documents (id, contract_id, display_name, original_name, storage_name, file_path, mime_type, file_type, size_bytes, category, reference_no)
        VALUES (7, 1, 'Old invoice', 'a.pdf', 'a.pdf', 'files/a.pdf', 'application/pdf', 'pdf', 10, 'Packing List', 'REF-OLD-1');
      INSERT INTO tags (id, name, key) VALUES (1, 'Legacy', 'legacy');
      INSERT INTO document_tags VALUES (7, 1);`);
    old.close();
    const s2 = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, DATA_DIR: oldDir, PORT: '4795', LAN_PASSCODE: '' }, stdio: ['ignore', 'pipe', 'inherit'] });
    try {
      await new Promise((resolve) => s2.stdout.on('data', (b) => String(b).includes('running at') && resolve()));
      const B2 = 'http://127.0.0.1:4795';
      const doc = await (await fetch(`${B2}/api/documents/7`)).json();
      assert.equal(doc.category, 'Packing List');
      assert.deepEqual(doc.tags, ['Legacy'], 'tags survive the table rebuild');
      assert.equal(doc.reference_no, 'REF-OLD-1');
      assert.equal((await (await fetch(`${B2}/api/documents?q=REF-OLD`)).json()).total, 1, 'search index still matches');
      assert.equal((await fetch(`${B2}/api/documents/7/file`)).status, 200);
      const add = await fetch(`${B2}/api/categories`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"Certificate of Origin"}' });
      assert.equal(add.status, 201);
      const patched = await fetch(`${B2}/api/documents/7`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{"category":"Certificate of Origin"}' });
      assert.equal((await patched.json()).category, 'Certificate of Origin', 'old database now accepts new categories');
      const db2 = new DatabaseSync(path.join(oldDir, 'contracts.db'));
      assert.equal(db2.prepare('PRAGMA foreign_key_check').all().length, 0);
      assert.ok(!/CHECK \(category IN/.test(db2.prepare(`SELECT sql FROM sqlite_schema WHERE name = 'documents'`).get().sql));
      db2.close();
    } finally {
      s2.kill();
      fs.rmSync(oldDir, { recursive: true, force: true });
    }
  });

  // Wi-Fi access: a second server with a passcode, reached through this machine's network address like a phone would.
  const lanIp = Object.values(os.networkInterfaces()).flat().find((n) => n.family === 'IPv4' && !n.internal)?.address;
  await check('Wi-Fi access: refuses a short passcode', async () => {
    const r = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, DATA_DIR: dataDir, PORT: '4792', LAN_PASSCODE: '123' }, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    r.stderr.on('data', (b) => (err += b));
    const code = await new Promise((resolve) => r.on('exit', resolve));
    assert.equal(code, 1);
    assert.match(err, /at least 6 characters/);
  });
  if (!lanIp) console.log('  - skipped Wi-Fi passcode checks: no network address on this machine');
  else {
    const lanDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-desk-lan-'));
    const lan = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, DATA_DIR: lanDir, PORT: '4792', LAN_PASSCODE: 'harbor-2026' }, stdio: ['ignore', 'pipe', 'inherit'] });
    try {
      await new Promise((resolve) => lan.stdout.on('data', (b) => String(b).includes('Wi-Fi access ON') && resolve()));
      const L = `http://${lanIp}:4792`;
      await check('Wi-Fi access: phones need the passcode; this computer does not', async () => {
        assert.equal((await fetch(`${L}/api/contracts`)).status, 401);
        assert.equal((await fetch(`${L}/api/documents/1/file`)).status, 401, 'files are protected too');
        assert.equal((await fetch(`${L}/`)).status, 200, 'the app shell loads so the passcode screen can show');
        assert.equal((await fetch('http://127.0.0.1:4792/api/contracts')).status, 200, 'loopback needs no passcode');
        const wrong = await fetch(`${L}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"passcode":"nope"}' });
        assert.equal(wrong.status, 401);
        const ok = await fetch(`${L}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"passcode":"harbor-2026"}' });
        assert.equal(ok.status, 200);
        const cookie = ok.headers.get('set-cookie');
        assert.match(cookie, /HttpOnly/i);
        assert.match(cookie, /SameSite=Lax/i);
        const session = cookie.split(';')[0];
        assert.equal((await fetch(`${L}/api/contracts`, { headers: { Cookie: session } })).status, 200);
        assert.equal((await fetch(`${L}/api/contracts`, { headers: { Cookie: 'cd_session=forged' } })).status, 401);
        // fetch() drops custom Host headers, so use a raw request.
        const hostStatus = (host) =>
          new Promise((resolve, reject) =>
            http.get({ host: lanIp, port: 4792, path: '/api/contracts', headers: { Host: host, Cookie: session } }, (r) => (r.resume(), resolve(r.statusCode))).on('error', reject),
          );
        assert.equal(await hostStatus('evil.example:4792'), 403, 'DNS-rebinding style Host refused');
        assert.equal(await hostStatus(`${lanIp}:4792`), 200);
      });
      await check('Wi-Fi access: QR pairing link unlocks a phone once, and only the computer can make one', async () => {
        const fromPhone = await fetch(`${L}/api/pair`, { method: 'POST' });
        assert.equal(fromPhone.status, 403, 'a locked phone cannot make a code');
        const login = await fetch(`${L}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"passcode":"harbor-2026"}' });
        const session = login.headers.get('set-cookie').split(';')[0];
        const fromPairedPhone = await fetch(`${L}/api/pair`, { method: 'POST', headers: { Cookie: session } });
        assert.equal(fromPairedPhone.status, 403, 'even an unlocked phone cannot add devices');

        const made = await (await fetch('http://127.0.0.1:4792/api/pair', { method: 'POST' })).json();
        assert.ok(made.expiresAt - Date.now() > 9 * 60_000 && made.expiresAt - Date.now() <= 10 * 60_000);
        const link = made.links.find((l) => l.url.startsWith(`http://${lanIp}:4792/pair/`));
        assert.ok(link, 'link uses the Wi-Fi address');
        assert.match(link.svg, /^<svg/);
        assert.ok(!link.url.includes('harbor-2026'), 'the passcode itself is never in the QR');

        const scan = await fetch(link.url, { redirect: 'manual' });
        assert.equal(scan.status, 302);
        assert.equal(scan.headers.get('location'), '/');
        const paired = scan.headers.get('set-cookie').split(';')[0];
        assert.equal((await fetch(`${L}/api/contracts`, { headers: { Cookie: paired } })).status, 200, 'scanned phone is unlocked');

        const again = await fetch(link.url, { redirect: 'manual' });
        assert.equal(again.headers.get('location'), '/?pair=failed', 'second scan of the same code fails');
        assert.equal(again.headers.get('set-cookie'), null);
        const bogus = await fetch(`${L}/pair/made-up-code`, { redirect: 'manual' });
        assert.equal(bogus.headers.get('location'), '/?pair=failed');
      });
      await check('Wi-Fi access: repeated wrong passcodes lock the device out', async () => {
        const tryCode = (c) => fetch(`${L}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passcode: c }) }).then((r) => r.status);
        const statuses = [];
        for (let i = 0; i < 5; i++) statuses.push(await tryCode('wrong' + i));
        assert.deepEqual(statuses.slice(0, 3), [401, 401, 401]);
        assert.equal(await tryCode('harbor-2026'), 429, 'even the right passcode waits out the lockout');
      });
    } finally {
      lan.kill();
      fs.rmSync(lanDir, { recursive: true, force: true });
    }
  }

  console.log(`\nAll ${passed} checks passed.`);
} catch (err) {
  console.error(`\n✗ Failed after ${passed} passing checks:`);
  console.error(err);
  process.exitCode = 1;
} finally {
  server.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
