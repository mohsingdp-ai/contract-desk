---
id: TASK-13
title: 'Settings tab: data folder, backup and restore'
status: Review
assignee: []
created_date: '2026-10-21 13:35'
updated_date: '2026-10-21 13:52'
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
- [x] #1 Phone: a Settings tab in the top bar next to Search, Contracts, NOCs; desktop: a Settings item in the sidebar
- [x] #2 Settings shows the data folder path and 'Change folder…' (desktop app: Open + Change…; phone: picker flow from decision-2)
- [x] #3 Settings has Back up and Restore (same behaviour as today, restore still only on the computer itself for Wi-Fi phones)
- [x] #4 Phone Settings also holds storage used/free and the fingerprint lock switch; Document categories reachable from Settings on both
- [x] #5 Search page footer (phone) and sidebar footer (desktop) no longer hold these controls; backup reminder and empty-desk 'Restore a backup…' still work
- [x] #6 Android back button from Settings returns to the previous screen; existing tests updated, new UI test for Settings on desktop and phone
- [ ] #7 Checked on the real phone
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Built on wave/task-13-settings. Settings at #/settings (sidebar item on desktop, gear tab in phone top bar). Phone top bar: theme switch moved into Settings and tab counts hidden up to 440px so it fits 360/412 px with 3,000/300 records (phone.mjs check). Desktop rail-foot keeps only the Local/Wi-Fi status line; nearly-full warning stays on Search. Tests: npm test (28+27 acceptance, 52 phone) and e2e (44) pass; APK builds. AC7 (real phone) not done here.
<!-- SECTION:NOTES:END -->
