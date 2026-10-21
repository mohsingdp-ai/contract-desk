---
id: TASK-5
title: Backup and restore (phone and desktop)
status: Done
assignee: []
created_date: '2026-10-21 07:07'
updated_date: '2026-10-21 13:40'
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
- [x] #1 Back up, wipe the app, restore: every record and file comes back
- [x] #2 Backup is saved off the phone (share to Drive, email, PC); never only inside the app
- [x] #3 A phone backup restores on desktop, and a desktop backup restores on the phone
- [x] #4 Restore asks for confirmation and says what will be replaced
- [x] #5 App reminds the owner to back up when no backup was made recently
- [x] #6 A damaged backup file is rejected without touching current data
- [x] #7 Backup of 3,000 contracts with their files completes without running out of memory
- [x] #8 Has its own automated test that runs with npm test
- [x] #9 A desktop database (WAL mode) opens on the phone: restore switches it to the phone's journal mode first (sqlite-wasm cannot open WAL files: SQLITE_CANTOPEN)
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Review fixes (round 2):
- Desktop apply is recoverable: current contracts.db moved to contracts.db.before-restore, restored one renamed in and opened; on any error the current one goes back and is reopened (500 'Your current records are still here'); the aside copy is deleted only after the restored one opened. Startup sorts out a crash in between. The check step now also runs the normal set-up (setupDb) on the staged copy (phone: on the in-memory copy), so opening can't surprise. openDb closes its handle if set-up fails.
- Each desktop check stages in its own .restore/<n> folder; phone checks run one at a time. Closing the dialog while checking aborts it (fetch abort / signal) and removes the copy; a check that finishes anyway is cancelled.
- Manifest: format must be a whole number 1..current; every listed name (and size/sha256 shape) is validated before anything is read or written.
- Desktop reminder is no longer hidden on click; the page re-reads the last-backup time on window focus and after 2 s (a cancelled save dialog keeps the reminder).
- Phone: after the restored database is imported, it is marked as the phone's own change to the current folder file, so if the folder save fails the next start saves the phone copy instead of reopening the old one.
- Uploads are refused (409) while a desktop restore is switching.
- Fixed a race found by the Electron test: the server read the client address after the connection closed (cancelled download) and noted the backup; it now decides at request start.

Last review nits: phone restore now replaces the database in ONE worker step ('restore'): the copy is prepared in memory first (set-up, last-backup time, change counter one above the saved marker), then imported, so a kill at any point leaves either the old database or one marked as not yet in the folder; the next start saves it before tidying files. Desktop apply: closing the DB and removing -wal/-shm are inside the recovery block; on failure the restored DB's -wal/-shm are removed before the old one goes back. Tests: phone kill right after the restore step (before the folder save) -> next start saves the restored records with all their files; desktop start-up recovery (set-aside only -> put back; both -> set-aside removed). Counts: acceptance 28/27, phone 50, e2e 42.

Real-phone check (S24+, Android 16, 2026-10-21, build e530a48 then f50fe54 for the big run). Test data: desktop server on a temp folder, 3 contracts, 1 NOC, 5 real documents (2 PDFs from CUPS, 2 JPEGs, 1 PNG), tags + Reference No.
#3/#9 desktop -> phone: the desktop contracts.db was in WAL mode (header bytes 18/19 = 2/2) when its backup was made; restored on the freshly installed phone via Restore a backup -> system picker -> Downloads. Dialog: 'Now: 0 contracts, 0 NOCs, 0 documents / After restoring: 3 contracts, 1 NOCs, 5 documents'. After Replace: all 5 files' SHA-256 on the phone (adb sha256sum) equal the desktop's; folder contracts.db integrity ok, same rows (contracts, NOCs, documents, 3 tag links: same fingerprint), header 1/1. Also a copy of that backup with its database header forced to WAL (2/2, checksum fixed) restored fine on the phone (folder copy in rollback mode, integrity ok).
#2: Back up... on the phone wrote /sdcard/Download/contract-desk-backup-2026-10-21.tar (1,449,472 bytes), the app said 'Backup saved in Downloads as contract-desk-backup-2026-10-21.tar', and Android's share sheet opened with that file; cancelled with Back, nothing sent.
#3 phone -> desktop: that phone .tar (manifest from: phone, 3/1/5) pulled to the PC, POST /api/restore + /api/restore/apply on a desktop server with an empty temp DATA_DIR: counts 3/1/5, same 5 SHA-256, same rows fingerprint.
#1: uninstalled the app AND deleted Documents/Contract Desk, reinstalled, empty desk; Restore a backup -> picker -> the phone backup in Downloads ('made Oct 21, 2026 on a phone', now 0/0/0, after 3/1/5) -> Replace: 3 contracts, 1 NOC, 5 documents back, all 5 SHA-256 identical to before the wipe, same rows fingerprint, integrity ok.
#6 (re-check): a truncated copy (first 900,000 bytes) -> 'This backup file is damaged or is not a Contract Desk backup (it is cut off). Nothing was changed.'; files, hashes and database unchanged, no .restore left. Repeated on the big folder below (10,000 file hashes and DB unchanged).
#4 (re-check): dialog shows now/after counts every time, incl. 'Now: 3,000 contracts, 300 NOCs, 10,000 documents / After restoring: 3 contracts, 1 NOCs, 5 documents'; 'Keep current records' left the big folder as it was.
#7: data folder Documents/CD Big Test with 3,000 contracts, 300 NOCs, 10,000 documents, 20,000 tag links (seedBig) and a real file for each document (15-35 KB, two of 30 MB; 298 MB of files, DB 9.5 MB), opened at start via the folder note. Back up... took about 38 s to the file in Downloads (331,519,488 bytes), then the share sheet (cancelled). No crash, same app and WebView processes throughout. dumpsys meminfo every ~0.3 s: app Java heap 11 -> peak 71 -> 11 MB; app native heap 33 -> 34 MB; app total PSS 185 -> peak 249 -> 135 MB; WebView renderer PSS 138 -> peak 221 -> 177 MB. Pulled .tar: manifest from phone 3000/300/10000, all 10,000 file SHA-256 equal the source files, DB same rows fingerprint, integrity ok.
Bug found and fixed (f50fe54): on the phone the empty desk's three buttons (New contract / New NOC / Restore a backup...) did not fit one row: 'New contract' was cut off on the left and the row widened the page to 417 px on a 384 px screen, so the restore dialog was cut off on the right; the dialog's 'Keep current records' was also cut off on the left. Both rows wrap now; checked on the S24+ (dialog answers stacked, page 384 px wide). phone.mjs asserts both.
Also seen, not fixed: with 3,000 contracts the top bar's NOCS count is hidden under the theme button (CONTRACTS 3,000 NOCS ...).
Cleanup: app uninstalled; Documents/Contract Desk, Documents/CD Big Test, the folder note and all Download test files/backups removed; media index rescanned.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
One backup format for desktop and phone: a plain .tar (manifest.json first with app/format/version/counts and size + SHA-256 of every entry; contracts.db as a consistent rollback-mode copy; files/<storage name>, always '/'). Shared code in core/backup.js (tar writer, streaming reader that validates the whole manifest first, JS SHA-256 for the phone).
Restore never touches data in use before the backup is fully checked (hashes, integrity_check, and the normal set-up run on the copy) AND the owner says yes: staging in <data>/.restore (desktop: one sub-folder per check; phone: document files there, database in memory); failure, cancel or closing the dialog removes only the staging copy. After the yes: files move into files/, then the database is switched recoverably (desktop: old one moved aside, restored one opened, old one put back and reopened on any error; phone: import + .tmp/rename folder save, marked so a failed save is retried from the phone copy). Paths normalised to '/' on every open. Restore only from the computer itself (403 for Wi-Fi phones). Uploads wait while a restore switches.
Backup: desktop sidebar Back up… (streamed download; in the desktop app counted only when Electron reports the save completed, in a browser when streaming finished); phone Back up… (documents copied natively in batches, saved to Downloads, share sheet). Reminder after 14 days without a backup.
Tests: acceptance 27 (node) / 26 (wasm) incl. 463 MB backup+restore (~193 MB server peak), forced switch failures (aside blocked; restored DB unopenable) with old records still served, listed-file-missing / duplicate-entry / bad format, Windows paths, live file kept, Wi-Fi restore refused; phone 49 incl. missing/duplicate entries, unsafe names refused before any file I/O, close-while-checking cleanup, live file untouched, Windows WAL backup; e2e 42 incl. Electron cancel vs save (reminder stays after cancel). APK builds.
Pending real phone: #1, #2, #3, #7, #9.
<!-- SECTION:FINAL_SUMMARY:END -->
