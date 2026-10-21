---
id: TASK-10
title: Proof on a real phone (before building)
status: Done
assignee: []
created_date: '2026-10-21 07:11'
updated_date: '2026-10-21 07:42'
labels:
  - android
milestone: m-0
dependencies: []
priority: high
type: task
ordinal: 500
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
1-2 day throwaway proof that the risky parts work on a real Android phone before task 1 starts. Pick the phone database here.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Chosen phone SQLite supports the desktop schema as-is: full-text trigram search, foreign keys, CHECK rules, triggers
- [x] #2 A substring search (e.g. 'V-2026' finds 'INV-2026-001') returns the right row on the phone
- [x] #3 A 50 MB file saves to app storage and reads back without running out of memory
- [x] #4 A stored PDF opens in the phone's PDF app; a stored image shows inside the app
- [x] #5 Decision written in backlog/decisions: which phone database and why
- [x] #6 Minimum Android version decided and written in the same decision
- [x] #7 Decided how automated tests run against the phone database (in Node, in a browser, or on an emulator)
- [x] #8 Proof code is thrown away; only the decision is kept
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Proved on the S24+ (Android 16). Chosen phone DB: @sqlite.org/sqlite-wasm 3.54.1 with opfs-sahpool in a worker. It runs the desktop schema unchanged, 'V-2026' finds INV-2026-001, and data survives force-stop and reinstall. The same build passes in Node and Chromium; the native plugin also passed but was 27x slower for bulk inserts and can't be tested off-phone. Files: 4 MB chunked writes worked to 500 MB (hash verified); one-call base64 writes OOM/crash at 50 MB. PDF opens via file-opener in Samsung PDF reader; stored image shows in the WebView. Min Android 10 (API 29). Details in decision-1. Proof app uninstalled, code deleted.
<!-- SECTION:FINAL_SUMMARY:END -->
