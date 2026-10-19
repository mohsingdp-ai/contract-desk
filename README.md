# Contract Desk — Local Contract & Document Manager

Files trade paperwork against Contracts and NOCs, then finds any document in seconds.
Runs on your computer (`127.0.0.1`); optional passcode-protected phone access over Wi-Fi.
No cloud. Works offline after install.

## Requirements

- Node.js **22.13 or newer** (uses Node's built-in SQLite — nothing native to compile).

## Install and start

```bash
npm install          # once, needs internet
npm run build        # builds the web interface into dist/
npm start            # http://127.0.0.1:4780
```

Open <http://127.0.0.1:4780>. After `npm install` nothing needs the internet; fonts are bundled.

## Settings

Copy `.env.example` to `.env` and edit:

| Setting    | Default  | Meaning                                                          |
| ---------- | -------- | ---------------------------------------------------------------- |
| `DATA_DIR` | `./data` | Folder for the database (`contracts.db`) and uploaded files (`files/`). Created if missing. |
| `PORT`     | `4780`   | Port                                                             |
| `LAN_PASSCODE` | empty | Turns on phone access over Wi-Fi (see below)                   |

### Phone access over Wi-Fi (optional, off by default)

Set `LAN_PASSCODE` in `.env` (6+ characters) and restart. The app then also listens on your
network and prints the address to open on your phone, e.g. `http://192.168.1.13:4780`.

- **Easiest: scan a QR code.** On this computer, open http://127.0.0.1:4780 and click
  **Connect phone**, then scan the code with the phone's camera. The phone opens the app already
  unlocked. Each code works once and expires after 10 minutes; it never contains the passcode.
- Or type the passcode on the phone. Either way it is remembered for 30 days. This computer never asks.
- Changing the passcode logs every phone out. 5 wrong tries lock that device out for 5 minutes.
- The phone must be on the same Wi-Fi. Your firewall may need to allow the port.
- Traffic is plain HTTP: use it on your own home/office Wi-Fi, not on public networks.
- On phones, PDFs open in the phone's own viewer (phone browsers can't show them inside a page).

Leave `LAN_PASSCODE` empty to keep the app reachable from this computer only.

Do not put your own files in `DATA_DIR/files/`: on startup the app deletes any file there
that no document record points to (leftovers from a crash or failed delete).

## Database

SQLite file `DATA_DIR/contracts.db`, created and migrated automatically on start
(schema in `server/db.js`). Foreign keys are switched on for every connection.

- `contracts` — unique Contract No. (case-insensitive), project, firm, amount, currency.
- `nocs` — unique Indent No. (case-insensitive, so `Ind-1` and `IND-1` clash), NOC name.
- `documents` — one row per uploaded file. A CHECK makes exactly one of `contract_id` / `noc_id`
  set; foreign keys cascade deletes. Contract documents must have a category; NOC documents have none.
  Stores display name, original filename, unique storage filename + path, MIME/type, size,
  Reference No., upload date.
- `tags` + `document_tags` — tags are unique by a normalised key (trimmed, single-spaced,
  lower-case), so `Urgent`, ` urgent ` and `URGENT` are one tag.
- `doc_search` — FTS5 trigram index over each document's names, Reference No. and tags, kept in
  sync by triggers. Built automatically on first start for older databases. Searches of 1–2
  characters fall back to a plain scan.

Measured on 10,000 contracts / 2,000 NOCs / 106,000 documents: identifier, tag and name
searches return in about 5–15 ms; the worst case (a word in every document name) about 90 ms.

Renaming a document only changes `display_name`; the stored file and parent never move.

## Development

```bash
npm run dev     # API on :4780 with auto-restart + Vite on :5173 (proxies /api)
npm test        # end-to-end acceptance checks against a throwaway data folder
npm run build && npm run test:e2e   # 30 browser-driven UI tests (desktop, phone, Wi-Fi passcode, QR)
```

The UI tests use the system Chromium (`/usr/bin/chromium` or Google Chrome) when present.
Without one, run `npx playwright install chromium` once and set `PW_BUNDLED=1`.

## What `npm test` verifies

Runs the real server on a temp folder and checks:

1. Contract creation; duplicate Contract No. rejected.
2. Multi-file upload into different categories; tag + Reference No. `INV-2026-001`;
   case/space-duplicate tags collapse; unique storage names; non-ASCII filenames kept.
3. Failed uploads (bad category, bad file type, missing parent) leave no rows and no files.
4. Find by Reference No. (exact match ranked first) and by tag; open the parent contract.
5. NOC `Ind-1`: create, duplicate rejected, multiple files attached, found by search.
6. Filters: project, firm, category, file type, tag, currency, amount range, pagination.
7. Database refuses documents with no parent, two parents, or a missing parent.
8. Filtered Excel export: Contracts / NOCs / Documents sheets; every document row names the right parent.
9. Rename keeps the same stored file, parent and download.
10. Deleting a document, contract or NOC removes exactly the right rows and files.
11. Requests from other websites / non-local hosts are refused.

## Not in this version

OCR or searching inside files, backup/restore.
