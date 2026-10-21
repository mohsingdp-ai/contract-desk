---
id: TASK-3
title: 'Phone files: upload, camera, open, share, delete'
status: Backlog
assignee: []
created_date: '2026-10-21 07:07'
updated_date: '2026-10-21 07:13'
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
Store documents in the app's private storage. Upload from files or camera, preview images in the app, open PDFs and Excel in the phone's own apps, save a copy, share, delete. Keep storage clean.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Upload 20 mixed files (PDF, image, Excel); each opens correctly
- [ ] #2 Take a photo from the upload dialog and it is filed as a document
- [ ] #3 Images preview inside the app; PDFs and Excel open in the phone's own apps
- [ ] #4 Save a copy of any document to the phone's Downloads, and share it
- [ ] #5 Phone file-size limit set from TASK-10 results; a bigger file gets a clear message, not a crash
- [ ] #6 Deleting one document removes only its file; the others stay intact
- [ ] #7 A failed upload leaves no half-saved record or stray file
- [ ] #8 On start, files no record points to are removed (same as desktop)
- [ ] #9 Has its own automated test that runs with npm test
- [ ] #10 Category, Reference No. and tags can be set during upload, same as desktop
<!-- AC:END -->
