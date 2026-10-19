# Contract Desk

File every shipment paper against its contract or NOC, then find any of them in seconds.
Runs on your own computer. No cloud, works offline.

▶ **[Watch the 5-minute walkthrough](https://github.com/mohsingdp-ai/contract-desk/releases/download/v1.0.0/contract-desk-walkthrough.mp4)**

## Install

Download from the [Releases page](https://github.com/mohsingdp-ai/contract-desk/releases/latest):

- **Windows:** run the `.exe`. If Windows says "Windows protected your PC", click **More info → Run anyway**.
- **Linux:** make the `.AppImage` executable (right-click → Properties, or `chmod +x`), then double-click it.

Your records and files are saved in **Documents/Contract Desk**.

## Use it on your phone

1. In the app: **Phone → Turn phone access on**.
2. Click **Connect phone** in the sidebar and scan the QR code with your phone's camera.
3. Optional: in the phone's browser menu, tap **Add to Home Screen** for an app icon.

The phone must be on the same Wi-Fi, and the app must be open on the computer (minimized is fine).
Windows asks once to allow it on private networks: click **Allow**. On Linux with a firewall, the app shows the command to run.

## Good to know

- **Search** looks at contract and indent numbers, names, filenames, Reference No. and tags. Exact matches come first.
- **Deleting** a contract or NOC also deletes its documents and their files. The app always asks first.
- **Menu → File:** open or change the data folder, start with the computer.
- Not in this version: searching inside files (OCR), backup/restore.

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
| `npm test` | API acceptance checks |
| `npm run test:e2e` | Browser UI tests: desktop, phone, Wi-Fi, desktop app (run `npm run build` first) |
| `npm run dist:linux` | Build the Linux AppImage into `release/` |
| `npm run demo:video` | Re-record the walkthrough video |

**Releases:** push a version tag (`git tag v1.0.1 && git push --tags`) and GitHub builds the Windows and Linux installers and publishes them.

**Phone access from source:** set `LAN_PASSCODE` (6+ characters) in `.env`.

**Code map:**
- `server/`: Express API and the SQLite schema (`db.js`).
- `client/`: React UI.
- `electron/`: desktop app.
- `test/`: API and UI tests.

Don't put your own files in the data folder's `files/` subfolder: at startup the app removes files there that no record points to.
