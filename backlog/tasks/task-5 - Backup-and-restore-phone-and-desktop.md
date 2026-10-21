---
id: TASK-5
title: Backup and restore (phone and desktop)
status: Review
assignee: []
created_date: '2026-10-21 07:07'
updated_date: '2026-10-21 12:36'
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
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
One backup format for desktop and phone: a plain .tar (manifest.json first with app/format/version/counts and size + SHA-256 of every entry; contracts.db as a consistent rollback-mode copy; files/<storage name>, always '/'). Shared code in core/backup.js (tar writer, streaming reader that validates the whole manifest first, JS SHA-256 for the phone).
Restore never touches data in use before the backup is fully checked (hashes, integrity_check, and the normal set-up run on the copy) AND the owner says yes: staging in <data>/.restore (desktop: one sub-folder per check; phone: document files there, database in memory); failure, cancel or closing the dialog removes only the staging copy. After the yes: files move into files/, then the database is switched recoverably (desktop: old one moved aside, restored one opened, old one put back and reopened on any error; phone: import + .tmp/rename folder save, marked so a failed save is retried from the phone copy). Paths normalised to '/' on every open. Restore only from the computer itself (403 for Wi-Fi phones). Uploads wait while a restore switches.
Backup: desktop sidebar Back up… (streamed download; in the desktop app counted only when Electron reports the save completed, in a browser when streaming finished); phone Back up… (documents copied natively in batches, saved to Downloads, share sheet). Reminder after 14 days without a backup.
Tests: acceptance 27 (node) / 26 (wasm) incl. 463 MB backup+restore (~193 MB server peak), forced switch failures (aside blocked; restored DB unopenable) with old records still served, listed-file-missing / duplicate-entry / bad format, Windows paths, live file kept, Wi-Fi restore refused; phone 49 incl. missing/duplicate entries, unsafe names refused before any file I/O, close-while-checking cleanup, live file untouched, Windows WAL backup; e2e 42 incl. Electron cancel vs save (reminder stays after cancel). APK builds.
Pending real phone: #1, #2, #3, #7, #9.
<!-- SECTION:FINAL_SUMMARY:END -->
