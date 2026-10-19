// UI-driven end-to-end checks. Every step goes through the browser like a person would.
// Sample files are synthetic and generated here.
import { test, expect } from '@playwright/test';
import ExcelJS from 'exceljs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { E2E_DATA_DIR } from '../../playwright.config.js';

test.describe.configure({ mode: 'serial' });

const FILES_DIR = path.join(E2E_DATA_DIR, 'files');
const storedFiles = () => (fs.existsSync(FILES_DIR) ? fs.readdirSync(FILES_DIR).sort() : []);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-desk-e2e-files-'));
const sample = {};
const PDF = (text) =>
  Buffer.from(
    `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj 4 0 obj<</Length 44>>stream\nBT /F1 18 Tf 20 100 Td (${text}) Tj ET\nendstream endobj 5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n`,
  );
// 2x2 red PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64');

test.beforeAll(async () => {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('Lines').addRows([
    ['Item', 'Qty'],
    ['Pump', 4],
  ]);
  const files = {
    'commercial-invoice.pdf': PDF('SAMPLE invoice'),
    'packing-list.xlsx': Buffer.from(await wb.xlsx.writeBuffer()),
    'bl-scan.png': PNG,
    'swift-advice.pdf': PDF('SAMPLE swift'),
    'noc-letter.pdf': PDF('SAMPLE noc'),
    'noc-stamp.png': PNG,
    'malware.exe': Buffer.from('MZ not allowed'),
  };
  for (const [name, buf] of Object.entries(files)) {
    sample[name] = path.join(tmp, name);
    fs.writeFileSync(sample[name], buf);
  }
});
test.afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** @type {import('@playwright/test').Page} */
let page;
const pageErrors = [];

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage({ acceptDownloads: true });
  page.on('pageerror', (e) => pageErrors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    // 4xx responses we trigger on purpose (duplicates, bad uploads) are logged by the browser; anything else is a bug.
    if (m.type() === 'error' && !/Failed to load resource: the server responded with a status of 4\d\d/.test(m.text())) pageErrors.push(`console: ${m.text()}`);
  });
});
test.afterAll(async () => page?.close());

const dialog = () => page.getByRole('dialog');
const tagBox = (scope) => scope.getByRole('group', { name: 'Tags' });
const tagInput = (scope) => tagBox(scope).getByRole('combobox', { name: 'Add tag' });
const docRow = (name) => page.locator('.doc-row').filter({ has: page.getByRole('button', { name, exact: true }) });

async function search(q) {
  await page.goto('/#/');
  await page.locator('#q').fill(q);
}

test('empty desk invites the first record', async () => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'The desk is empty.' })).toBeVisible();
  await page.getByRole('link', { name: 'New contract' }).click();
  await expect(dialog().getByRole('heading', { name: 'New contract' })).toBeVisible();
});

test('create a contract; a duplicate Contract No. is refused with a message', async () => {
  await dialog().getByLabel('Contract No.').fill('CT-2026-014');
  await dialog().getByLabel('Project Name').fill('Harbor Pumps');
  await dialog().getByLabel('Firm Name').fill('Northwind Trading');
  await dialog().getByLabel('Amount').fill('125000.5');
  await dialog().getByLabel('Currency').fill('usd');
  await dialog().getByRole('button', { name: 'Create contract' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'CT-2026-014' })).toBeVisible();
  await expect(page.locator('.manifest')).toContainText('125,000.50');
  await expect(page.locator('.manifest')).toContainText('USD');

  await page.goto('/#/contracts?new=1');
  await dialog().getByLabel('Contract No.').fill('ct-2026-014');
  await dialog().getByLabel('Amount').fill('1');
  await dialog().getByRole('button', { name: 'Create contract' }).click();
  await expect(dialog().locator('.form-error')).toHaveText('That Contract No. already exists');

  await dialog().getByLabel('Contract No.').fill('CT-2026-015');
  await dialog().getByLabel('Project Name').fill('Valve Retrofit');
  await dialog().getByLabel('Firm Name').fill('Oakline Ltd');
  await dialog().getByLabel('Amount').fill('9000');
  await dialog().getByLabel('Currency').fill('EUR');
  await dialog().getByRole('button', { name: 'Create contract' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'CT-2026-015' })).toBeVisible();
});

test('edit a contract', async () => {
  await page.goto('/#/contracts');
  await page.getByRole('row').filter({ hasText: 'CT-2026-015' }).click();
  await page.getByRole('button', { name: 'Edit' }).click();
  await dialog().getByLabel('Amount').fill('9500');
  await dialog().getByRole('button', { name: 'Save contract' }).click();
  await expect(dialog()).toHaveCount(0);
  await expect(page.locator('.manifest')).toContainText('9,500.00');
});

test('upload several files into different categories with tags and a Reference No.', async () => {
  await page.goto('/#/contracts');
  await page.getByRole('row').filter({ hasText: 'CT-2026-014' }).click();
  await page.getByRole('button', { name: 'Add documents' }).click();
  await dialog().locator('input[type=file]').setInputFiles([sample['commercial-invoice.pdf'], sample['packing-list.xlsx'], sample['bl-scan.png'], sample['swift-advice.pdf']]);
  const rows = dialog().locator('.stage-row');
  await expect(rows).toHaveCount(4);

  // Category is required for every file.
  await dialog().getByRole('button', { name: /Upload 4 files/ }).click();
  await expect(dialog().locator('.form-error')).toContainText('Pick a category for every file');
  expect(storedFiles()).toEqual([]);

  const setRow = async (i, { category, ref, tags = [], name }) => {
    const r = rows.nth(i);
    await r.getByLabel('Category').selectOption(category);
    if (name) await r.getByLabel('Display name').fill(name);
    if (ref) await r.getByLabel('Reference No.').fill(ref);
    for (const t of tags) {
      await tagInput(r).fill(t);
      await tagInput(r).press('Enter');
    }
  };
  await setRow(0, { category: 'Commercial Invoice', ref: 'INV-2026-001', tags: ['Urgent', ' urgent ', 'Q3'], name: 'Commercial invoice' });
  await setRow(1, { category: 'Packing List', tags: ['q3'] });
  await setRow(2, { category: 'Bill of Lading / Airway Bill', name: 'BL scan' });
  await setRow(3, { category: 'Bank Payment Documents', ref: 'FT26101' });
  // " urgent " typed after "Urgent" must not create a second chip.
  await expect(rows.nth(0).locator('.tag')).toHaveText([/Urgent/, /Q3/]);
  // "q3" on another row reuses the existing spelling "Q3" once it exists server-side; in the same batch the server merges them.

  await dialog().getByRole('button', { name: /Upload 4 files/ }).click();
  await expect(dialog()).toHaveCount(0);
  for (const [group, doc] of [
    ['Commercial Invoice', 'Commercial invoice'],
    ['Packing List', 'packing-list'],
    ['Bill of Lading / Airway Bill', 'BL scan'],
    ['Bank Payment Documents', 'swift-advice'],
  ]) {
    await expect(page.locator('.doc-group').filter({ has: page.getByRole('heading', { name: group, exact: true }) }).getByRole('button', { name: doc, exact: true })).toBeVisible();
  }
  await expect(docRow('Commercial invoice')).toContainText('INV-2026-001');
  await expect(docRow('Commercial invoice').locator('.tag')).toHaveText(['Q3', 'Urgent']);
  await expect(docRow('packing-list').locator('.tag')).toHaveText(['Q3']);
  expect(storedFiles()).toHaveLength(4);
});

test('a disallowed file type is rejected and nothing is saved', async () => {
  const before = storedFiles();
  await page.getByRole('button', { name: 'Add documents' }).click();
  await dialog().locator('input[type=file]').setInputFiles([sample['swift-advice.pdf'], sample['malware.exe']]);
  await dialog().getByRole('combobox').first().selectOption('Other Documents');
  await dialog().getByRole('button', { name: /Upload 2 files/ }).click();
  await expect(dialog().locator('.form-error')).toContainText('"malware.exe" is not a PDF, image or Excel file');
  await expect(dialog().locator('.form-error')).toContainText('Nothing was saved');
  expect(storedFiles()).toEqual(before);
  await dialog().getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('.doc-group').filter({ hasText: 'Other Documents' }).locator('.doc-row')).toHaveCount(0);
});

test('find the document by Reference No., then by tag, and open its parent contract', async () => {
  await search('INV-2026-001');
  const hit = page.locator('.result-section').first();
  await expect(hit.getByRole('heading', { name: /Documents/ })).toBeVisible();
  await expect(hit.locator('.doc-row').first()).toContainText('Commercial invoice');
  await expect(hit.locator('.doc-row').first().locator('.stamp')).toHaveText('Exact');

  await search('urgent');
  const row = page.locator('.doc-row').filter({ hasText: 'Commercial invoice' });
  await expect(row).toHaveCount(1);
  await row.locator('.parent-link').click();
  await expect(page).toHaveURL(/#\/contracts\/\d+$/);
  await expect(page.getByRole('heading', { level: 1, name: 'CT-2026-014' })).toBeVisible();
});

test('exact Contract No. ranks first and is stamped', async () => {
  await search('CT-2026-014');
  const contracts = page.locator('.result-section').filter({ has: page.getByRole('heading', { name: /^Contracts/ }) });
  await expect(contracts.locator('a.tr').first()).toContainText('CT-2026-014');
  await expect(contracts.locator('a.tr').first().locator('.stamp')).toBeVisible();
  // the section holding the exact match is shown first
  await expect(page.locator('.result-section').first()).toContainText('Contracts');
});

test('PDF and image preview load only when opened; Excel offers a download', async () => {
  await page.goto('/#/contracts');
  await page.getByRole('row').filter({ hasText: 'CT-2026-014' }).click();
  await expect(page.locator('iframe, .preview img')).toHaveCount(0);

  const pdfResponse = page.waitForResponse((r) => /\/api\/documents\/\d+\/file\/Commercial%20invoice$/.test(r.url())); // name in the path titles the PDF viewer
  await docRow('Commercial invoice').getByRole('button', { name: 'Open' }).click();
  const r = await pdfResponse;
  expect(r.status()).toBe(200);
  expect(r.headers()['content-type']).toContain('application/pdf');
  await expect(page.locator('.drawer iframe')).toBeVisible();
  await expect(page.locator('.drawer .parent-link')).toContainText('CT-2026-014');
  await page.keyboard.press('Escape');
  await expect(page.locator('.drawer')).toHaveCount(0);

  await docRow('BL scan').getByRole('button', { name: 'Open' }).click();
  const img = page.locator('.drawer .preview img');
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((el) => el.complete && el.naturalWidth)).toBe(2);
  await page.getByRole('button', { name: 'Close document' }).click();

  await docRow('packing-list').getByRole('button', { name: 'Open' }).click();
  await expect(page.locator('.drawer iframe, .drawer .preview img')).toHaveCount(0);
  const download = page.waitForEvent('download');
  await page.locator('.preview-excel').getByRole('link', { name: /Download XLSX/ }).click();
  const d = await download;
  expect(d.suggestedFilename()).toBe('packing-list.xlsx');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(await d.path());
  expect(wb.getWorksheet('Lines').getCell('A2').value).toBe('Pump');
  await page.keyboard.press('Escape');
});

test('rename and re-tag in the drawer; file access, parent and Reference No. survive', async () => {
  const before = storedFiles();
  await docRow('Commercial invoice').getByRole('button', { name: 'Open' }).click();
  const drawer = page.locator('.drawer');
  await drawer.getByLabel('Display name').fill('Final invoice (signed)');
  // clicking the field's label text must not remove a tag
  await tagBox(drawer).locator('.field-label').click();
  await expect(tagBox(drawer).locator('.tag')).toHaveText([/Q3/, /Urgent/]);
  await tagBox(drawer).getByRole('button', { name: 'Remove tag Q3' }).click();
  await tagInput(drawer).fill('Paid');
  await tagInput(drawer).press('Enter');
  await drawer.getByRole('button', { name: 'Save changes' }).click();
  await expect(drawer.getByRole('button', { name: 'Saved' })).toBeVisible();
  await expect(drawer.getByRole('heading', { name: 'Final invoice (signed)' })).toBeVisible();
  await expect(drawer.getByLabel('Reference No.')).toHaveValue('INV-2026-001');

  const download = page.waitForEvent('download');
  await drawer.getByRole('link', { name: 'Download' }).first().click();
  const d = await download;
  expect(d.suggestedFilename()).toBe('Final invoice (signed).pdf');
  expect(fs.readFileSync(await d.path()).toString()).toContain('SAMPLE invoice');
  expect(storedFiles()).toEqual(before);
  await page.keyboard.press('Escape');

  await expect(docRow('Final invoice (signed)').locator('.tag')).toHaveText(['Paid', 'Urgent']);
  await search('paid');
  await expect(page.locator('.doc-row')).toHaveCount(1);
  await expect(page.locator('.doc-row .parent-link')).toContainText('CT-2026-014');
  await search('signed');
  await expect(page.locator('.doc-row')).toContainText('Final invoice (signed)');
});

test('existing tags are suggested while typing', async () => {
  await page.goto('/#/contracts');
  await page.getByRole('row').filter({ hasText: 'CT-2026-015' }).click();
  await page.getByRole('button', { name: 'Add documents' }).click();
  await dialog().locator('input[type=file]').setInputFiles([sample['swift-advice.pdf']]);
  const listId = await tagInput(dialog()).getAttribute('list');
  const options = await page.locator(`datalist[id="${listId}"] option`).evaluateAll((os) => os.map((o) => o.value));
  expect(options).toEqual(expect.arrayContaining(['Paid', 'Q3', 'Urgent']));
  // typing a different case of an existing tag reuses its spelling
  await tagInput(dialog()).fill('PAID');
  await tagInput(dialog()).press('Enter');
  await expect(dialog().locator('.tag')).toHaveText([/^Paid/]);
  await dialog().getByLabel('Category').selectOption('Bank Payment Documents');
  await dialog().getByRole('button', { name: /Upload 1 file/ }).click();
  await expect(dialog()).toHaveCount(0);
  await expect(page.locator('.doc-row .tag')).toHaveText(['Paid']);
});

test('drag-and-drop upload, row download link, and delete from the document panel', async () => {
  await page.goto('/#/contracts?q=CT-2026-015');
  await page.getByRole('row').filter({ hasText: 'CT-2026-015' }).click();
  await page.getByRole('button', { name: 'Add documents' }).click();
  const png = fs.readFileSync(sample['bl-scan.png']).toString('base64');
  await dialog().locator('.dropzone').evaluate((zone, b64) => {
    const dt = new DataTransfer();
    dt.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'dropped-photo.png', { type: 'image/png' }));
    zone.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, png);
  await expect(dialog().locator('.stage-row')).toHaveCount(1);
  await dialog().getByLabel('Category').selectOption('Other Documents');
  await dialog().getByRole('button', { name: /Upload 1 file/ }).click();
  await expect(dialog()).toHaveCount(0);
  const before = storedFiles();

  const download = page.waitForEvent('download');
  await docRow('dropped-photo').getByRole('link', { name: 'Download' }).click();
  expect((await download).suggestedFilename()).toBe('dropped-photo.png');

  await docRow('dropped-photo').getByRole('button', { name: 'dropped-photo' }).click();
  await page.locator('.drawer').getByRole('button', { name: 'Delete' }).click();
  await expect(dialog()).toContainText('dropped-photo.png');
  await page.keyboard.press('Escape'); // closes the confirm only
  await expect(dialog()).toHaveCount(0);
  await expect(page.locator('.drawer')).toBeVisible();
  await page.locator('.drawer').getByRole('button', { name: 'Delete' }).click();
  await dialog().getByRole('button', { name: 'Delete' }).click();
  await expect(page.locator('.drawer')).toHaveCount(0);
  await expect(docRow('dropped-photo')).toHaveCount(0);
  expect(storedFiles()).toHaveLength(before.length - 1);
});

test('NOCs: create Ind-1, refuse duplicate, attach files, find through search', async () => {
  await page.getByRole('link', { name: /^NOCs/ }).click();
  await page.getByRole('button', { name: 'New NOC' }).click();
  await dialog().getByLabel('Indent No.').fill('Ind-1');
  await dialog().getByLabel('NOC Name').fill('Customs NOC for pumps');
  await dialog().getByRole('button', { name: 'Create NOC' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Ind-1' })).toBeVisible();

  await page.goto('/#/nocs?new=1');
  await dialog().getByLabel('Indent No.').fill(' IND-1 ');
  await dialog().getByLabel('NOC Name').fill('dup');
  await dialog().getByRole('button', { name: 'Create NOC' }).click();
  await expect(dialog().locator('.form-error')).toHaveText('That Indent No. already exists');
  await dialog().getByRole('button', { name: 'Cancel' }).click();

  await page.getByRole('row').filter({ hasText: 'Ind-1' }).click();
  await page.getByRole('button', { name: 'Add documents' }).click();
  await expect(dialog().getByLabel('Category')).toHaveCount(0); // NOCs have no categories
  await dialog().locator('input[type=file]').setInputFiles([sample['noc-letter.pdf'], sample['noc-stamp.png']]);
  await dialog().locator('.stage-row').nth(1).getByLabel('Reference No.').fill('NOC-77');
  await dialog().getByRole('button', { name: /Upload 2 files/ }).click();
  await expect(dialog()).toHaveCount(0);
  await expect(page.locator('.doc-row')).toHaveCount(2);
  await expect(page.locator('.manifest')).toContainText('2');

  await search('ind-1');
  const nocs = page.locator('.result-section').filter({ has: page.getByRole('heading', { name: /^NOCs/ }) });
  await expect(nocs.locator('a.tr').first()).toContainText('Ind-1');
  await expect(nocs.locator('.stamp')).toBeVisible();

  await search('noc-');
  const docs = page.locator('.result-section').filter({ has: page.getByRole('heading', { name: /^Documents/ }) });
  await expect(docs.locator('.doc-row')).toHaveCount(2);
  for (const link of await docs.locator('.parent-link').all()) await expect(link).toContainText('NOC Ind-1');
  await docs.locator('.parent-link').first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Ind-1' })).toBeVisible();
});

test('edit a NOC', async () => {
  await page.goto('/#/nocs');
  await page.getByRole('row').filter({ hasText: 'Ind-1' }).click();
  await page.getByRole('button', { name: 'Edit' }).click();
  await dialog().getByLabel('NOC Name').fill('Customs NOC for pumps (renewed)');
  await dialog().getByRole('button', { name: 'Save NOC' }).click();
  await expect(dialog()).toHaveCount(0);
  await expect(page.locator('.manifest')).toContainText('Customs NOC for pumps (renewed)');
  await expect(page.locator('.doc-row')).toHaveCount(2);
});

test('contract filters: firm, currency, amount range, category, file type, tag; sort; clear', async () => {
  await page.goto('/#/contracts');
  const rows = page.locator('.table a.tr');
  await expect(rows).toHaveCount(2);
  await page.getByRole('combobox', { name: 'Firm' }).selectOption('Oakline Ltd');
  await expect(rows).toHaveText([/CT-2026-015/]);
  await page.getByRole('button', { name: /Clear 1 filter/ }).click();
  await expect(rows).toHaveCount(2);

  await page.getByRole('combobox', { name: 'Currency' }).selectOption('USD');
  await expect(rows).toHaveText([/CT-2026-014/]);
  await page.getByRole('combobox', { name: 'Currency' }).selectOption('');
  await page.getByLabel('Minimum amount').fill('5000');
  await page.getByLabel('Maximum amount').fill('10000');
  await expect(rows).toHaveText([/CT-2026-015/]);
  await page.getByLabel('Minimum amount').fill('');
  await page.getByLabel('Maximum amount').fill('');

  await page.getByRole('combobox', { name: 'Category' }).selectOption('Packing List');
  await expect(rows).toHaveText([/CT-2026-014/]);
  await page.getByRole('combobox', { name: 'Category' }).selectOption('');
  await page.getByRole('combobox', { name: 'File type' }).selectOption('image');
  await expect(rows).toHaveText([/CT-2026-014/]);
  await page.getByRole('combobox', { name: 'File type' }).selectOption('');
  await page.getByRole('combobox', { name: 'Tag' }).selectOption('Paid');
  await expect(rows).toHaveCount(2); // both contracts have a "Paid" document
  await page.getByRole('combobox', { name: 'Project' }).selectOption('Valve Retrofit');
  await expect(rows).toHaveText([/CT-2026-015/]);
  await page.getByRole('button', { name: /Clear 2 filters/ }).click();

  await page.getByRole('combobox', { name: 'Sort' }).selectOption('amount_asc');
  await expect(rows).toHaveText([/CT-2026-015/, /CT-2026-014/]);
  await page.getByRole('combobox', { name: 'Sort' }).selectOption('amount_desc');
  await expect(rows).toHaveText([/CT-2026-014/, /CT-2026-015/]);
});

test('search page filters narrow documents and hide NOCs for contract-only filters', async () => {
  await search('');
  await page.getByRole('combobox', { name: 'File type' }).selectOption('image');
  const docs = page.locator('.result-section').filter({ has: page.getByRole('heading', { name: /^Documents/ }) });
  await expect(docs.locator('.doc-row')).toHaveCount(2); // BL scan + noc-stamp
  await page.getByRole('combobox', { name: 'Firm' }).selectOption('Northwind Trading');
  await expect(docs.locator('.doc-row')).toHaveCount(1);
  await expect(page.getByText('NOCs have no project, firm or amount, so those filters hide them.')).toBeVisible();
});

test('pagination pages through long lists', async ({ request }) => {
  for (let i = 0; i < 30; i++) {
    const r = await request.post('/api/contracts', { data: { contract_no: `BULK-${String(i).padStart(2, '0')}`, project_name: 'Bulk', firm_name: 'Bulk Firm', amount: i, currency: 'PKR' } });
    expect(r.ok()).toBeTruthy();
  }
  await page.goto('/#/contracts?q=BULK');
  await expect(page.locator('.table a.tr')).toHaveCount(25);
  await expect(page.locator('.pager')).toContainText('1–25 of 30');
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.locator('.table a.tr')).toHaveCount(5);
  await expect(page.locator('.pager')).toContainText('26–30 of 30');
  await page.getByRole('button', { name: 'Prev' }).click();
  await expect(page.locator('.table a.tr')).toHaveCount(25);
});

async function readSheet(wb, name) {
  const ws = wb.getWorksheet(name);
  const head = ws.getRow(1).values;
  const out = [];
  ws.eachRow((row, i) => i > 1 && out.push(Object.fromEntries(head.map((h, j) => [h, row.values[j] ?? '']).filter(([h]) => h))));
  return out;
}

test('filtered Excel export from the UI links every document to its parent', async ({ request }) => {
  await page.goto('/#/contracts');
  await page.getByRole('combobox', { name: 'Firm' }).selectOption('Northwind Trading');
  await expect(page.getByRole('link', { name: /Export to Excel/ })).toContainText('filtered');
  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: /Export to Excel/ }).click();
  const d = await download;
  expect(d.suggestedFilename()).toMatch(/^contract-desk-export-\d{4}-\d{2}-\d{2}\.xlsx$/);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(await d.path());
  expect(wb.getWorksheet('NOCs')).toBeUndefined(); // contracts page exports contracts only
  const contracts = await readSheet(wb, 'Contracts');
  expect(contracts.map((c) => c['Contract No.'])).toEqual(['CT-2026-014']);
  expect(contracts[0].Attachments).toBe(4);
  const docs = await readSheet(wb, 'Documents');
  expect(docs).toHaveLength(4);
  const real = (await (await request.get(`/api/contracts?q=CT-2026-014`)).json()).items[0];
  const full = await (await request.get(`/api/contracts/${real.id}`)).json();
  for (const row of docs) {
    const doc = full.documents.find((x) => x.id === row['Document ID']);
    expect(doc, `document ${row['Document ID']} exists`).toBeTruthy();
    expect(row['Parent Type']).toBe('Contract');
    expect(row['Contract No. / Indent No.']).toBe('CT-2026-014');
    expect(row['Original Filename']).toBe(doc.original_name);
    expect(row.Category).toBe(doc.category);
  }
  const inv = docs.find((r) => r['Reference No.'] === 'INV-2026-001');
  expect(inv['Document Name']).toBe('Final invoice (signed)');
  expect(inv.Tags).toBe('Paid, Urgent');

  // Search page "all" export includes NOCs and their documents.
  await search('');
  const all = page.waitForEvent('download');
  await page.getByRole('link', { name: /Export to Excel/ }).click();
  const wbAll = new ExcelJS.Workbook();
  await wbAll.xlsx.readFile(await (await all).path());
  const nocDocs = (await readSheet(wbAll, 'Documents')).filter((r) => r['Parent Type'] === 'NOC');
  expect(nocDocs.map((r) => r['Contract No. / Indent No.'])).toEqual(['Ind-1', 'Ind-1']);
  expect((await readSheet(wbAll, 'NOCs'))[0].Attachments).toBe(2);
});

test('deleting a document asks first, then removes only its record and file', async () => {
  await page.goto('/#/contracts?q=CT-2026-014');
  await page.getByRole('row').filter({ hasText: 'CT-2026-014' }).click();
  const target = docRow('BL scan');
  const before = storedFiles();

  await target.getByRole('button', { name: 'Delete' }).click();
  await expect(dialog()).toContainText('removes the document record and its stored file bl-scan.png');
  await dialog().getByRole('button', { name: 'Keep it' }).click();
  await expect(target).toBeVisible();
  expect(storedFiles()).toEqual(before);

  await target.getByRole('button', { name: 'Delete' }).click();
  await dialog().getByRole('button', { name: 'Delete' }).click();
  await expect(target).toHaveCount(0);
  expect(storedFiles()).toHaveLength(before.length - 1);
  await expect(page.locator('.manifest')).toContainText('3');
});

test('deleting a contract warns about its documents and files, then removes exactly those', async () => {
  const before = storedFiles();
  await page.getByRole('button', { name: 'Delete' }).first().click();
  const d = dialog();
  await expect(d.getByRole('heading')).toHaveText('Delete contract CT-2026-014?');
  await expect(d).toContainText('also deletes all 3 attached documents and permanently removes their files');
  await expect(d.locator('.confirm-list li')).toHaveCount(3);
  await d.getByRole('button', { name: 'Delete contract and 3 documents' }).click();
  await expect(page).toHaveURL(/#\/contracts$/);
  await expect(page.getByRole('row').filter({ hasText: 'CT-2026-014' })).toHaveCount(0);
  expect(storedFiles()).toHaveLength(before.length - 3);
  await search('INV-2026-001');
  await expect(page.locator('.doc-row')).toHaveCount(0);
});

test('deleting a NOC removes its documents and files', async () => {
  const before = storedFiles();
  await page.goto('/#/nocs');
  await page.getByRole('row').filter({ hasText: 'Ind-1' }).click();
  await page.getByRole('button', { name: 'Delete' }).first().click();
  await expect(dialog()).toContainText('noc-letter');
  await dialog().getByRole('button', { name: 'Delete NOC and 2 documents' }).click();
  await expect(page).toHaveURL(/#\/nocs$/);
  expect(storedFiles()).toHaveLength(before.length - 2);
  // what remains is CT-2026-015's single document
  expect(storedFiles()).toHaveLength(1);
});

test('keyboard and history: "/" jumps to search, Back returns to the previous page', async () => {
  await page.goto('/#/contracts');
  await expect(page.getByRole('heading', { level: 1, name: /Contracts/ })).toBeVisible(); // app loaded, shortcut listener attached
  await page.locator('body').click();
  await page.keyboard.press('/');
  await expect(page).toHaveURL(/#\/$/);
  await expect(page.locator('#q')).toBeFocused();
  await page.goBack();
  await expect(page).toHaveURL(/#\/contracts$/);
  await expect(page.getByRole('heading', { level: 1, name: /Contracts/ })).toBeVisible();
});

test('phone width: no sideways scrolling on main pages', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const url of ['/#/', '/#/contracts', '/#/nocs', '/#/contracts?q=CT-2026-015']) {
    await page.goto(url);
    await page.waitForLoadState('networkidle');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `horizontal overflow on ${url}`).toBeLessThanOrEqual(0);
  }
  await page.setViewportSize({ width: 1280, height: 800 });
});

test('theme switch flips light/dark, is remembered after reload, and flips back', async () => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/#/');
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const light = await bg();
  await page.getByRole('button', { name: 'Switch to dark theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await bg()).not.toBe(light);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark'); // applied before the app starts
  await page.getByRole('button', { name: 'Switch to light theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await bg()).toBe(light);
  // A dark system still shows light when light was chosen.
  await page.emulateMedia({ colorScheme: 'dark' });
  expect(await bg()).toBe(light);
  await page.emulateMedia({ colorScheme: null });
});

test('no unexpected browser errors during the whole run', async () => {
  expect(pageErrors).toEqual([]);
});
