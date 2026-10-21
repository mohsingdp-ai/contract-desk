---
id: TASK-2
title: 'First APK: app screens and phone database'
status: Backlog
assignee: []
created_date: '2026-10-21 07:07'
updated_date: '2026-10-21 08:01'
labels:
  - android
milestone: m-0
dependencies:
  - TASK-1
  - TASK-12
priority: high
type: feature
ordinal: 2000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Add Capacitor, build an Android APK that shows the current screens and saves records in the phone database chosen in TASK-10, with no computer needed. Every record feature in the spec must work on the phone.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 APK installs on a real Android phone and opens to Search, offline
- [ ] #2 Add a contract, restart the phone: contract is still there
- [ ] #3 Contracts: add, edit, delete, list, sort
- [ ] #4 NOCs: add, edit, delete, list; NOC documents have no category
- [ ] #5 Duplicate Contract No. or Indent No. is refused, ignoring case (CT-001 = ct-001)
- [ ] #6 Delete warnings say what goes with it (e.g. 4 documents and their files)
- [ ] #7 Edit a document: rename, change category, Reference No. and tags; tag suggestions shown; 'Urgent' and ' urgent ' are one tag
- [ ] #8 Document categories: add, rename, reorder, remove (moves its documents first)
- [ ] #9 Desktop-only parts (phone access, QR, data-folder picker) are hidden on the phone
- [ ] #10 Has its own automated test that runs with npm test
- [ ] #11 Safety copy: within a few seconds of every change the database is also saved as a file in the app's own folder; if the WebView storage is wiped, the app restores everything from that copy at start (tested by wiping it on the real phone)
- [ ] #12 minSdkVersion 29; on a WebView too old for the database, the app says 'Update Android System WebView' instead of failing
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
From TASK-1 review: sqlite-wasm logs 'sqlite3_step() rc=...' on every constraint failure; silence that logging in the phone worker. A desktop contracts.db is WAL mode and sqlite-wasm can't open it (SQLITE_CANTOPEN): set header bytes 18/19 to 1 (or journal_mode=DELETE) before opening a folder that came from the desktop.
<!-- SECTION:NOTES:END -->
