---
id: decision-2
title: >-
  Phone data folder survives uninstall: shared folder, permission and copy
  scheme
date: '2026-10-21 08:04'
status: accepted
---
## Context

Owner requirement: uninstalling the app must not remove records or files. A reinstalled or newer version must pick the
data up by itself, or the user can choose a folder. Android wipes the app's private storage on uninstall, including the
WebView storage where the phone database lives (decision-1). So the data must also live in a shared folder.

TASK-12 was a throwaway proof on the owner's phone (Samsung Galaxy S24+, Android 16 / API 36), Capacitor 8.5.3,
`@capacitor/filesystem` 8.1.5, `@sqlite.org/sqlite-wasm` 3.54.1 ("opfs-sahpool" in a Web Worker), plus one small
native plugin of about 120 lines of Java. Everything below was seen on the phone (adb shell, `sha256sum` on the phone,
screenshots, WebView remote debugging), unless it says "not tested".

## Decision

### 1. Where data lives
- **Default folder: `Documents/Contract Desk`** (`/storage/emulated/0/Documents/Contract Desk`). The layout is the
  same as the desktop data folder: `contracts.db` plus `files/`.
- A folder can be copied between PC and phone:
  - A desktop-made folder (desktop schema, WAL mode, 3,000 contracts, 10,000 documents) opened on the phone.
    Search and the file hash matched.
  - The phone's copy opened on the desktop with `openDb()`: `integrity_check` ok, the new row was there, and it
    switched itself to WAL.
- **Observed after a full `adb uninstall`:** the folder, `contracts.db` and both files (one 50 MB) were still there with
  the same SHA-256. This was checked twice.

### 2. Permission: "All files access" (`MANAGE_EXTERNAL_STORAGE`)
- The manifest declares `android.permission.MANAGE_EXTERNAL_STORAGE`.
- The app checks `Environment.isExternalStorageManager()`.
- To ask for it, the app opens `Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION` with `package:<appId>`.
  - Observed: this opens Samsung's "All files access → <app> → Allow permission" page for the app.
  - The owner flips one switch and presses back.
  - The app re-checks in the activity result, then opens the folder.
- Granting it did **not** restart the app.
- **Why it is needed (observed):** after uninstall and reinstall, the files belong to the old install (MediaStore
  owner = none). Without the permission, the reinstalled app:
  - could `stat` an old file,
  - but could not read it (HTTP 404 through the WebView file server),
  - could not delete it,
  - and `readdir` did not list `contracts.db`.
- With the permission, the reinstalled app and a newer version (versionCode 2, fresh install after uninstall) could:
  - read old files (hash match),
  - overwrite an old file,
  - delete the old 50 MB file and write a new one,
  - replace the old `contracts.db` (it had been created by `adb push`, so it was owned by another app).

### 3. File I/O in the folder (same rules as decision-1)
- **Write:** `Filesystem.writeFile` for the first 4 MB piece, then `appendFile` for the rest, with
  `path: 'file:///storage/emulated/0/Documents/Contract Desk/…'` and `recursive: true`. No `directory` is needed. The
  space in the folder name was fine.
- **Read:** `fetch(Capacitor.convertFileSrc(fileUri))`. It streams, and the same call works for `content://` links.
- `Filesystem.rename` **does replace an existing file** (rename over `contracts.db` worked repeatedly, and no `.tmp`
  file was left behind).
- Capacitor's Filesystem plugin skips its own permission prompt on Android 13+. It relies on the All files access
  check above.

### 4. Database: the working copy stays sqlite-wasm in the WebView; the folder holds a saved copy
- **TASK-1's rules stay synchronous and unchanged.** The folder copy is a file written next to them.
  Switching to the native plugin is **not** needed. Measured saving cost (below) is small.
- One small table in the database:
  `sync_state(id = 1, gen INTEGER, saved TEXT)`.
  - Every write transaction in the worker also runs `UPDATE sync_state SET gen = gen + 1`, in the same transaction.
  - `saved` records which folder (path or picker link), which file (`size|mtime`) and which `gen` were last saved or
    opened. It is updated without bumping `gen`.
- **Save:**
  1. Wait 2 s after the last change.
  2. Export with `sqlite3_js_db_export(db)`.
  3. Write it to `contracts.db.tmp` in 4 MB pieces.
  4. Rename the `.tmp` file over `contracts.db`.
  5. `stat` the file and write `saved`.

  A crash mid-save can never leave a half-written `contracts.db`.
- **Which copy wins at start: the folder copy, unless the phone has newer unsaved changes to that same file.**
  - Folder has no `contracts.db`: write the phone copy there. A brand-new install creates the schema first.
  - Phone database empty (new install or reinstall), **or** the user just chose this folder, **or** the folder file is
    not the one in `saved` (different folder, size or mtime, e.g. copied from the PC): **import the folder copy**
    (`pool.importDb`).
  - Same file as `saved`, but the phone's `gen` is higher than the saved `gen` (the app was killed inside the 2 s
    window): **save the phone copy to the folder**.
  - Otherwise: nothing to do.
- **Proven on the phone:**
  - Killed right after a change (before autosave): the next start said "phone had unsaved changes: saved them", and
    the row was in the folder file.
  - Killed right after a save: the next start said "up to date".
  - The folder file was replaced from outside: the next start said "opened folder copy", with the outside row present.
  - Reinstall, and a newer version: "opened folder copy" with 3,003 / 3,004 contracts, 10,000 documents, the search
    hit and the file hashes all matching.
- **Gotcha seen in the proof:** an early version kept the `saved` marker in `localStorage`. A force-stop right after
  saving lost that write, so the next start imported again. That was safe here, but it could lose unsaved changes in
  other cases. **Keep the marker and the chosen folder inside the database, not in `localStorage`.**
- The import fixes a desktop WAL-mode file by itself: sqlite-wasm's `importDb` rewrites header bytes 18–19 to
  rollback mode.

### 5. Choosing a folder
- Use the system folder picker (`Intent.ACTION_OPEN_DOCUMENT_TREE`, starting in Documents) in both cases:
  - **With All files access:** turn the picked link into a normal path. `primary:Documents/X` becomes
    `/storage/emulated/0/Documents/X`; other volumes become `/storage/<id>/X`. Then use normal file I/O.
  - Observed: choosing a folder that already had a desktop-made `contracts.db` opened those records (3,000 contracts,
    search hit, file hash match).
- The chosen folder is remembered (kept inside the database) across a force-stop and restart.
- **Choosing an empty folder** writes the current records there (the old folder is left as it was). TASK-2 should ask
  "Move my records here?" first, as the desktop does.

### 6. Permission refused: the user picks the folder instead
- If All files access is off, or was taken away later, the app shows:
  > "Contract Desk keeps your records in a folder on the phone, so they stay safe even if the app is removed.
  > Allow 'All files access', or choose a folder."
- Nothing is written anywhere until a folder is set, so nothing can be lost.
- **"Choose folder" without the permission** keeps the picker link (a `content://` "tree" link, with
  `takePersistableUriPermission`) and does all I/O through it:
  - Small native methods `safWrite(tree, name, base64 piece, append)`, `safCommit` (delete the old file, rename `.tmp`),
    `safStat` and `safDelete`, using `androidx.documentfile`.
  - Reading uses `fetch(convertFileSrc(contentUri))`, which streams.
- **Observed without the permission, after reinstall:**
  - picking the old `Contract Desk` folder opened all records;
  - the 50 MB file hash matched;
  - the database saved (8.3 MB in about 0.85 s);
  - an old file was overwritten;
  - the old 50 MB file was deleted and rewritten;
  - after a restart the folder was remembered ("up to date").
- **Limits of this mode:**
  - The picker link is lost on uninstall, so after reinstalling, the user must pick the folder again. Then the records
    open.
  - SQLite can't open a `content://` link. That's fine, because the copy scheme only needs whole-file reads and writes.
  - `safCommit` deletes the old file before renaming, so a crash at that exact moment leaves only `contracts.db.tmp`.
    At start, if `contracts.db` is missing and `.tmp` exists, use the `.tmp` file.

### Measured timings (S24+, realistic database: 3,000 contracts, 10,000 documents, 20,000 tag links, 8.3 MB)
| Step | Time |
| --- | --- |
| Export database to bytes (`sqlite3_js_db_export`) | 6–31 ms |
| Save to folder: export + 3 × 4 MB pieces + rename (All files access) | 0.6 s (595–628 ms, 6 runs) |
| Save to folder through the picker link (permission refused) | 0.83–0.86 s |
| Start-up: read 8.3 MB folder copy + import into the WebView database | ~80 ms (58–87 ms read + 16–29 ms import) |
| Start-up when nothing changed | one `stat` call, no read |
| 50 MB file written in 4 MB pieces / read back | 3.2–3.4 s / 0.36–0.39 s |

A 2 s wait after the last change, then a 0.6 s save, is a small cost.
Saving time grows with database size, roughly 75 ms per MB.

### Google Play
Checked on Google's policy page (support.google.com/googleplay/android-developer/answer/10467955, fetched today):
- All files access is a restricted permission.
- Permitted uses include "document management apps".
- An app needs a Permissions Declaration Form in Play Console, approval, and a justification of why the system folder
  picker (SAF) is not enough. Apps that don't comply "may be removed".
- **Not verified:** whether Google would approve this app.
- This does not affect the GitHub-release APK (TASK-9); the Play listing there is optional. If Play is ever wanted,
  the folder-picker mode above is the fallback that needs no restricted permission.

## Consequences

Gotchas for later tasks:
- **TASK-2:**
  - add the `sync_state` table;
  - bump `gen` in the worker's write path;
  - debounced save with `.tmp` and rename;
  - the start-up rule above;
  - the first-run screen ("Allow All files access" / "Choose folder");
  - re-check permission when the app comes back to the screen.

  The decision-1 addendum's "safety copy in `Directory.Data`" becomes this folder copy. A private-folder copy would
  be erased on uninstall anyway.
- **TASK-2, minimum Android:** `isExternalStorageManager()` exists only from Android 11 (API 30). On Android 10
  (minSdk 29) use `requestLegacyExternalStorage="true"` plus the `WRITE_EXTERNAL_STORAGE` runtime permission, or the
  folder-picker mode. **Not tested** (no Android 10 device).
- **TASK-3:**
  - Store uploads in `<folder>/files/`, written in 4 MB pieces and read with `fetch(convertFileSrc(...))`, as here.
  - In picker mode, files go through `safWrite`.
  - Opening a PDF in picker mode needs the `content://` link (FileOpener with a `content://` path is **not tested**).
- **TASK-5:** the folder already is a backup that survives uninstall. Backup and restore can zip the folder.
- **TASK-7:** repeat the uninstall → reinstall → open check on the real phone, in both modes.
- **Don't run desktop and phone on the same folder at the same time** (for example a synced cloud folder). The rule
  "folder wins unless the phone has unsaved changes" can then drop the last few seconds of one side's changes.
  Copying a closed desktop folder is fine. The desktop must be closed so its WAL is merged into `contracts.db`.
- Android may show `Documents/Contract Desk` in Files apps. The user can see and delete it there, which is the price
  of surviving uninstall. TASK-6 could warn before deleting.
- During the proof, at one point All files access appeared granted before the app asked. The cause is unknown (the
  phone was briefly disconnected from USB); the proof reset it and repeated the in-app flow.
- The proof app, its code, the test folders `Documents/Contract Desk` and `Documents/Contract Desk PC` (both created
  by the proof; neither existed before) were deleted after this decision.

## Orchestrator review addendum

- **Minimum Android raised to 11 (API 30, `minSdkVersion 30`).** All files access exists only from Android 11; Android 10 would
  need a second, untested storage path. This overrides decision-1's Android 10. The owner's phone is Android 16.
- **Startup must handle a leftover `contracts.db.tmp`** (crash mid-save): use it only if it passes `PRAGMA integrity_check`
  and is newer than `contracts.db`; otherwise delete it. Never delete `contracts.db` itself.
- **Documents live in the data folder's `files/`** (same as desktop), never only in app-private storage.
- **Same folder open on PC and phone at once is unsupported**: README must say so (copy the folder while the desktop app is closed).
- Play Store: decided later by the owner (TASK-9). GitHub-release APK uses All files access with the picker as fallback.
- **Change marker is size + SHA-256 of the file contents, not size + modified time** (found in TASK-2): after a rename this phone
  sometimes reports the old file's modified time, which made a restart discard an unsaved change.
- Android's automatic app backup is off: the data folder is the backup, and an auto-restored stale WebView database could
  otherwise win over the folder.
