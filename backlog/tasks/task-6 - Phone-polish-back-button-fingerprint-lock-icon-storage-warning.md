---
id: TASK-6
title: 'Phone polish: back button, fingerprint lock, icon, storage warning'
status: Review
assignee: []
created_date: '2026-10-21 07:07'
updated_date: '2026-10-21 10:25'
labels:
  - android
milestone: m-0
dependencies:
  - TASK-2
priority: medium
type: feature
ordinal: 6000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Make it feel like a proper Android app.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Android back button moves back through screens and closes dialogs
- [x] #2 Optional fingerprint/face lock on opening the app
- [ ] #3 App icon and launch screen
- [x] #4 Shows storage used and warns when the phone is nearly full
- [ ] #5 Back button and lock checked by hand on a real phone (automated later in TASK-7)
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Back button: closes an open dialog or document first, then goes back through screens; only Search (or the lock screen) exits the app. Optional fingerprint/face lock (@aparajita/capacitor-biometric-auth 10.0.0, phone PIN also works): off by default, switch under the data folder; asks on opening and after 3 minutes in the background; covers the screen so a half-filled form survives; disabled with a reason when the phone has no screen lock, and never locks the owner out. App icon and launch screen made from client/public icons (scripts/android-icons.sh). Storage line shows what the data folder uses and free space; warns under 500 MB free, also in the upload dialog. Checked in test/phone.mjs; APK builds. Pending phone check: AC3 (icon/launch screen look) and AC5 (back button and lock by hand).
<!-- SECTION:FINAL_SUMMARY:END -->
