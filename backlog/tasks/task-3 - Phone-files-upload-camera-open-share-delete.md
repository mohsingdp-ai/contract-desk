---
id: TASK-3
title: 'Phone files: upload, camera, open, share, delete'
status: Review
assignee: []
created_date: '2026-10-21 07:07'
updated_date: '2026-10-21 10:12'
labels:
  - android
milestone: m-0
dependencies:
  - TASK-2
priority: high
type: feature
ordinal: 3000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Documents are stored in the data folder's files/ (decision-2), same layout as desktop, written in 4 MB pieces. Upload from files or camera, preview images in the app, open PDFs and Excel in the phone's own apps, save a copy, share, delete. Keep storage clean.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Upload 20 mixed files (PDF, image, Excel); each opens correctly
- [ ] #2 Take a photo from the upload dialog and it is filed as a document
- [ ] #3 Images preview inside the app; PDFs and Excel open in the phone's own apps
- [ ] #4 Save a copy of any document to the phone's Downloads, and share it
- [x] #5 Phone file-size limit set from TASK-10 results; a bigger file gets a clear message, not a crash
- [x] #6 Deleting one document removes only its file; the others stay intact
- [x] #7 A failed upload leaves no half-saved record or stray file
- [x] #8 On start, files no record points to are removed (same as desktop)
- [x] #9 Has its own automated test that runs with npm test
- [x] #10 Category, Reference No. and tags can be set during upload, same as desktop
- [ ] #11 Works in both modes: All files access, and folder picked with the system picker (incl. opening a PDF in picker mode)
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Upload now works on the phone app, from files or the camera ('Take photo'). Files are written straight into the data folder's files/ in 4 MB pieces, in both modes (All files access and the folder picked with the system picker), with a progress bar. Category, Reference No. and tags are set during upload, as on the desktop. Files over 500 MB are refused up front with a clear message. A failed upload leaves no record and no file; leftover files are cleaned at start. In a document: images preview in the app, PDFs and spreadsheets open in the phone's own apps (file-opener), 'Save to Downloads' copies the file under its document name, 'Share' opens the system share sheet. test/phone.mjs covers all of this with a simulated Android side (29 checks). Pending phone check: AC 1-4 and 11 (real camera, real PDF/Excel apps, Downloads, share sheet, opening a PDF through a picker link).
<!-- SECTION:FINAL_SUMMARY:END -->
