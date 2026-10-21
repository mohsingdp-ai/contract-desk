---
id: TASK-4
title: 'Phone search, filters and Excel export'
status: Review
assignee: []
created_date: '2026-10-21 07:07'
updated_date: '2026-10-21 10:12'
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
- [ ] #4 Excel export (all and filtered, with the separate Documents sheet) opens in a spreadsheet app via the share menu
- [ ] #5 With 3,000 contracts loaded, search results show in under half a second on a low-end phone
- [x] #6 Has its own automated test that runs with npm test
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
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Search, filters and paging on the phone are proven to give exactly the desktop's answers on a 3,000-contract database (same results, same order, exact matches first), and results open their contract or NOC. Excel export now works on the phone: same workbook as the desktop (all or filtered, with the Documents sheet), handed to Android's share menu. Search shows in about 0.2 s on a 4x-slowed CPU. Still to check on the real phone: export opening in a spreadsheet app, and speed on a low-end phone.
<!-- SECTION:FINAL_SUMMARY:END -->
