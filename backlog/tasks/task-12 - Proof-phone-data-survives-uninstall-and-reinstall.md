---
id: TASK-12
title: 'Proof: phone data survives uninstall and reinstall'
status: Backlog
assignee: []
created_date: '2026-10-21 07:45'
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
- [ ] #1 With 'All files access' granted, the app writes a database file and documents to Documents/Contract Desk
- [ ] #2 Uninstall, reinstall (and install a newer version): the app finds and opens the same records and files with no user action besides granting the permission
- [ ] #3 User can choose a different folder; choosing a folder that already has records opens them
- [ ] #4 SQLite WASM working copy + copy in the shared folder stays consistent; which copy wins at start is decided and proven
- [ ] #5 Behaviour without the permission (denied) is decided: user picks the folder instead, nothing is lost
- [ ] #6 Decision record written; proof code thrown away
<!-- AC:END -->
