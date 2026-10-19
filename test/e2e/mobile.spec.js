// Phone-sized, touch-screen checks (emulated Pixel 7). Creates its own synthetic data.
import { test, expect, devices } from '@playwright/test';

const { defaultBrowserType, ...pixel } = devices['Pixel 7'];
test.use(pixel);
test.describe.configure({ mode: 'serial' });

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
let contractId;

test.beforeAll(async ({ request }) => {
  const r = await request.post('/api/contracts', { data: { contract_no: 'MOB-001', project_name: 'Phone check', firm_name: 'Mobile Firm', amount: 1200, currency: 'USD' } });
  contractId = (await r.json()).id;
});

const noSidewaysScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

// Every visible button, icon button, select and text field must be finger-sized.
async function smallTargets(page, scope) {
  return page.locator(scope).evaluate((root) =>
    [...root.querySelectorAll('.btn, .btn-icon, select, input:not([type=file]), .filters-toggle')]
      .filter((el) => el.offsetParent !== null)
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ el, r }) => r.height < 43.5 || (el.classList.contains('btn-icon') && r.width < 43.5)) // allow sub-pixel rounding
      .map(({ el, r }) => `${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') || el.textContent || el.placeholder || '').trim().slice(0, 24)}" ${Math.round(r.width)}x${Math.round(r.height)}`),
  );
}
const smallFonts = (page, scope) =>
  page.locator(scope).evaluate((root) =>
    [...root.querySelectorAll('select, input:not([type=file])')].filter((el) => el.offsetParent !== null && parseFloat(getComputedStyle(el).fontSize) < 16).map((el) => el.getAttribute('aria-label') || el.placeholder || el.name),
  );

test('upload from a phone: dialog fits, controls are finger-sized, Upload stays reachable', async ({ page }) => {
  await page.goto(`/#/contracts/${contractId}`);
  await expect(page.getByRole('heading', { level: 1, name: 'MOB-001' })).toBeVisible();
  await expect(page.getByText('Tap to choose files')).toHaveCount(0); // only inside the dialog
  await page.getByRole('button', { name: 'Add documents' }).tap();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Tap to choose files')).toBeVisible();
  await expect(dialog.getByText('Drop files here')).toBeHidden();
  await dialog.locator('input[type=file]').setInputFiles([
    { name: 'invoice-from-phone.pdf', mimeType: 'application/pdf', buffer: PDF },
    { name: 'second-very-long-filename-for-a-narrow-screen.pdf', mimeType: 'application/pdf', buffer: PDF },
  ]);
  const box = await dialog.boundingBox();
  const vw = page.viewportSize().width;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(vw);
  expect(box.y).toBeLessThan(40); // starts at the top, not off-screen
  await expect(dialog.getByRole('button', { name: /Upload 2 files/ })).toBeInViewport();
  expect(await smallTargets(page, '.modal')).toEqual([]);
  expect(await smallFonts(page, '.modal')).toEqual([]);

  await dialog.getByRole('combobox').first().selectOption('Commercial Invoice');
  await dialog.getByRole('button', { name: /Upload 2 files/ }).tap();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.doc-row')).toHaveCount(2);
  expect(await noSidewaysScroll(page)).toBeLessThanOrEqual(0);
  expect(await smallTargets(page, '.main')).toEqual([]);
});

test('PDF on a phone opens in the phone viewer instead of an in-page frame', async ({ page }) => {
  await page.goto(`/#/contracts/${contractId}`);
  await page.getByRole('button', { name: 'invoice-from-phone', exact: true }).tap();
  const drawer = page.locator('.drawer');
  await expect(drawer).toBeVisible();
  expect((await drawer.boundingBox()).width).toBeGreaterThanOrEqual(page.viewportSize().width - 1);
  await expect(drawer.locator('iframe')).toHaveCount(0);
  const open = drawer.getByRole('link', { name: 'Open PDF' });
  await expect(open).toHaveAttribute('target', '_blank');
  const res = await page.request.get(await open.getAttribute('href'));
  expect(res.headers()['content-type']).toContain('application/pdf');
  await expect(drawer.getByRole('link', { name: 'Open in new tab' })).toHaveCount(0);
  expect(await smallTargets(page, '.drawer')).toEqual([]);
  expect(await smallFonts(page, '.drawer')).toEqual([]);
});

test('filters fold away on a phone and still work', async ({ page }) => {
  await page.goto('/#/contracts');
  const toggle = page.locator('.filters-toggle');
  await expect(toggle).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Firm' })).toBeHidden();
  await expect(page.locator('.table a.tr').first()).toBeInViewport(); // results start on the first screen
  await toggle.tap();
  await page.getByRole('combobox', { name: 'Firm' }).selectOption('Mobile Firm');
  await expect(page.locator('.table a.tr')).toHaveText([/MOB-001/]);
  await expect(toggle).toContainText('1');
  expect(await noSidewaysScroll(page)).toBeLessThanOrEqual(0);
  expect(await smallTargets(page, '.main')).toEqual([]);
  expect(await smallFonts(page, '.main')).toEqual([]);
});

test('search on a phone finds the document and opens its parent', async ({ page }) => {
  await page.goto('/#/');
  await page.locator('#q').fill('invoice-from-phone');
  const row = page.locator('.doc-row').filter({ hasText: 'invoice-from-phone' });
  await expect(row).toBeVisible();
  await row.locator('.parent-link').tap();
  await expect(page.getByRole('heading', { level: 1, name: 'MOB-001' })).toBeVisible();
});

test('delete confirmation is usable on a phone', async ({ page }) => {
  await page.goto(`/#/contracts/${contractId}`);
  await page.getByRole('button', { name: 'Delete' }).first().tap();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('also deletes all 2 attached documents');
  await expect(dialog.getByRole('button', { name: /Delete contract and 2 documents/ })).toBeInViewport();
  expect(await smallTargets(page, '.modal')).toEqual([]);
  await dialog.getByRole('button', { name: /Delete contract and 2 documents/ }).tap();
  await expect(page).toHaveURL(/#\/contracts$/);
});
