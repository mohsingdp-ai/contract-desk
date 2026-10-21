---
id: TASK-13
title: 'Settings tab: data folder, backup and restore'
status: Backlog
assignee: []
created_date: '2026-10-21 13:35'
labels:
  - android
  - desktop
milestone: m-0
dependencies: []
priority: high
type: feature
ordinal: 11000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Owner request: data folder (show + Change folder…), Backup and Restore move into a Settings tab instead of the Search page footer (phone) and sidebar footer (desktop). Also gathers the other settings that sit in the same footer: storage used/free, fingerprint lock (phone), Document categories link.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Phone: a Settings tab in the top bar next to Search, Contracts, NOCs; desktop: a Settings item in the sidebar
- [ ] #2 Settings shows the data folder path and 'Change folder…' (desktop app: Open + Change…; phone: picker flow from decision-2)
- [ ] #3 Settings has Back up and Restore (same behaviour as today, restore still only on the computer itself for Wi-Fi phones)
- [ ] #4 Phone Settings also holds storage used/free and the fingerprint lock switch; Document categories reachable from Settings on both
- [ ] #5 Search page footer (phone) and sidebar footer (desktop) no longer hold these controls; backup reminder and empty-desk 'Restore a backup…' still work
- [ ] #6 Android back button from Settings returns to the previous screen; existing tests updated, new UI test for Settings on desktop and phone
- [ ] #7 Checked on the real phone
<!-- AC:END -->
