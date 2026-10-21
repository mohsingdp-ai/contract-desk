# Contract Desk

File every shipment paper against its contract or NOC, then find any of them in seconds.
Runs on your own computer. No cloud, works offline.

▶ **[Watch the 5-minute walkthrough](https://github.com/mohsingdp-ai/contract-desk/releases/download/v1.0.0/contract-desk-walkthrough.mp4)**

## Install

Download from the [Releases page](https://github.com/mohsingdp-ai/contract-desk/releases/latest):

- **Windows:** run the `.exe`. If Windows says "Windows protected your PC", click **More info → Run anyway**.
- **Linux:** make the `.AppImage` executable (right-click → Properties, or `chmod +x`), then double-click it.

On first launch you choose where your records are kept (suggested: **Documents/Contract Desk**).
Change it any time in **Settings** (sidebar; the gear on a phone) → Data folder → **Change…**: the app can move your records
there (copied and checked first; the old folder is kept), or open a folder that already has records.

## Use it on your phone

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
- **Back up** (**Settings** → Back up now, or the reminder after 14 days without one) saves every record and file in one `.tar` file.
  Keep it somewhere else (a USB drive, cloud storage). **Restore…** checks the whole file first, says what it will replace,
  and asks (on the computer itself, not from a phone over Wi-Fi). A backup from the phone app restores on the computer and the other way round. On the phone, the backup is saved
  to Downloads and the share menu opens, so you can send it to Drive, email or a computer.
- **Menu → File:** start with the computer.
- Not in this version: searching inside files (OCR).

---

## For developers

Needs Node.js 22.13+.

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
| `npm run android:build` | Build the Android app (debug APK). Needs JDK 21 in `JAVA_HOME` and the Android SDK in `ANDROID_HOME` |
| `npm run android:install` | Install that APK on the phone connected by USB |

**Releases:** push a version tag (`git tag v1.0.1 && git push --tags`) and GitHub builds the Windows and Linux installers and publishes them.

**Phone access from source:** set `LAN_PASSCODE` (6+ characters) in `.env`.

**Code map:**
- `core/`: business rules and the database schema, shared by the desktop server and the phone app.
- `server/`: Express API (desktop-only parts: Wi-Fi passcode, QR pairing, file streaming).
- `client/`: React UI.
- `electron/`: desktop app.
- `android/`: Android app (Capacitor). Same screens; a database worker (`client/src/phone-worker.js`) answers instead of the
  server, and `client/src/phone.js` keeps its saved copy in the data folder (default `Documents/Contract Desk`).
  `client/src/phone-app.js`: the back button and the optional fingerprint lock. Icon and launch screen come from
  `client/public` (`sh scripts/android-icons.sh`, needs ImageMagick).
  Uploads go straight to that folder's `files/`; PDFs and spreadsheets open in the phone's own apps.
- `test/`: API and UI tests.

Don't put your own files in the data folder's `files/` subfolder: at startup the app removes files there that no record points to.

A data folder can be copied between computer and phone. Close Contract Desk on the computer first, and don't open the same
folder on both at once (for example through a synced cloud folder): one side's latest changes can be lost.
