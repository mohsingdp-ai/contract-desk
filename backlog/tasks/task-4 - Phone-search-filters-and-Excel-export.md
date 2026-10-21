---
id: TASK-4
title: 'Phone search, filters and Excel export'
status: Review
assignee: []
created_date: '2026-10-21 07:07'
updated_date: '2026-10-21 12:29'
labels:
  - android
milestone: m-0
dependencies:
  - TASK-2
priority: high
type: feature
ordinal: 4000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Search, filters and Excel export work on the phone exactly as on desktop. Export goes out through Android's share menu.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Same data gives the same search results and order as desktop (exact matches first)
- [x] #2 Every filter works: project, firm, category, file type, tag, amount range, currency
- [x] #3 Long result lists page correctly; each result opens its parent contract or NOC
- [ ] #4 With 3,000 contracts loaded, search results show in under half a second on a low-end phone
- [x] #5 Has its own automated test that runs with npm test
- [ ] #6 Excel export (all and filtered, with the separate Documents sheet): 'Open' shows it in a spreadsheet app (e.g. Google Sheets) and 'Share' hands it to the share menu
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Search speed, 3,000 contracts + 300 NOCs + 10,000 documents + 20,000 tag links, phone bundle in Chromium, page CPU slowed 4x (DevTools Emulation.setCPUThrottlingRate 4). Chromium cannot slow a worker ("Operation is only supported for pages, not workers"), so the database time measured inside the worker is added 3 more times on top (estimate = screen time + 3 x database time). Screen time includes the 120 ms typing pause.

| Search | On screen | Database (3 lists) | Slow-phone estimate |
| --- | --- | --- | --- |
| CT-30 | 170 ms | 3.2 ms | 180 ms |
| INV-2026-31 | 176 ms | 6.2 ms | 195 ms |
| harbor | 188 ms | 3.4 ms | 198 ms |
| ab (2 letters, slowest path) | 166 ms | 17.3 ms | 218 ms |
| urgent (tag) | 186 ms | 9.8 ms | 215 ms |
| Packing list 42 | 184 ms | 5.4 ms | 201 ms |

All under 0.5 s; the test fails above 0.5 s. Numbers vary a few ms per run.

Excel export on the phone: the worker gives the export data (same shared rule as desktop), the screen builds the workbook with ExcelJS (loaded only when exporting, ~940 kB chunk), writes it in 4 MB pieces to the app cache folder, then the Folder plugin opens Android's share menu (new native methods cacheFolder and share, FileProvider link). Not tried on the real phone yet.

Pending phone check: AC #4 (opens in a spreadsheet app from the share menu) and AC #5 (real low-end phone timing).

Real-phone check (S24+, Android 16, 2026-10-21): data folder with 3,000 contracts, 300 NOCs, 10,000 documents, 20,000 tag links (seedBig from test/phone.mjs), opened via Change folder. Search, typed into the search box, timed from input to all three result counts on screen (includes the 120 ms typing pause), 3 runs each; database time measured inside the worker (3 lists):
| Search | Results (C/N/D) | On screen | Database |
| --- | --- | --- | --- |
| CT-30 | 12/0/0 | 155, 167, 168 ms | 6.0-6.6 ms |
| INV-2026-31 | 0/0/56 | 179, 169, 160 ms | 7.6-8.8 ms |
| harbor | 1000/50/0 | 176, 162, 170 ms | 7.5-8.9 ms |
| ab | 1200/0/0 | 187, 176, 176 ms | 20.3-22.4 ms |
| urgent | 0/0/4000 | 162, 194, 180 ms | 17.5-29.3 ms |
| Packing list 42 | 0/0/22 | 175, 183, 163 ms | 9.3-13.4 ms |
| CT-2999 | 1/0/0 | 164, 153, 159 ms | 7.8-9.7 ms |
Counts match the desktop rules on the same file. AC #5 left open: needs a low-end phone.
Excel export on the phone: 'all' (1-contract DB and 3,000 DB) and 'filtered' (q=harbor) both open the share sheet with contract-desk-export-<date>.xlsx; 3,000-record export reached the share sheet in 1.3 s. Pulled from the app cache and read with exceljs: Contracts 3000 / NOCs 300 / Documents 10000 rows (all), 1000 / 50 / 3283 (harbor) = desktop exportData exactly. Not shown: opening in a spreadsheet app (none installed; Microsoft 365 routes to Copilot upload, not used). AC #4 stays open for the owner. Note: a search that only matches documents exports empty sheets (same shared rule as desktop: documents of matching contracts/NOCs).

Google Sheets check (S24+, 2026-10-21): Sheets does NOT appear in the share menu. Android lists it only for 'Open with' (VIEW), not for share (SEND): package query shows SEND for xlsx -> Drive only; VIEW -> Sheets. The share menu's full app list (More) has no Sheets; Drive would upload, so it was not used. So AC #4 as worded (opens in a spreadsheet app via the share menu) is still not observed. The exported workbook itself is fine: pulled from the app cache (2 contracts, 5 documents), opened directly in Sheets via Open-with: Contracts tab (CT-OTHER, CT-XL) and Documents tab (5 rows, Contract / CT-XL) both show. Options for the owner: accept 'share -> Drive -> Sheets', or add an 'Open in spreadsheet app' button that uses Open-with like documents do.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Search, filters and paging on the phone are proven to give exactly the desktop's answers on a 3,000-contract database (same results, same order, exact matches first), and results open their contract or NOC. Excel export now works on the phone: same workbook as the desktop (all or filtered, with the Documents sheet), handed to Android's share menu. Search shows in about 0.2 s on a 4x-slowed CPU. Still to check on the real phone: export opening in a spreadsheet app, and speed on a low-end phone.
<!-- SECTION:FINAL_SUMMARY:END -->
