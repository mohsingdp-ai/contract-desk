---
id: TASK-9
title: Release signed APK
status: Backlog
assignee: []
created_date: '2026-10-21 07:07'
updated_date: '2026-10-21 07:14'
labels:
  - android
  - desktop
milestone: m-0
dependencies:
  - TASK-8
  - TASK-11
priority: medium
type: task
ordinal: 9000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Build a signed APK through GitHub releases next to the desktop installers. Play Store listing optional.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Tagging a version builds and publishes the signed APK
- [ ] #2 Signing key stored outside the repo, with a safe backup copy (lost key = installed apps can never update)
- [ ] #3 If Play Store is wanted: app bundle (AAB) build and listing
- [ ] #4 Desktop installers released with the same version (they gain backup and restore)
<!-- AC:END -->
