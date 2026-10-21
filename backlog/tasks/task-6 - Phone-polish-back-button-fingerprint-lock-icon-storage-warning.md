---
id: TASK-6
title: 'Phone polish: back button, fingerprint lock, icon, storage warning'
status: Review
assignee: []
created_date: '2026-10-21 07:07'
updated_date: '2026-10-21 11:44'
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
- [x] #3 App icon and launch screen
- [x] #4 Shows storage used and warns when the phone is nearly full
- [ ] #5 Back button and lock checked by hand on a real phone (automated later in TASK-7)
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Real-phone check (S24+, 2026-10-21):
- Icon: orange square on dark tile in the app drawer, label 'Contract Desk'. Launch: dark screen with the orange square, then 'Opening the desk…', then Search. A ~0.1 s plain black frame shows between splash and the first page (cosmetic).
- Back button: dialog (keyboard closes first, then dialog), document drawer, contract -> Contracts -> Search, and exit only from Search: all as designed.
- Lock: fingerprint enrolled. Turning the switch on asks for fingerprint first (prompt 'Contract Desk / Unlock your records / Use PIN'); cancelling leaves it off. With the switch on: prompt on cold start; cancel -> 'Contract Desk is locked' screen with Unlock (retries); back on the lock screen exits; 'Use PIN' opens the phone PIN entry; prompt again after 3+ min in the background. Not done: an actual fingerprint/PIN success (can't via adb; owner's PIN). AC #5 left for the owner's final fingerprint tap.
- test/phone.mjs lock check (line ~372) is flaky: 1 failure in 4 runs ('Unlock' button detached while clicking: the auto-unlock races with bioFail=false).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Back button: closes an open dialog or document first, then goes back through screens; only Search (or the lock screen) exits the app. Optional fingerprint/face lock (@aparajita/capacitor-biometric-auth 10.0.0, phone PIN also works): off by default, switch under the data folder; asks on opening and after 3 minutes in the background; covers the screen so a half-filled form survives; disabled with a reason when the phone has no screen lock, and never locks the owner out. App icon and launch screen made from client/public icons (scripts/android-icons.sh). Storage line shows what the data folder uses and free space; warns under 500 MB free, also in the upload dialog. Checked in test/phone.mjs; APK builds. Pending phone check: AC3 (icon/launch screen look) and AC5 (back button and lock by hand).
<!-- SECTION:FINAL_SUMMARY:END -->
