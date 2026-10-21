// Backup and restore from the desktop screens: reminder, backup download, a lost record restored after confirmation,
// a damaged file refused. Runs on the shared e2e server; the restore brings back exactly what was there before.
import { test, expect } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { E2E_DATA_DIR } from '../../playwright.config.js';

test.describe.configure({ mode: 'serial' });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-desk-e2e-backup-'));
test.afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const PDF = Buffer.from('%PDF-1.4\n% SAMPLE backup test\n%%EOF\n');

test('back up from Settings, lose a record, restore it after confirming what is replaced; a damaged file is refused', async ({ page }) => {
  const c = await (await page.request.post('/api/contracts', { data: { contract_no: 'BACKUP-E2E', amount: 10, currency: 'USD' } })).json();
  const up = await page.request.post(`/api/contracts/${c.id}/documents`, {
    multipart: { files: { name: 'kept.pdf', mimeType: 'application/pdf', buffer: PDF }, meta: JSON.stringify([{ category: 'Commercial Invoice', reference_no: 'REF-E2E-BK' }]) },
  });
  expect(up.status()).toBe(201);
  const [doc] = await up.json();

  await page.goto('/');
  const reminder = page.getByRole('status').filter({ hasText: 'No backup yet.' });
  await expect(reminder).toBeVisible();
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByText(/^Not backed up yet\./)).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('.settings').getByRole('link', { name: 'Back up now' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^contract-desk-backup-\d{4}-\d\d-\d\d\.tar$/);
  const backup = path.join(tmp, download.suggestedFilename());
  await download.saveAs(backup);
  await expect(page.getByText(/^Last backup /)).toBeVisible();
  await page.getByRole('link', { name: 'Search' }).click();
  await expect(reminder).toBeHidden();
  const { counts } = await (await page.request.get('/api/facets')).json();

  // The record and its file are lost.
  await page.goto(`/#/contracts/${c.id}`);
  await page.locator('.record-head').getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('button', { name: 'Delete contract and 1 document' }).click();
  await page.waitForURL(/#\/contracts$/);
  expect(fs.existsSync(path.join(E2E_DATA_DIR, doc.file_path))).toBe(false);

  await page.goto('/#/settings');
  await page.locator('input[aria-label="Backup file"]').setInputFiles(backup);
  const dialog = page.getByRole('dialog', { name: 'Restore from a backup' });
  await expect(dialog.getByText('Everything now in Contract Desk is replaced')).toBeVisible();
  await expect(dialog.getByText(/^Now: /)).toHaveText(`Now: ${counts.contracts - 1} contracts, ${counts.nocs} NOCs, ${counts.documents - 1} documents`);
  await expect(dialog.getByText(/^After restoring: /)).toHaveText(`After restoring: ${counts.contracts} contracts, ${counts.nocs} NOCs, ${counts.documents} documents`);
  await dialog.getByRole('button', { name: 'Replace with backup' }).click();
  await expect(dialog).toBeHidden();
  await page.goto(`/#/contracts/${c.id}`);
  await expect(page.getByRole('heading', { level: 1, name: 'BACKUP-E2E' })).toBeVisible();
  expect(fs.readFileSync(path.join(E2E_DATA_DIR, doc.file_path))).toEqual(PDF);
  await page.goto('/#/?q=REF-E2E-BK');
  await expect(page.locator('.doc-row').first()).toContainText('kept');

  // A damaged backup: refused, nothing changes.
  const bad = path.join(tmp, 'damaged.tar');
  fs.writeFileSync(bad, fs.readFileSync(backup).subarray(0, 3000));
  await page.goto('/#/settings');
  await page.locator('input[aria-label="Backup file"]').setInputFiles(bad);
  await expect(dialog.getByText(/^This backup file is damaged or is not a Contract Desk backup \(.+\)\. Nothing was changed\.$/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Replace with backup' })).toHaveCount(0);
  await dialog.locator('.modal-foot').getByRole('button', { name: 'Close' }).click();
  expect((await (await page.request.get('/api/facets')).json()).counts).toEqual(counts);
});

test('Settings, opened from the sidebar: data folder, Back up now downloads, Restore… opens the dialog, categories link; nothing left in the sidebar footer', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.rail-foot')).toHaveText('Local only · offline'); // data folder and backup moved to Settings
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page).toHaveURL(/#\/settings$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  await expect(page.locator('.setting-path')).toHaveText(E2E_DATA_DIR);
  await expect(page.getByRole('button', { name: 'Change…' })).toHaveCount(0); // only inside the desktop app
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Back up now' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^contract-desk-backup-\d{4}-\d\d-\d\d\.tar$/);
  const backup = path.join(tmp, 'from-settings.tar');
  await download.saveAs(backup);
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Restore…' }).click()]);
  await chooser.setFiles(backup);
  const dialog = page.getByRole('dialog', { name: 'Restore from a backup' });
  await expect(dialog.getByText(/^After restoring: /)).toBeVisible();
  await dialog.getByRole('button', { name: 'Keep current records' }).click();
  await expect(dialog).toBeHidden();
  await page.locator('.settings').getByRole('link', { name: 'Document categories' }).click();
  await expect(page.getByRole('heading', { level: 1, name: /Categories/ })).toBeVisible();
});

test('the reminder comes back when the last backup is more than 14 days old', async ({ page }) => {
  const db = new DatabaseSync(path.join(E2E_DATA_DIR, 'contracts.db'));
  db.prepare(`UPDATE app_state SET value = ? WHERE key = 'last_backup'`).run(new Date(Date.now() - 15 * 864e5).toISOString());
  db.close();
  await page.goto('/');
  const reminder = page.getByRole('status').filter({ hasText: 'Last backup 15 days ago.' });
  await expect(reminder).toBeVisible();
  await expect(reminder.getByRole('link', { name: 'Back up now' })).toHaveAttribute('href', '/api/backup');
});
