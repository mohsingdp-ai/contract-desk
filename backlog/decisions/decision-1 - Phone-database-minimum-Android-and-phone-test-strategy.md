---
id: decision-1
title: 'Phone database, minimum Android and phone test strategy'
date: '2026-10-21 07:40'
status: accepted
---
## Context

The Android app (Capacitor) keeps its own database and files on the phone, with no computer involved. TASK-10 was a throwaway
proof on the owner's real phone (Samsung Galaxy S24+, Android 16, WebView/Chrome 155) to choose the phone database and
check files, PDF opening and images before building. The proof app used Capacitor 8.5.3 and ran the desktop schema
exactly as written in `server/db.js`: the text was taken from that file without changes.

Two phone databases were tried side by side in the same app:

| | A. Native plugin `@capacitor-community/sqlite` 8.1.1 | B. `@sqlite.org/sqlite-wasm` 3.54.1-build1 (SQLite built for the browser), stored in the WebView's private file area (OPFS, "opfs-sahpool") |
| --- | --- | --- |
| SQLite version on the phone | 3.53.3 | 3.54.1 |
| Desktop schema runs unchanged (trigram search, triggers, foreign keys, CHECK rules, WITHOUT ROWID) | Pass | Pass |
| Search 'V-2026' finds 'INV-2026-001' | Pass | Pass |
| Foreign key, CHECK, tag trigger, category-rename cascade, cascade delete, `integrity_check` | All pass | All pass |
| Row still there after force-stop, reinstall (`adb install -r`) and relaunch (done twice) | Pass | Pass |
| Insert 5,000 contracts + 5,000 documents in one transaction | 16.6 s (one phone bridge call per statement) | 0.6 s |
| Substring search across 5,001 documents | 3.2 ms | 1.4 ms |
| Same engine can run the tests off the phone | No. Its web fallback uses a different SQLite build, so testing it means an emulator | Yes. The same 3.54.1 build passed every check in Node and in desktop Chromium (Playwright), including data surviving a page reload |

## Decision

**Phone database: B, `@sqlite.org/sqlite-wasm` with the "opfs-sahpool" storage, running in a Web Worker.**
- Both options met every hard requirement on the phone. B wins on the strong preference: the automated tests can run
  against the exact same SQLite build and version off the phone, in Node and in a browser. It was also about 27 times
  faster for bulk inserts, and it is the newest SQLite.
- Inside the worker the database calls are synchronous, like desktop `node:sqlite`, so shared rule code (TASK-1) can stay
  synchronous and run inside the worker. The screens talk to the worker by messages.
- A stays a proven fallback: it passed every check too. Switching later would only change the database adapter.

**Minimum Android version: Android 10 (API 29). Set `minSdkVersion = 29`.**
- Capacitor 8's own floor is Android 7 (API 24), and storage B needs a WebView from roughly Chrome 108 or newer.
- Android 10 is the oldest version that still gets current WebView and Chrome updates (Google stopped Chrome updates for
  Android 8 and 9 after Chrome 138). That keeps the storage features and security fixes current. The owner's phone is Android 16.
- At startup, check that the worker has `FileSystemSyncAccessHandle`. If not, show "Update Android System WebView"
  rather than failing silently.

**How tests run against the phone database (for TASK-1):**
1. **Node (main suite, fast, in CI):** run the shared-rules acceptance tests against `@sqlite.org/sqlite-wasm` in Node
   (its `node` export gives an in-memory database of the same 3.54.1 build), through the same small database adapter
   the phone uses. Proven in the proof: same schema, same search results.
2. **Browser (storage path):** a Playwright test serves the built phone web bundle, opens it in Chromium with a
   persistent profile, writes data, reloads, and checks the data is still there. Proven with the system Chromium
   (`/usr/bin/chromium`, as `playwright.config` already does). Playwright's own bundled browser is not downloaded on this machine.
3. **Real phone (TASK-7 only):** smoke checks over USB using `adb` plus Chrome remote debugging of the WebView
   (`adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>`, then the DevTools protocol). No emulator needed.

**Files on the phone (for TASK-3):**
- Store files in the app's private files folder (`Directory.Data` in `@capacitor/filesystem` 8.1.5), not inside the database storage.
- **Never pass a whole file through the plugin in one call.** The plugin sends files as text (base64), which runs into
  Android's 256 MB Java memory cap. Observed with 50 MB: `readFile` threw `OutOfMemoryError`, and a one-call
  `writeFile` **crashed the app**.
- What works: slice the picked file into 4 MB pieces, `writeFile` the first piece and `appendFile` the rest. Read back
  with `fetch(Capacitor.convertFileSrc(uri))`, which streams.
- Observed, with the same SHA-256 in the app, on disk (`sha256sum` via `adb run-as`) and in Node:
  50 MB written in 3.9 s and read in 0.25 s; 200 MB in 14.7 s; 500 MB in 37.8 s and read in 1.6 s.
  JS memory stayed flat at about 125 MB. No size ceiling was hit up to 500 MB.
- **Recommended phone upload limit: 500 MB per file, the same as desktop** (`server/index.js` multer limit).
  Large files take about 13 MB/s to save, so show progress.

**PDF and image:**
- PDF: `@capacitor-community/file-opener` 8.0.1, `FileOpener.open({ filePath: <file:// uri>, contentType: 'application/pdf' })`.
  It turns the path into a `content://` FileProvider link by itself; no manifest changes were needed. Android showed
  "Open with" (Samsung PDF reader, Drive, OneDrive, Edge…), and Samsung PDF reader opened and showed the stored PDF.
- Image: `<img src={Capacitor.convertFileSrc(fileUri)}>` showed the stored PNG inside the app.

## Consequences

Gotchas for later tasks:
- **The database lives in the WebView's own storage** (under `app_webview/Default/File System`, as pool files with
  meaningless names), not as a normal `.db` file. `navigator.storage.persist()` returned **false** in the WebView. Data
  survived force-stop and reinstall, but behaviour when the phone is almost out of space was **not tested**.
  Mitigation for TASK-5: back up through the library's export (`pool.exportFile` / `sqlite3_js_db_export`) into the app's
  files folder, which a backup needs anyway. Optionally restore from that copy at startup if the database is ever missing.
- Only one connection can hold the "opfs-sahpool" database at a time, so exactly one worker owns it.
- Journal mode on the phone is `delete` (the default). Don't copy the desktop's `PRAGMA journal_mode = WAL`; WAL was
  not tried on the phone. Do run `PRAGMA foreign_keys = ON` on every open, as desktop does.
- No special COOP/COEP headers or SharedArrayBuffer are needed ("opfs-sahpool" works without them; the phone reports
  `crossOriginIsolated = false`).
- Vite needs `optimizeDeps.exclude: ['@sqlite.org/sqlite-wasm']` and `worker.format: 'es'`.
- If the native plugin (A) is ever used: it names the file `<name>SQLite.db`, sends every statement through the phone
  bridge (slow for bulk work), and changes quoting by default (`isSQL92: true`).
- Build setup: JDK 21 (`mise where java@temurin-21.0.12+8.0.LTS`), `ANDROID_HOME=~/Android/Sdk`. The first build
  downloads Gradle 8.14.3 and installs Android build-tools 35 into the SDK by itself.
- Installing from the computer: Samsung **Auto Blocker** blocks USB installs. It must be off, and the phone may ask to allow the install.
- The proof app and code were deleted after this decision (TASK-10 AC #8).

## Orchestrator review addendum (required, not optional)

"Never lose a file" outranks speed. Because the WebView refused persistent storage and low-space behaviour is untested,
the phone app must keep a **safety copy** of the database as a normal file in the app's private files folder
(`Directory.Data`): written (via `sqlite3_js_db_export`, in 4 MB pieces) within a few seconds after every change, and
used to restore the database at startup if the WebView storage is ever missing or empty. This is part of TASK-2, not
deferred to TASK-5. If this ever proves unreliable, switch to option A (native plugin), which stores a normal file.

Shared rule code stays synchronous (it runs inside the phone's database worker, as on the desktop server); only the
screens talk to it asynchronously, by messages. TASK-1 is updated to match.
