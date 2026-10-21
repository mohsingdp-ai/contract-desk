---
id: TASK-1
title: Shared rules for desktop and phone
status: Backlog
assignee: []
created_date: '2026-10-21 07:07'
updated_date: '2026-10-21 07:13'
labels:
  - android
  - desktop
milestone: m-0
dependencies:
  - TASK-10
priority: high
type: feature
ordinal: 1000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Move the server's actions (contracts, NOCs, documents, categories, search, tags, export) into shared code that both the desktop server and the phone app call. Desktop-only parts (Wi-Fi passcode, QR pairing, data-folder picker) stay in the desktop server. Desktop behaviour must not change.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Desktop server calls the shared code for every action except passcode, pairing and data-folder
- [ ] #2 Shared code works with a database that answers later (async), so any phone database fits
- [ ] #3 Database and file storage are passed in; desktop and phone each supply their own
- [ ] #4 npm test and npm run test:e2e pass unchanged
- [ ] #5 The same acceptance tests run against the shared code with the desktop database, and with the phone database in the way decided in TASK-10
<!-- AC:END -->
