---
id: TASK-4
title: 'Phone search, filters and Excel export'
status: Backlog
assignee: []
created_date: '2026-10-21 07:07'
updated_date: '2026-10-21 07:12'
labels:
  - android
milestone: m-0
dependencies:
  - TASK-2
priority: high
type: feature
ordinal: 4000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Search, filters and Excel export work on the phone exactly as on desktop. Export goes out through Android's share menu.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Same data gives the same search results and order as desktop (exact matches first)
- [ ] #2 Every filter works: project, firm, category, file type, tag, amount range, currency
- [ ] #3 Long result lists page correctly; each result opens its parent contract or NOC
- [ ] #4 Excel export (all and filtered, with the separate Documents sheet) opens in a spreadsheet app via the share menu
- [ ] #5 With 3,000 contracts loaded, search results show in under half a second on a low-end phone
- [ ] #6 Has its own automated test that runs with npm test
<!-- AC:END -->
