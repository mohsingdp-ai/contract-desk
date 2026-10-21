---
id: TASK-10
title: Proof on a real phone (before building)
status: Backlog
assignee: []
created_date: '2026-10-21 07:11'
updated_date: '2026-10-21 07:13'
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
- [ ] #1 Chosen phone SQLite supports the desktop schema as-is: full-text trigram search, foreign keys, CHECK rules, triggers
- [ ] #2 A substring search (e.g. 'V-2026' finds 'INV-2026-001') returns the right row on the phone
- [ ] #3 A 50 MB file saves to app storage and reads back without running out of memory
- [ ] #4 A stored PDF opens in the phone's PDF app; a stored image shows inside the app
- [ ] #5 Decision written in backlog/decisions: which phone database and why
- [ ] #6 Minimum Android version decided and written in the same decision
- [ ] #7 Decided how automated tests run against the phone database (in Node, in a browser, or on an emulator)
- [ ] #8 Proof code is thrown away; only the decision is kept
<!-- AC:END -->
