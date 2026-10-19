// Editable document categories, driven through the UI.
import { test, expect } from '@playwright/test';

test.describe.configure({ mode: 'serial' });
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
let contractId;

test.beforeAll(async ({ request }) => {
  const r = await request.post('/api/contracts', { data: { contract_no: 'CATS-001', project_name: 'Categories check', firm_name: 'Cat Firm', amount: 10, currency: 'USD' } });
  contractId = (await r.json()).id;
});

const groupTitles = (page) => page.locator('.doc-group-head h3').allInnerTexts();
const rowNamed = (page, name) => page.locator('.cat-row').filter({ has: page.getByRole('textbox', { name: `Name of ${name}` }) });

test('add, rename and reorder categories; contract pages and upload follow', async ({ page }) => {
  await page.goto(`/#/contracts/${contractId}`);
  await page.getByRole('link', { name: 'Edit categories' }).click();
  await expect(page.getByRole('heading', { level: 1, name: /Categories/ })).toBeVisible();

  await page.getByLabel('New category').fill('Insurance Certificate');
  await page.getByRole('button', { name: 'Add category' }).click();
  await expect(rowNamed(page, 'Insurance Certificate')).toBeVisible();
  await expect(page.getByLabel('New category')).toHaveValue('');

  // Duplicate in another case is refused with a message.
  await page.getByLabel('New category').fill('insurance certificate');
  await page.getByRole('button', { name: 'Add category' }).click();
  await expect(page.locator('.form-error')).toHaveText('A category with that name already exists');
  await page.getByLabel('New category').fill('');

  // Rename: Save appears only once the name changes.
  const name = page.getByRole('textbox', { name: 'Name of Goods Declaration (GD)' });
  await expect(rowNamed(page, 'Goods Declaration (GD)').getByRole('button', { name: 'Save' })).toHaveCount(0);
  await name.fill('Goods Declaration');
  await rowNamed(page, 'Goods Declaration (GD)').getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('textbox', { name: 'Name of Goods Declaration' })).toBeVisible();

  // Move the new category up to the top.
  for (let i = 0; i < 6; i++) await rowNamed(page, 'Insurance Certificate').getByRole('button', { name: 'Move Insurance Certificate up' }).click();
  await expect(rowNamed(page, 'Insurance Certificate').getByRole('button', { name: 'Move Insurance Certificate up' })).toBeDisabled();

  await page.goto(`/#/contracts/${contractId}`);
  const titles = await groupTitles(page);
  expect(titles[0]).toBe('INSURANCE CERTIFICATE');
  expect(titles).toContain('GOODS DECLARATION');
  expect(titles).not.toContain('GOODS DECLARATION (GD)');

  // Upload straight into the new category from its own Add button.
  await page.locator('.doc-group').filter({ has: page.getByRole('heading', { name: 'Insurance Certificate', exact: true }) }).getByRole('button', { name: 'Add' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('input[type=file]').setInputFiles([{ name: 'policy.pdf', mimeType: 'application/pdf', buffer: PDF }]);
  await expect(dialog.getByLabel('Category')).toHaveValue('Insurance Certificate');
  await dialog.getByRole('button', { name: /Upload 1 file/ }).click();
  await expect(page.locator('.doc-group').filter({ hasText: 'Insurance Certificate' }).locator('.doc-row')).toHaveCount(1);

  // The search page filter lists it too.
  await page.goto('/#/');
  await expect(page.getByRole('combobox', { name: 'Category' }).locator('option', { hasText: 'Insurance Certificate' })).toHaveCount(1);
});

test('deleting a category with documents moves them first; nothing is lost', async ({ page }) => {
  await page.goto('/#/categories');
  await expect(rowNamed(page, 'Insurance Certificate')).toContainText('1 document');
  await rowNamed(page, 'Insurance Certificate').getByRole('button', { name: 'Delete Insurance Certificate' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('It has 1 document. It is not deleted');
  await expect(dialog.getByLabel('Move documents to')).toHaveValue(/\d+/);
  await dialog.getByLabel('Move documents to').selectOption({ label: 'Commercial Invoice' });
  await dialog.getByRole('button', { name: 'Move 1 and delete' }).click();
  await expect(rowNamed(page, 'Insurance Certificate')).toHaveCount(0);

  await page.goto(`/#/contracts/${contractId}`);
  expect(await groupTitles(page)).not.toContain('INSURANCE CERTIFICATE');
  await expect(page.locator('.doc-group').filter({ has: page.getByRole('heading', { name: 'Commercial Invoice', exact: true }) }).getByRole('button', { name: 'policy', exact: true })).toBeVisible();

  // Put the original name back for the other suites.
  await page.goto('/#/categories');
  await page.getByRole('textbox', { name: 'Name of Goods Declaration' }).fill('Goods Declaration (GD)');
  await rowNamed(page, 'Goods Declaration').getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('textbox', { name: 'Name of Goods Declaration (GD)' })).toBeVisible();
});
