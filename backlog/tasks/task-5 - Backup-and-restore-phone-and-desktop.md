---
id: TASK-5
title: Backup and restore (phone and desktop)
status: Review
assignee: []
created_date: '2026-10-21 07:07'
updated_date: '2026-10-21 11:55'
labels:
  - android
  - desktop
milestone: m-0
dependencies:
  - TASK-3
priority: high
type: feature
ordinal: 5000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Export every record and file to one backup file, and restore it. Needed before release: uninstalling the app erases its data. Build in shared code so desktop gets it too, with one backup format for both.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Back up, wipe the app, restore: every record and file comes back
- [ ] #2 Backup is saved off the phone (share to Drive, email, PC); never only inside the app
- [ ] #3 A phone backup restores on desktop, and a desktop backup restores on the phone
- [x] #4 Restore asks for confirmation and says what will be replaced
- [x] #5 App reminds the owner to back up when no backup was made recently
- [x] #6 A damaged backup file is rejected without touching current data
- [ ] #7 Backup of 3,000 contracts with their files completes without running out of memory
- [x] #8 Has its own automated test that runs with npm test
- [ ] #9 A desktop database (WAL mode) opens on the phone: restore switches it to the phone's journal mode first (sqlite-wasm cannot open WAL files: SQLITE_CANTOPEN)
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
One backup format for desktop and phone: a plain .tar (manifest.json first with app/format/version/counts and size + SHA-256 of every entry; contracts.db as a consistent rollback-mode copy; files/<storage name>, always '/'). Shared code in core/backup.js (tar writer, streaming reader that enforces the manifest, JS SHA-256 for the phone).
Restore never touches data in use before the backup is fully checked AND the owner says yes: desktop stages in <data>/.restore (all hashes + integrity_check), phone stages document files in <data>/.restore/ (the database stays in memory); on any failure or 'Keep current records' only .restore/ is removed. After the yes: files move into files/ (native rename now moves between sub-folders, also in picker mode via moveDocument), then the database is swapped (desktop: one rename + reopen; phone: import + .tmp/rename folder save). Stored paths are normalised to '/' on every open (a Windows desktop's files\name), and desktop uploads now store '/'. Restore is allowed only from the computer itself (403 for Wi-Fi phones; the button is hidden there); backup download over Wi-Fi stays.
Desktop: sidebar Backup -> Back up… (streamed download) and Restore…. In the desktop app the last-backup time is recorded only when Electron reports the download 'completed' (cancelled save dialog = not recorded); in a plain browser it is recorded when the response finished streaming. Phone: Back up… builds the archive in the cache (documents copied natively in batches via Folder.append/hashFiles), saves it to Downloads, opens the share sheet. Reminder on the search page when there are records and no backup for 14 days.
Tests: acceptance 26 (node) / 25 (wasm) incl. 463 MB backup+restore at ~192 MB server peak, Windows-path restore, changed live file kept on damaged restore, Wi-Fi restore refused; phone 48 incl. changed live file untouched on damaged/kept restore and replaced after yes, Windows (WAL + backslash) backup restored on the phone; e2e 42 incl. Electron cancel vs save of the backup download. APK builds.
Pending real phone: #1, #2, #3, #7, #9 (native hashFiles/append/share move/rename-across-folders/folder remove, Android file picker for .tar, Downloads + share sheet, memory on device).
<!-- SECTION:FINAL_SUMMARY:END -->
