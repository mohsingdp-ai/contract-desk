---
id: TASK-11
title: Update product description and README for Android
status: Done
assignee: []
created_date: '2026-10-21 07:11'
updated_date: '2026-10-21 13:58'
labels:
  - android
milestone: m-0
dependencies:
  - TASK-5
priority: medium
type: task
ordinal: 10000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The product description still says desktop/web only. Update it and the README to match the Android plan.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Product description lists Android as a platform and the phone as a standalone tool
- [x] #2 States that phone and computer keep separate records, and how backup moves them
- [x] #3 README has Android install, backup and restore steps
- [x] #4 README says not to open the same data folder on PC and phone at the same time (copy it while the desktop app is closed), and explains the All files access prompt
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
README: Android install (APK, Auto Blocker off, Android 11+, All files access and why, Choose folder if refused), Wi-Fi browser access kept as its own section; Good to know: separate records on phone and computer, backup/restore via Settings (Back up now / Restore…), restore only on the computer for Wi-Fi phones, never the same data folder on PC and phone at once (copy while the desktop app is closed), optional fingerprint lock, what Settings holds. For developers: Android build prerequisites, android:build/install, how test/phone.mjs runs, FolderPlugin in the code map. PRODUCT.md: Android as a standalone platform, owner on desktop and/or phone, backup/restore moves records, constraints (separate records, shared-storage folder, Android 11+). Docs only, no code.
<!-- SECTION:FINAL_SUMMARY:END -->
