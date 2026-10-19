// Records an end-user walkthrough video of Contract Desk, driving the real app.
// A title card (heading, how, example) introduces every feature.
// All records and documents are synthetic samples.
//
// Run: npm run build && npm run demo:video   ->  release/contract-desk-walkthrough.mp4
import { chromium } from '@playwright/test';
import ExcelJS from 'exceljs';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 4800;
const PASSCODE = 'demo-2026';
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.resolve('release/video');
const FINAL = path.resolve('release/contract-desk-walkthrough.mp4');
const lanIp = Object.values(os.networkInterfaces()).flat().find((n) => n.family === 'IPv4' && !n.internal)?.address;
const chromiumPath = ['/usr/bin/chromium', '/usr/bin/google-chrome'].find((p) => fs.existsSync(p));
if (!lanIp) throw new Error('A network address is needed for the phone chapter');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-desk-demo-'));
const dataDir = path.join(work, 'data');
const samples = path.join(work, 'samples');
fs.mkdirSync(samples);

// ---------- synthetic sample documents ----------

function pdf(lines) {
  const text = lines.map((l, i) => `BT /F1 ${i ? 13 : 20} Tf 48 ${520 - i * (i ? 26 : 40)} Td (${l}) Tj ET`).join('\n');
  return Buffer.from(
    `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj ` +
      `3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 600]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj ` +
      `4 0 obj<</Length ${text.length}>>stream\n${text}\nendstream endobj 5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n`,
  );
}
const write = (name, buf) => (fs.writeFileSync(path.join(samples, name), buf), path.join(samples, name));
const file = {
  invoice: write('commercial-invoice-0412.pdf', pdf(['COMMERCIAL INVOICE', 'SAMPLE - synthetic document', 'Invoice No. INV-2026-001', 'Seller: Northwind Trading', 'Buyer: Harbor Pumps project', 'Total: USD 125,000.50'])),
  swift: write('swift-mt103-advance.pdf', pdf(['BANK PAYMENT ADVICE (MT103)', 'SAMPLE - synthetic document', 'Reference FT26101', 'Amount: USD 37,500.00'])),
  noc: write('noc-letter-ind-1.pdf', pdf(['NO OBJECTION CERTIFICATE', 'SAMPLE - synthetic document', 'Indent No. Ind-1', 'Subject: import of centrifugal pumps'])),
};
execFileSync('magick', ['-size', '900x620', 'xc:#f4f1e8', '-fill', '#222', '-pointsize', '40', '-annotate', '+50+90', 'BILL OF LADING', '-pointsize', '26', '-annotate', '+50+150', 'SAMPLE - synthetic scan', '-annotate', '+50+200', 'B/L No. MSCU8812   Vessel: MSC Aurora', '-annotate', '+50+250', 'Port of loading: Ningbo   Discharge: Karachi', '-stroke', '#b23416', '-strokewidth', '6', '-fill', 'none', '-draw', 'rectangle 560,380 840,560', path.join(samples, 'bill-of-lading-scan.png')]);
execFileSync('magick', ['-size', '700x700', 'xc:#f4f1e8', '-fill', 'none', '-stroke', '#1d4f91', '-strokewidth', '10', '-draw', 'circle 350,350 350,120', '-stroke', 'none', '-fill', '#1d4f91', '-pointsize', '44', '-annotate', '+215+365', 'APPROVED', '-pointsize', '24', '-annotate', '+250+410', 'SAMPLE STAMP', path.join(samples, 'noc-stamp.png')]);
file.bl = path.join(samples, 'bill-of-lading-scan.png');
file.stamp = path.join(samples, 'noc-stamp.png');
{
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('Packing list').addRows([['Item', 'Qty', 'Net kg'], ['Centrifugal pump 4"', 12, 1840], ['Spare impeller', 24, 310]]);
  file.packing = write('packing-list.xlsx', Buffer.from(await wb.xlsx.writeBuffer()));
}

// ---------- server ----------

const server = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, DATA_DIR: dataDir, PORT: String(PORT), LAN_PASSCODE: PASSCODE }, stdio: ['ignore', 'pipe', 'inherit'] });
// Never leave the helper server running, whatever happens below.
process.on('exit', () => server.kill());
process.on('uncaughtException', (err) => (console.error(err), process.exit(1)));
process.on('unhandledRejection', (err) => (console.error(err), process.exit(1)));
await new Promise((resolve) => server.stdout.on('data', (b) => String(b).includes('running at') && resolve()));
const post = (url, body) => fetch(BASE + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
// A few existing records so lists and filters look like real use.
for (const [no, project, firm, amount, currency] of [
  ['CT-2026-009', 'Valve Retrofit', 'Oakline Ltd', 9500, 'EUR'],
  ['CT-2026-010', 'Cold Store Expansion', 'Meridian Steel Co.', 64200, 'USD'],
  ['CT-2026-011', 'Grid Substation 4', 'Sapphire Textiles', 2150000, 'PKR'],
  ['CT-2026-012', 'Harbor Pumps', 'Northwind Trading', 48750, 'USD'],
  ['CT-2026-013', 'Valve Retrofit', 'Oakline Ltd', 18300, 'EUR'],
])
  await post('/api/contracts', { contract_no: no, project_name: project, firm_name: firm, amount, currency });

// ---------- recording helpers ----------

const browser = await chromium.launch({ executablePath: chromiumPath });
const videos = [];

// A visible cursor and click/tap ripples (headless video shows neither by default).
const pointerScript = () => {
  const mk = () => {
    if (document.getElementById('__cur')) return;
    const st = document.createElement('style');
    st.textContent = '@keyframes __rip{from{transform:scale(.3);opacity:1}to{transform:scale(1.5);opacity:0}}';
    const c = document.createElement('div');
    c.id = '__cur';
    c.style.cssText = 'position:fixed;z-index:2147483647;left:0;top:0;pointer-events:none;transform:translate(-99px,-99px)';
    c.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24"><path d="M5 2.5l14 8.3-6.2 1.6-2.9 6.1z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.documentElement.append(st, c);
    addEventListener('mousemove', (e) => (c.style.transform = `translate(${e.clientX - 5}px,${e.clientY - 3}px)`), true);
    addEventListener(
      'pointerdown',
      (e) => {
        const r = document.createElement('div');
        r.style.cssText = `position:fixed;z-index:2147483646;left:${e.clientX - 22}px;top:${e.clientY - 22}px;width:44px;height:44px;border-radius:50%;border:4px solid #d4401a;pointer-events:none;animation:__rip .55s ease-out forwards`;
        document.documentElement.append(r);
        setTimeout(() => r.remove(), 600);
      },
      true,
    );
  };
  document.readyState === 'loading' ? addEventListener('DOMContentLoaded', mk) : mk();
};

async function context(opts) {
  const ctx = await browser.newContext({ acceptDownloads: true, colorScheme: 'light', ...opts });
  await ctx.addInitScript(pointerScript);
  const page = await ctx.newPage();
  return { ctx, page };
}

function helpers(page, { touch = false } = {}) {
  const wait = (ms) => page.waitForTimeout(ms);
  const point = async (loc) => {
    await loc.scrollIntoViewIfNeeded();
    const b = await loc.boundingBox();
    if (!touch) await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 18 });
    await wait(250);
  };
  const click = async (loc) => {
    await point(loc);
    touch ? await loc.tap() : await loc.click();
    await wait(650);
  };
  const type = async (loc, text) => {
    await click(loc);
    await loc.pressSequentially(text, { delay: 55 });
    await wait(400);
  };
  const choose = async (loc, value) => {
    await point(loc);
    await loc.selectOption(value);
    await wait(700);
  };
  // Full-screen title card in the app's own fonts and colours.
  const card = async (step, title, how, example) => {
    await page.evaluate(
      ({ step, title, how, example }) => {
        const el = document.createElement('div');
        el.id = '__card';
        el.style.cssText = "position:fixed;inset:0;z-index:2147483640;background:#17160f;color:#ece8de;display:grid;place-items:center;font-family:'Archivo Variable',sans-serif;opacity:0;transition:opacity .35s";
        const narrow = innerWidth < 600;
        el.innerHTML = `<div style="width:min(1000px,88vw)">
          <div style="display:flex;align-items:center;gap:14px;margin-bottom:${narrow ? 18 : 26}px">
            <span style="width:28px;height:28px;border:5px solid #d4401a;flex:none"></span>
            <span style="font-family:'Red Hat Mono',monospace;font-size:${narrow ? 15 : 18}px;color:#a8a293">${step}</span></div>
          <h1 style="font-stretch:62%;font-weight:850;font-size:${narrow ? 52 : 92}px;line-height:.92;text-transform:uppercase;margin:0 0 ${narrow ? 20 : 30}px;text-wrap:balance">${title}</h1>
          ${how.length ? `<ol style="font-size:${narrow ? 18 : 25}px;line-height:1.5;margin:0 0 ${narrow ? 18 : 28}px;padding-left:1.3em;color:#d9d3c4">${how.map((h) => `<li>${h}</li>`).join('')}</ol>` : ''}
          ${example ? `<div style="font-family:'Red Hat Mono',monospace;font-size:${narrow ? 15 : 20}px;line-height:1.5;background:#26241d;padding:14px 18px;color:#ece8de"><span style="color:#ff6a3d;font-weight:600">Example&nbsp;&nbsp;</span>${example}</div>` : ''}
        </div>`;
        document.documentElement.append(el);
        requestAnimationFrame(() => (el.style.opacity = '1'));
      },
      { step, title, how, example },
    );
    await wait(2600 + how.join(' ').length * 32 + (example?.length || 0) * 18);
    await page.evaluate(() => {
      const el = document.getElementById('__card');
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 400);
    });
    await wait(500);
  };
  // Small caption for things that happen outside the page (downloads, the phone camera).
  const note = async (html, ms = 2600) => {
    await page.evaluate((html) => {
      const el = document.createElement('div');
      el.id = '__note';
      el.style.cssText =
        "position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483641;background:#17160f;color:#ece8de;padding:12px 20px;font:500 17px/1.4 'Archivo Variable',sans-serif;box-shadow:0 12px 40px rgb(0 0 0/.35);max-width:90vw";
      el.innerHTML = html;
      document.documentElement.append(el);
    }, html);
    await wait(ms);
    await page.evaluate(() => document.getElementById('__note')?.remove());
  };
  return { wait, click, type, choose, card, note, point };
}

const TOTAL = 11;
const step = (n) => `${n} of ${TOTAL}`;

// ================= desktop part =================

{
  const { ctx, page } = await context({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: path.join(OUT, '1'), size: { width: 1440, height: 900 } } });
  const { wait, click, type, choose, card, note } = helpers(page);
  const dialog = page.getByRole('dialog');
  await page.goto(`${BASE}/#/`);
  await page.locator('.search-hero').waitFor();

  await card(
    'Walkthrough',
    'Contract Desk',
    ['File every shipment paper against its contract or NOC.', 'Find any of them in seconds by contract no., invoice ref, tag or firm.', 'Everything stays on your own computer.'],
    'All records and documents in this video are synthetic samples.',
  );

  // 1 — create a contract
  await card(step(1), 'Create a contract', ['Contracts → New contract.', 'Fill in Contract No., project, firm, amount and currency.', 'Create contract: it opens straight away.'], 'CT-2026-014 · Harbor Pumps · Northwind Trading · 125,000.50 USD');
  await click(page.getByRole('link', { name: /^Contracts/ }));
  await click(page.getByRole('button', { name: 'New contract' }));
  await type(dialog.getByLabel('Contract No.'), 'CT-2026-014');
  await type(dialog.getByLabel('Project Name'), 'Harbor Pumps');
  await type(dialog.getByLabel('Firm Name'), 'Northwind Trading');
  await type(dialog.getByLabel('Amount'), '125000.50');
  await dialog.getByLabel('Currency').fill('');
  await type(dialog.getByLabel('Currency'), 'USD');
  await click(dialog.getByRole('button', { name: 'Create contract' }));
  await wait(1200);

  // 2 — upload documents
  await card(step(2), 'Upload documents', ['Add documents → choose several files at once.', 'Pick a category for each file.', 'Optionally add a Reference No. and tags.', 'Upload: each file is filed under its category.'], 'Commercial invoice → Ref INV-2026-001, tags Urgent, Q3');
  await click(page.getByRole('button', { name: 'Add documents' }));
  const chooser = page.waitForEvent('filechooser');
  await click(dialog.locator('.dropzone'));
  await (await chooser).setFiles([file.invoice, file.packing, file.bl, file.swift]);
  await wait(900);
  const rows = dialog.locator('.stage-row');
  const fill = async (i, { category, name, ref, tags = [] }) => {
    const r = rows.nth(i);
    if (name) await r.getByLabel('Display name').fill(''), await type(r.getByLabel('Display name'), name);
    await choose(r.getByLabel('Category'), category);
    if (ref) await type(r.getByLabel('Reference No.'), ref);
    for (const t of tags) {
      const input = r.getByRole('group', { name: 'Tags' }).getByRole('combobox');
      await type(input, t);
      await input.press('Enter');
      await wait(300);
    }
  };
  await fill(0, { category: 'Commercial Invoice', name: 'Commercial invoice', ref: 'INV-2026-001', tags: ['Urgent', 'Q3'] });
  await fill(1, { category: 'Packing List', name: 'Packing list', tags: ['Q3'] });
  await fill(2, { category: 'Bill of Lading / Airway Bill', name: 'Bill of lading', ref: 'MSCU8812' });
  await fill(3, { category: 'Bank Payment Documents', name: 'SWIFT MT103 advance', ref: 'FT26101' });
  await click(dialog.getByRole('button', { name: /Upload 4 files/ }));
  await wait(1500);
  await page.mouse.wheel(0, 380);
  await wait(1800);
  await page.mouse.wheel(0, -380);

  // 3 — search
  await card(step(3), 'Find it with search', ['Type anything you remember: a reference, tag, contract no. or firm.', 'Exact matches come first, marked EXACT.', 'Every document shows its contract or NOC: click it to open.'], 'INV-2026-001  ·  then try the tag “urgent”');
  await click(page.getByRole('link', { name: /^Search/ }));
  await type(page.locator('#q'), 'INV-2026-001');
  await wait(1800);
  await page.locator('#q').fill('');
  await type(page.locator('#q'), 'urgent');
  await wait(1500);
  await click(page.locator('.doc-row .parent-link').first());
  await wait(1400);

  // 4 — preview, rename, tag
  await card(step(4), 'Preview, rename and tag', ['Click a document to preview PDFs and images.', 'Rename it or change its tags and Reference No., then Save.', 'The stored file and its contract never change.'], 'Rename to “Commercial invoice (signed)”, add tag Paid');
  await click(page.getByRole('button', { name: 'Commercial invoice', exact: true }));
  await wait(1800);
  const drawer = page.locator('.drawer');
  await drawer.getByLabel('Display name').scrollIntoViewIfNeeded();
  await drawer.getByLabel('Display name').fill('');
  await type(drawer.getByLabel('Display name'), 'Commercial invoice (signed)');
  const tagInput = drawer.getByRole('group', { name: 'Tags' }).getByRole('combobox');
  await type(tagInput, 'Paid');
  await tagInput.press('Enter');
  await click(drawer.getByRole('button', { name: 'Save changes' }));
  await wait(900);
  await drawer.evaluate((d) => d.scrollTo({ top: 0, behavior: 'smooth' }));
  await wait(900);
  await click(page.getByRole('button', { name: 'Close document' }));
  await click(page.getByRole('button', { name: 'Bill of lading', exact: true }));
  await wait(2000);
  await click(page.getByRole('button', { name: 'Close document' }));

  // 5 — NOCs
  await card(step(5), 'NOCs', ['NOCs → New NOC with its Indent No. and name.', 'Add documents the same way (no categories needed).', 'Search finds NOCs and their files too.'], 'Ind-1 · Customs NOC for pumps');
  await click(page.getByRole('link', { name: /^NOCs/ }));
  await click(page.getByRole('button', { name: 'New NOC' }));
  await type(dialog.getByLabel('Indent No.'), 'Ind-1');
  await type(dialog.getByLabel('NOC Name'), 'Customs NOC for pumps');
  await click(dialog.getByRole('button', { name: 'Create NOC' }));
  await wait(900);
  await click(page.getByRole('button', { name: 'Add documents' }));
  const chooser2 = page.waitForEvent('filechooser');
  await click(dialog.locator('.dropzone'));
  await (await chooser2).setFiles([file.noc, file.stamp]);
  await wait(800);
  await type(dialog.locator('.stage-row').nth(1).getByLabel('Reference No.'), 'NOC-77');
  await click(dialog.getByRole('button', { name: /Upload 2 files/ }));
  await wait(1200);
  await click(page.getByRole('link', { name: /^Search/ }));
  await type(page.locator('#q'), 'Ind-1');
  await wait(2000);

  // 6 — filters & sort
  await card(step(6), 'Filter and sort', ['Contracts page: narrow by project, firm, currency or amount.', 'Or by what is filed: category, file type, tag.', 'Sort by number or amount. Clear filters in one click.'], 'Currency USD · amount 40,000 – 200,000');
  await click(page.getByRole('link', { name: /^Contracts/ }));
  await wait(800);
  await choose(page.getByRole('combobox', { name: 'Currency' }), 'USD');
  await type(page.getByLabel('Minimum amount'), '40000');
  await type(page.getByLabel('Maximum amount'), '200000');
  await wait(1200);
  await choose(page.getByRole('combobox', { name: 'Sort' }), 'amount_desc');
  await wait(1200);
  await click(page.getByRole('button', { name: /Clear \d filter/ }));
  await choose(page.getByRole('combobox', { name: 'Firm' }), 'Northwind Trading');
  await wait(1000);

  // 7 — export
  await card(step(7), 'Export to Excel', ['Filter what you want, then Export to Excel.', 'The file lists records, attachment counts, and one row per document with its contract or NOC.', 'Your files themselves are not copied into it.'], 'Firm: Northwind Trading → filtered export');
  const download = page.waitForEvent('download');
  await click(page.getByRole('link', { name: /Export to Excel/ }));
  const xlsx = await (await download).path();
  await note(`Downloaded <b style="font-family:'Red Hat Mono'">${(await download).suggestedFilename()}</b>`, 1600);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(xlsx);
  const sheetHtml = (name, cols, max = 6) => {
    const ws = wb.getWorksheet(name);
    if (!ws) return '';
    const head = ws.getRow(1).values;
    const idx = cols.map((c) => head.indexOf(c));
    const rowsHtml = [];
    ws.eachRow((r, i) => i > 1 && rowsHtml.length < max && rowsHtml.push(`<tr>${idx.map((j) => `<td>${r.values[j] ?? ''}</td>`).join('')}</tr>`));
    return `<h3>${name} sheet</h3><table><tr>${cols.map((c) => `<th>${c}</th>`).join('')}</tr>${rowsHtml.join('')}</table>`;
  };
  const inside = sheetHtml('Contracts', ['Contract No.', 'Project Name', 'Firm Name', 'Amount', 'Currency', 'Attachments']) + sheetHtml('Documents', ['Parent Type', 'Contract No. / Indent No.', 'Document Name', 'Category', 'Reference No.', 'Tags']);
  await page.evaluate((html) => {
    const el = document.createElement('div');
    el.id = '__xlsx';
    el.style.cssText = "position:fixed;inset:60px 80px;z-index:2147483640;background:#fff;color:#111;padding:28px 34px;box-shadow:0 30px 80px rgb(0 0 0/.45);font:14px/1.4 'Archivo Variable',sans-serif;overflow:auto";
    el.innerHTML = `<style>#__xlsx h2{margin:0 0 4px;font-size:22px}#__xlsx h3{margin:22px 0 8px;font-size:15px;color:#555}#__xlsx table{border-collapse:collapse;width:100%}#__xlsx th{background:#1b1a16;color:#fff;text-align:left;padding:7px 10px;font-weight:600}#__xlsx td{border-bottom:1px solid #ddd;padding:7px 10px;font-family:'Red Hat Mono',monospace;font-size:13px}</style><h2>Inside the Excel file</h2>${html}`;
    document.documentElement.append(el);
  }, inside);
  await wait(6500);
  await page.evaluate(() => document.getElementById('__xlsx').remove());

  // 8 — delete safely
  await card(step(8), 'Delete safely', ['Every delete asks first.', 'Deleting a contract or NOC lists every document and file that goes with it.', '“Keep it” cancels.'], 'Delete one document · look at the contract warning, then keep it');
  await page.goto(`${BASE}/#/contracts?q=CT-2026-014`);
  await click(page.locator('a.tr').filter({ hasText: 'CT-2026-014' }));
  await click(page.locator('.doc-row').filter({ hasText: 'SWIFT MT103 advance' }).getByRole('button', { name: 'Delete' }));
  await wait(1600);
  await click(dialog.getByRole('button', { name: 'Delete' }));
  await wait(1000);
  await click(page.locator('.record-head').getByRole('button', { name: 'Delete' }));
  await wait(3200);
  await click(dialog.getByRole('button', { name: 'Keep it' }));

  // 9 — theme
  await card(step(9), 'Light or dark', ['Use the theme button in the sidebar.', 'Your choice is remembered on each device.'], '');
  await click(page.getByRole('button', { name: 'Switch to dark theme' }));
  await wait(2200);
  await click(page.getByRole('link', { name: /^Search/ }));
  await wait(1500);
  await click(page.getByRole('button', { name: 'Switch to light theme' }));
  await wait(1000);

  // 10 — phone (computer side)
  await card(step(10), 'Use it on your phone', ['Desktop app: Phone menu → Turn phone access on.', 'Click Connect phone in the sidebar.', 'Scan the QR code with the phone’s camera: it opens already unlocked.', 'Phone and computer must be on the same Wi-Fi.'], 'Each QR code works once and expires after 10 minutes');
  const pairResponse = page.waitForResponse((r) => r.url().endsWith('/api/pair'));
  await click(page.getByRole('button', { name: 'Connect phone' }));
  globalThis.pairUrl = (await (await pairResponse).json()).links.find((l) => l.url.includes(lanIp)).url;
  await wait(3500);
  await note('Now scan this code with your phone’s camera…', 2400);

  await ctx.close();
  videos.push({ file: await page.video().path(), kind: 'desk' });
}

// ================= phone part =================

{
  const { ctx, page } = await context({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, recordVideo: { dir: path.join(OUT, '2'), size: { width: 390, height: 844 } } });
  const { wait, click, type, note } = helpers(page, { touch: true });
  await page.goto(globalThis.pairUrl);
  await page.locator('.search-hero').waitFor();
  await note('Opened from the QR code: no passcode needed', 2600);
  await type(page.locator('#q'), 'INV-2026-001');
  await wait(1500);
  await click(page.locator('.doc-row').first().getByRole('button').first());
  await wait(1500);
  await click(page.getByRole('link', { name: 'Open PDF' }).or(page.locator('.drawer .btn').first())).catch(() => {});
  await note('PDFs open in the phone’s own viewer', 2200);
  await click(page.getByRole('button', { name: 'Close document' }));
  await note('Tip: browser menu → Add to Home Screen for an app icon', 2800);
  await ctx.close();
  videos.push({ file: await page.video().path(), kind: 'phone' });
}

// ================= closing card =================

{
  const { ctx, page } = await context({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: path.join(OUT, '3'), size: { width: 1440, height: 900 } } });
  const { card, wait } = helpers(page);
  await page.goto(`${BASE}/#/`);
  await page.locator('.search-hero').waitFor();
  await card(
    step(11),
    'Install it',
    ['Download from the GitHub Releases page.', 'Windows: run the .exe (if warned: More info → Run anyway).', 'Linux: make the .AppImage executable and double-click it.', 'Your records live in Documents/Contract Desk.'],
    'github.com/mohsingdp-ai/contract-desk/releases',
  );
  await wait(300);
  await ctx.close();
  videos.push({ file: await page.video().path(), kind: 'desk' });
}

await browser.close();
server.kill();

// ---------- stitch into one MP4 ----------

// Phone footage is centred on a dark background in the same 1440x900 frame.
const inputs = videos.flatMap((v) => ['-ss', '0.4', '-i', v.file]);
const filters = videos
  .map((v, i) =>
    v.kind === 'phone'
      ? `[${i}:v]fps=30,scale=-2:900,pad=1440:900:(ow-iw)/2:0:color=0x17160f,setsar=1[v${i}]`
      : `[${i}:v]fps=30,scale=1440:900,setsar=1[v${i}]`,
  )
  .join(';');
const concat = `${videos.map((_, i) => `[v${i}]`).join('')}concat=n=${videos.length}:v=1:a=0[out]`;
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', `${filters};${concat}`, '-map', '[out]', '-c:v', 'libx264', '-crf', '21', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', FINAL]);
fs.rmSync(work, { recursive: true, force: true });
console.log(`Saved ${FINAL}`);
