---
id: TASK-2
title: 'First APK: app screens and phone database'
status: In Progress
assignee: []
created_date: '2026-10-21 07:07'
updated_date: '2026-10-21 08:06'
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
- [ ] #9 Has its own automated test that runs with npm test
- [ ] #10 Data folder (decision-2): first launch asks for All files access and uses Documents/Contract Desk (contracts.db + files/, same layout as desktop); user can choose another folder with the system picker; choosing a folder with records opens them
- [ ] #11 Uninstall, then reinstall or install a newer version: the same records open automatically once the permission is on (tested on the real phone)
- [ ] #12 Permission refused: user picks the folder with the system picker and everything works; nothing is lost
- [ ] #13 Database copy saved to the folder ~2 s after the last change, never half-written; startup picks the right copy and recovers from a leftover contracts.db.tmp
- [ ] #14 A folder made by the desktop app (WAL mode) opens on the phone, and the phone's folder opens on the desktop
- [ ] #15 minSdkVersion 30 (Android 11); a WebView too old for the database shows 'Update Android System WebView' instead of failing
- [ ] #16 Desktop-only parts (Wi-Fi phone access, QR pairing, passcode) are hidden on the phone; the data-folder control uses the phone's own folder flow from decision-2
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
From TASK-1 review: sqlite-wasm logs 'sqlite3_step() rc=...' on every constraint failure; silence that logging in the phone worker. A desktop contracts.db is WAL mode and sqlite-wasm can't open it (SQLITE_CANTOPEN): set header bytes 18/19 to 1 (or journal_mode=DELETE) before opening a folder that came from the desktop.
<!-- SECTION:NOTES:END -->
