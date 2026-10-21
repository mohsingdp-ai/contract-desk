---
id: TASK-5
title: Backup and restore (phone and desktop)
status: Backlog
assignee: []
created_date: '2026-10-21 07:07'
updated_date: '2026-10-21 07:13'
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
- [ ] #4 Restore asks for confirmation and says what will be replaced
- [ ] #5 App reminds the owner to back up when no backup was made recently
- [ ] #6 A damaged backup file is rejected without touching current data
- [ ] #7 Backup of 3,000 contracts with their files completes without running out of memory
- [ ] #8 Has its own automated test that runs with npm test
<!-- AC:END -->
