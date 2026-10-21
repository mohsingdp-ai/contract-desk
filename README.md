# Contract Desk

File every shipment paper against its contract or NOC, then find any of them in seconds.
Runs on your own computer, or as an app on your Android phone. No cloud, works offline.

▶ **[Watch the 5-minute walkthrough](https://github.com/mohsingdp-ai/contract-desk/releases/download/v1.0.0/contract-desk-walkthrough.mp4)**

## Install

### Computer

Download from the [Releases page](https://github.com/mohsingdp-ai/contract-desk/releases/latest):

- **Windows:** run the `.exe`. If Windows says "Windows protected your PC", click **More info → Run anyway**.
- **Linux:** make the `.AppImage` executable (right-click → Properties, or `chmod +x`), then double-click it.

On first launch you choose where your records are kept (suggested: **Documents/Contract Desk**).
Change it any time in **Settings** → Data folder → **Change…**: the app can move your records
there (copied and checked first; the old folder is kept), or open a folder that already has records.

### Android phone (Android 11 or newer)

The phone app works on its own: no computer or Wi-Fi needed.

1. Get the `.apk` file. It will be on the Releases page once published; until then a developer installs it over USB
   (see *For developers*).
2. On a Samsung phone, turn **Auto Blocker** off in the phone's Settings. It blocks apps from outside the Play Store.
3. Open the `.apk` and allow the install when the phone asks.
4. On first launch, tap **Allow All files access** and switch it on. The app then keeps your records in
   **Documents/Contract Desk**, outside the app itself, so they survive if the app is removed, and a reinstall finds them by itself.
   Rather not allow it? Tap **Choose folder** and pick a folder yourself. That works too, but after a reinstall you must pick it again.

### Or: open the computer's records on your phone over Wi-Fi

No phone app needed, just the phone's browser.

1. In the app: **Phone → Turn phone access on**.
2. Click **Connect phone** in the sidebar and scan the QR code with your phone's camera.
3. Optional: in the phone's browser menu, tap **Add to Home Screen** for an app icon.

The phone must be on the same Wi-Fi, and the app must be open on the computer (minimized is fine).
Windows asks once to allow it on private networks: click **Allow**. On Linux with a firewall, the app shows the command to run.

## Good to know

- **Search** looks at contract and indent numbers, names, filenames, Reference No. and tags. Exact matches come first.
- **Document categories** (Bank Payment Documents, Commercial Invoice, …) are yours to change: **Settings** → **Document categories**
  to add, rename, reorder or remove them. Removing one moves its documents to another category first.
- **Deleting** a contract or NOC also deletes its documents and their files. The app always asks first.
- **The phone app and the computer keep separate records.** A contract added on one does not appear on the other.
  To move records across, back up on one and restore on the other (restore replaces what is there).
- **Back up** (**Settings** → **Back up now**, or the reminder after 14 days without one) saves every record and file in one `.tar` file.
  Keep it somewhere else (a USB drive, cloud storage), so a lost phone or broken computer loses nothing.
  On the phone, the backup is saved to Downloads and the share menu opens, so you can send it to Drive, email or a computer.
- **Restore** (**Settings** → **Restore…**) checks the whole file first, says what it will replace, and asks.
  A backup from the phone restores on the computer and the other way round.
  For the computer's records, restore only on the computer itself, not from a phone over Wi-Fi.
- **Don't open the same data folder on the computer and the phone at the same time** (for example through a synced cloud folder):
  one side's latest changes can be lost. Copying a data folder across is fine if Contract Desk is closed on the computer while you copy.
- **Phone lock** (optional, off by default): **Settings** → Lock → **Lock with fingerprint or face**. It asks when the app opens
  and after 3 minutes away. The phone's PIN also works.
- **Settings** holds the data folder, storage space (phone), backup and restore, theme, lock (phone) and document categories.
- On the phone, the **Documents/Contract Desk** folder shows in the Files app. Don't delete it there: it holds your records and files.
- Don't put your own files in the data folder's `files/` subfolder: at startup the app removes files there that no record points to.
- **Menu → File:** start with the computer.
- Not in this version: searching inside files (OCR).

---

## For developers

Needs Node.js 22.13+. Tests also need Chromium (`/usr/bin/chromium`).

```bash
npm install
npm run build
npm start              # http://127.0.0.1:4780   (settings: copy .env.example to .env)
```

| Command | What it does |
| --- | --- |
| `npm run dev` | Server with auto-restart + Vite dev server |
| `npm run app` | Run the desktop app without packaging |
| `npm test` | API acceptance checks, run twice: with the desktop database and with the phone's (SQLite WebAssembly); then the Android app's web bundle in Chromium (phone database, data folder, start-up copy rules, search on 3,000 contracts, Excel export, uploads and files, backup and restore) |
| `npm run test:e2e` | Browser UI tests: desktop, phone, Wi-Fi, desktop app (run `npm run build` first) |
| `npm run dist:linux` | Build the Linux AppImage into `release/` |
| `npm run demo:video` | Re-record the walkthrough video |
| `npm run android:build` | Build the Android app (debug APK) |
| `npm run android:install` | Install that APK on the phone connected by USB |
| `npm run test:device` | Tap-through tests on the phone connected by USB (needs [Maestro CLI](https://github.com/mobile-dev-inc/Maestro/releases)): builds and installs the APK, runs `test/maestro/flows`, then cleans up |

**Android build:** needs JDK 21 (`JAVA_HOME`) and the Android SDK (`ANDROID_HOME`, e.g. `~/Android/Sdk`). The first build
downloads Gradle and the build tools by itself. To install: USB debugging on, Samsung Auto Blocker off, allow the install on the phone.

**Phone tests** (`test/phone.mjs`, last step of `npm test`): builds the phone bundle and runs it in Chromium with the real phone
database (SQLite WebAssembly). Only the Android side (All files access, folder picker, file writes, share, lock) is played
by the script, on a temporary folder. `npm run test:device` taps through the real APK on a phone (unlocked, USB debugging on;
`ANDROID_SERIAL` picks one of several devices; `-- -e SHEETS=skip` without Google Sheets). It uses Documents/Contract Desk
and refuses to run if that folder holds real records.

**Releases:** push a version tag (`git tag v1.0.1 && git push --tags`) and GitHub builds the Windows and Linux installers and publishes them.

**Phone access from source:** set `LAN_PASSCODE` (6+ characters) in `.env`.

**Code map:**
- `core/`: business rules and the database schema, shared by the desktop server and the phone app.
- `server/`: Express API (desktop-only parts: Wi-Fi passcode, QR pairing, file streaming).
- `client/`: React UI.
- `electron/`: desktop app.
- `android/`: Android app (Capacitor). Native part: `FolderPlugin.java` (All files access, folder picker, file writes, share). Same screens; a database worker (`client/src/phone-worker.js`) answers instead of the
  server, and `client/src/phone.js` keeps its saved copy in the data folder (default `Documents/Contract Desk`).
  `client/src/phone-app.js`: the back button and the optional fingerprint lock. Icon and launch screen come from
  `client/public` (`sh scripts/android-icons.sh`, needs ImageMagick).
  Uploads go straight to that folder's `files/`; PDFs and spreadsheets open in the phone's own apps.
- `test/`: API, phone and UI tests.
