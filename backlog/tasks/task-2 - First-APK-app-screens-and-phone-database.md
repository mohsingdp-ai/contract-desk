---
id: TASK-2
title: 'First APK: app screens and phone database'
status: Done
assignee: []
created_date: '2026-10-21 07:07'
updated_date: '2026-10-21 09:51'
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
- [x] #1 APK installs on a real Android phone and opens to Search, offline
- [x] #2 Add a contract, restart the phone: contract is still there
- [x] #3 Contracts: add, edit, delete, list, sort
- [x] #4 NOCs: add, edit, delete, list; NOC documents have no category
- [x] #5 Duplicate Contract No. or Indent No. is refused, ignoring case (CT-001 = ct-001)
- [x] #6 Delete warnings say what goes with it (e.g. 4 documents and their files)
- [x] #7 Edit a document: rename, change category, Reference No. and tags; tag suggestions shown; 'Urgent' and ' urgent ' are one tag
- [x] #8 Document categories: add, rename, reorder, remove (moves its documents first)
- [x] #9 Has its own automated test that runs with npm test
- [x] #10 Data folder (decision-2): first launch asks for All files access and uses Documents/Contract Desk (contracts.db + files/, same layout as desktop); user can choose another folder with the system picker; choosing a folder with records opens them
- [x] #11 Uninstall, then reinstall or install a newer version: the same records open automatically once the permission is on (tested on the real phone)
- [x] #12 Permission refused: user picks the folder with the system picker and everything works; nothing is lost
- [x] #13 Database copy saved to the folder ~2 s after the last change, never half-written; startup picks the right copy and recovers from a leftover contracts.db.tmp
- [x] #14 A folder made by the desktop app (WAL mode) opens on the phone, and the phone's folder opens on the desktop
- [x] #15 minSdkVersion 30 (Android 11); a WebView too old for the database shows 'Update Android System WebView' instead of failing
- [x] #16 Desktop-only parts (Wi-Fi phone access, QR pairing, passcode) are hidden on the phone; the data-folder control uses the phone's own folder flow from decision-2
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
From TASK-1 review: sqlite-wasm logs 'sqlite3_step() rc=...' on every constraint failure; silence that logging in the phone worker. A desktop contracts.db is WAL mode and sqlite-wasm can't open it (SQLITE_CANTOPEN): set header bytes 18/19 to 1 (or journal_mode=DELETE) before opening a folder that came from the desktop.

Progress 2026-10-21 08:45 UTC (implementer):
- Built: Capacitor 8.5.3 Android project (android/, minSdk 30, MANAGE_EXTERNAL_STORAGE, allowBackup=false), Folder plugin (FolderPlugin.java: All files access, picker, write/rename/stat/remove/list/copy for paths and picker links), phone database worker (client/src/phone-worker.js), folder copy scheme (client/src/phone.js), shared route table (core/routes.js, used by server and worker), setup/WebView screens, desktop-only parts hidden.
- Found and fixed: the desktop never closed its database, so a closed desktop folder kept all recent records in contracts.db-wal (contracts.db was 4 KB after stopping the server). openDb now closes on exit (Electron quit and Ctrl+C verified: -wal merged and removed). The phone refuses a folder with a non-empty contracts.db-wal instead of opening old records.
- npm test: 20 + 20 acceptance + 17 phone checks (test/phone.mjs). npm run build && npm run test:e2e: 39 passed.
- Real phone so far: #1 (setup screen, then Search in airplane mode), #3, #5, NOC add/edit/delete/list, categories add/rename/reorder/remove (empty), first-launch All files access flow creating Documents/Contract Desk (contracts.db + files/). Phone rebooted for #2 and has not reconnected over USB since (needs unlocking).

Second phone session (after the reboot):
- Found on the phone: the modified time Android reports for contracts.db after a rename is sometimes the OLD file's (ls/stat showed 13:59 for a file written at 14:05). With decision-2's size|mtime marker this made a restart re-open the folder copy and drop an unsaved change (IND-KILLED lost). Fixed: the marker is now size + SHA-256 of the file bytes (phone.js fileKey); start-up reads the file once (~150 KB here). After the fix the same kill test saved the change at start-up, and two restarts with no change left the file untouched (same inode and hash).
- WebView too old (#15) was simulated on the real phone: DevTools paused the new database worker before its code ran and removed FileSystemSyncAccessHandle; the app showed 'Update Android System WebView'. Same check runs in npm test.

Review fixes (2026-10-21 09:36 UTC):
1. Save race: each save now notes the new file's fingerprint as 'pending' in the phone database before writing contracts.db.tmp. At start, a folder file (or leftover .tmp) matching either the saved or the pending fingerprint counts as the phone's own, so newer phone changes are saved instead of dropped. test/phone.mjs kills the app after the replace and after the .tmp write, with a newer change waiting: both changes end up in the folder. With the pending note removed, the test fails (CT-B missing).
2. Chosen folder after reinstall: with All files access the app writes the folder path to Documents/.contract-desk-folder when it starts using a folder; a fresh install reads it and opens that folder if it has contracts.db (otherwise Documents/Contract Desk). Picker mode unchanged. Real phone: chose 'Contract Desk Chosen', uninstalled, reinstalled, access on: the strip showed .../Contract Desk Chosen with its records (CT-CHOSEN). The pointer file stays after uninstall on purpose.
3. Phone launch no longer focuses the search box (no keyboard; mInputShown=false). Desktop unchanged.
4. Delete warning for one document: 'This also deletes its attached document and permanently removes its file…'.
5. Removed Capacitor's Example*Test.java templates.
Tests: npm test 20 + 20 + 20 phone checks; npm run build && npm run test:e2e 39 passed. Phone cleaned up and app uninstalled.

Final fixes: (1) the folder note (Documents/.contract-desk-folder) is now synced to the folder in use whenever All files access is on, at start-up, after a folder change and when coming back to the app, including a folder picked with the picker while access was off. New check in test/phone.mjs (X with access, access off, pick Y, access on, reinstall: Y opens); it fails without the fix. (2) 'Move my records here?' uses singular/plural (1 contract, 2 NOCs). npm test 20 + 20 + 21 phone checks; test:e2e 39 passed.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
What works (all seen on the Galaxy S24+, Android 16, plus automated tests):
- The APK (minSdk 30) installs and opens to Search in airplane mode. Records survive a full phone restart.
- Contracts and NOCs: add, edit, delete, list, sort. Duplicates are refused ignoring case. NOC documents have no category. Delete warnings list the documents and files that go (e.g. 'all 4 attached documents'), and the files really leave files/.
- Documents made on the desktop show on the phone (images display from the folder) and can be renamed, re-categorised, given a Reference No. and tags; tag suggestions show; ' urgent ' joins the existing 'Urgent'. Categories: add, rename, reorder, remove (moves its documents first). Upload, open/share and Excel export are hidden on the phone until TASK-3/TASK-4.
- Data folder: first launch asks for All files access and then uses Documents/Contract Desk (contracts.db + files/). 'Change folder…' (bottom of Search) opens the system picker: an empty folder gets 'Move my records here?' (records and files copied, old folder kept); a folder with records gets 'Open the records in this folder?'.
- Uninstall keeps the folder byte-for-byte. Reinstall: records open as soon as the permission is on. Newer version (1.2.1 test build, after uninstall): records opened by themselves. Permission refused: picking the folder opens everything; adding, editing, deleting (file removed) and saving all work through the picker link, and the folder is remembered after a restart. Turning the permission off while the app is in the background shows the setup screen; turning it back on resumes.
- Saved copy: written about 2 s after the last change (measured 1.9 s) via contracts.db.tmp + rename. Killed before the save: the next start saves it. A leftover .tmp is recovered; a damaged one is deleted and contracts.db kept.
- A desktop folder (WAL) opens on the phone; the phone's folder opens on the desktop (records and file served).
- Desktop-only parts (Wi-Fi access, QR, passcode) don't appear on the phone.

Fixed along the way:
- The desktop now closes its database on exit. Before, the last records stayed in contracts.db-wal after quitting, so a copied folder was incomplete. The phone also refuses a folder with an unmerged contracts.db-wal.
- The saved-copy marker uses a content hash, not the file time (unreliable on this phone).

Tests: npm test = 20 + 20 acceptance + 17 phone checks (test/phone.mjs, built bundle in Chromium, simulated Android folder). npm run build && npm run test:e2e: 39 passed.

Limits / not covered:
- 'WebView too old' was simulated by removing the storage API, not tested on a real old WebView.
- A start-up with nothing changed now reads contracts.db once, to hash it (~80 ms per 8 MB, from decision-2 timings), instead of only checking its file details.
- The picker accepts only folders on the phone's own storage.
- allowBackup is off so Android can't restore an old phone database on reinstall.
<!-- SECTION:FINAL_SUMMARY:END -->
