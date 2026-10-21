---
id: TASK-12
title: 'Proof: phone data survives uninstall and reinstall'
status: Done
assignee: []
created_date: '2026-10-21 07:45'
updated_date: '2026-10-21 08:06'
labels:
  - android
milestone: m-0
dependencies: []
priority: high
type: task
ordinal: 1500
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Owner requirement: uninstalling the app must not remove records or files. A reinstalled or newer version picks the data up automatically from the same folder, or the user can choose a folder. Android erases app-private storage on uninstall, so data must live in a shared folder (suggested Documents/Contract Desk). Throwaway proof on the real phone; result goes in a decision record.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 With 'All files access' granted, the app writes a database file and documents to Documents/Contract Desk
- [x] #2 Uninstall, reinstall (and install a newer version): the app finds and opens the same records and files with no user action besides granting the permission
- [x] #3 User can choose a different folder; choosing a folder that already has records opens them
- [x] #4 SQLite WASM working copy + copy in the shared folder stays consistent; which copy wins at start is decided and proven
- [x] #5 Behaviour without the permission (denied) is decided: user picks the folder instead, nothing is lost
- [x] #6 Decision record written; proof code thrown away
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Proven on the S24+ (Android 16). Data lives in Documents/Contract Desk (contracts.db + files/, same as desktop) and survived full uninstall twice; reinstall and a newer version (versionCode 2) opened the same records (3,003/3,004 contracts, 10,000 documents, search hit) and files (SHA-256 match) after only granting All files access. In-app request opens Samsung's All files access page for the app (one switch). Without the permission a reinstalled app cannot read or delete old files; with it, read/overwrite/delete all worked. Working DB stays sqlite-wasm in OPFS; saved copy written 2 s after changes via export + 4 MB pieces + rename (0.6 s for 8.3 MB); start rule: folder copy wins unless the phone has newer unsaved changes to the same file (gen counter + saved marker kept inside the DB, not localStorage). Folder picker (ACTION_OPEN_DOCUMENT_TREE) opened a desktop-made folder. Permission refused: user picks the folder, all I/O goes through the picker link; proven incl. 50 MB file. See decision-2. Proof app, code and test folders deleted.
<!-- SECTION:FINAL_SUMMARY:END -->
