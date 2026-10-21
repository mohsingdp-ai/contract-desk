---
id: TASK-5
title: Backup and restore (phone and desktop)
status: Review
assignee: []
created_date: '2026-10-21 07:07'
updated_date: '2026-10-21 11:40'
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
One backup format for desktop and phone: a plain .tar (manifest.json first with app/format/version/counts and size + SHA-256 of every entry; contracts.db as a consistent rollback-mode copy; files/<storage name>). Shared code in core/backup.js (tar writer, streaming reader that enforces the manifest, JS SHA-256 for the phone).
Desktop: sidebar Backup → Back up… (streamed download, nothing held in memory) and Restore… (file streamed to the server, staged in <data>/.restore, every hash + integrity_check checked; confirmation shows counts now/after; apply moves files then swaps contracts.db in one rename and reopens). Phone: Back up… builds the archive in the app cache (DB + headers over the bridge in 4 MB pieces; documents copied natively in batches via new Folder.append/hashFiles), saves it to Downloads and opens the share sheet (moved, not copied). Restore… reads the picked file in 4 MB pieces, hashes everything in-stream, writes only new files, imports + saves the folder copy only after the yes; a failed check removes the files it wrote. Last backup time is kept in the DB (app_state); reminder on the search page when there are records and no backup for 14 days. Restored data counts as backed up at the backup's time.
Tests: acceptance (both engines) +4 checks incl. 3,000 contracts / 10,000 files / 463 MB backup+restore with server peak ~207 MB; phone +6 checks (backup, keep/replace confirmation, damaged variants, wipe+restore, phone↔desktop both ways incl. WAL-mode DB, 3,000 contracts with 2×64 MB files: 105 bridge calls, page heap peak ~27 MB); e2e +2 (sidebar backup download, restore with confirmation, damaged file, 14-day reminder). APK builds.
Pending real phone: #1, #2, #3, #7, #9 (new native methods hashFiles/append/share move, Android file picker for .tar, Downloads + share sheet, memory on device).
<!-- SECTION:FINAL_SUMMARY:END -->
