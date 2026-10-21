---
id: TASK-1
title: Shared rules for desktop and phone
status: Done
assignee: []
created_date: '2026-10-21 07:07'
updated_date: '2026-10-21 08:03'
labels:
  - android
  - desktop
milestone: m-0
dependencies:
  - TASK-10
priority: high
type: feature
ordinal: 1000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Move the server's actions (contracts, NOCs, documents, categories, search, tags, export) into shared code that both the desktop server and the phone app call. Desktop-only parts (Wi-Fi passcode, QR pairing, data-folder picker) stay in the desktop server. Desktop behaviour must not change.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Desktop server calls the shared code for every action except passcode, pairing and data-folder
- [x] #2 Database and file storage are passed in; desktop and phone each supply their own
- [x] #3 npm test and npm run test:e2e pass unchanged
- [x] #4 The same acceptance tests run against the shared code with the desktop database, and with the phone database in the way decided in TASK-10
- [x] #5 Shared code runs unchanged in the desktop server and inside the phone's database worker (decision-1: synchronous inside, screens talk to it by messages)
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Business rules (contracts, NOCs, documents and upload record-keeping, categories, tags, search/filters/paging, facets, meta, export data and workbook, delete-with-files, startup file cleanup, error messages) moved from server/index.js into core/ (plain JS, no Node modules, synchronous). The desktop server now only does passcode, QR pairing, host checks, cookies, file streaming (multer, downloads) and the data folder, and calls core for everything else. Each platform passes in its database and a small files object (remove, list, exists). core/wasm-db.js makes the phone's SQLite build (sqlite-wasm 3.54.1) look like the desktop database. npm test now runs all 20 acceptance checks twice: desktop database, then sqlite-wasm (DB_ENGINE=wasm, saved to contracts.db after each change so restart and on-disk checks still apply); nothing skipped. e2e 39/39 pass. Same request script gave identical responses on old code, new code and the wasm engine. Also proved core runs unchanged inside a real Chromium Web Worker on sqlite-wasm (throwaway check; the real phone worker comes in TASK-2).
<!-- SECTION:FINAL_SUMMARY:END -->
