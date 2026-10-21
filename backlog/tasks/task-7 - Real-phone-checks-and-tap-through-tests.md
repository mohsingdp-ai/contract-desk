---
id: TASK-7
title: Real-phone checks and tap-through tests
status: Backlog
assignee: []
created_date: '2026-10-21 07:07'
updated_date: '2026-10-21 08:06'
labels:
  - android
milestone: m-0
dependencies:
  - TASK-3
  - TASK-4
  - TASK-5
  - TASK-6
priority: high
type: task
ordinal: 7000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Each task already has its own automated tests. This task proves the whole app on real phones, end to end.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Tap-through tests on the APK (Maestro) cover contracts, NOCs, upload, camera, edit document, tags, categories, search, filters, export, delete, backup/restore
- [ ] #2 Data survives an app update
- [ ] #3 3,000 contracts loaded: search under half a second, lists scroll smoothly, backup finishes without errors
- [ ] #4 Checked on one low-end and one recent Android phone, from the minimum Android version (TASK-10) to the newest
- [ ] #5 Phone nearly full: app keeps working or shows a clear message; no records lost
- [ ] #6 Uninstall, reinstall a newer version: records and files open automatically; permission refused path also checked
<!-- AC:END -->
