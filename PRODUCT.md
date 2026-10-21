# Product

<!-- impeccable:product-schema 1 -->

## Platform

web (desktop app for Windows/Linux, plus browser access over Wi-Fi), and Android (standalone phone app)

## Stack

React frontend, local SQLite database. Desktop: Node.js backend (Electron app), runs on localhost. Android: the same screens in a Capacitor app; SQLite (WebAssembly) runs on the phone, no server. Business rules shared by both. Original files in a configurable local data folder; records and file metadata in SQLite. Offline after install. No login, no cloud, no Turso.

## Users

One person (the owner), on a desktop or laptop and/or an Android phone, managing their own import/trade paperwork. Personal tool, not shared.

## Product Purpose

A local Contract & Document Manager. Files every shipment paper against its contract or NOC, then finds any of them in seconds. Success: type an invoice number, tag, firm, or contract number and land on the document and its parent record immediately.

## Positioning

Fully local, metadata-first archive for trade documents. Search uses identifiers the owner typed (Contract No., Indent No., Reference No., tags), not OCR. Exact identifier matches rank first.

## Operating Context

- Import/trade paperwork per contract: Bank Payment Documents, Commercial Invoice, Packing List, Bill of Lading / Airway Bill, Goods Declaration (GD), Other Documents.
- NOCs tracked separately by Indent No. (Ind-1, Ind-2...).
- Files are PDFs, images, and Excel sheets.
- Archive grows to thousands of contracts over a few years.
- Most frequent task: find a file fast. Data entry and upload is secondary.

## Capabilities and Constraints

- Contracts: unique Contract No., Project Name, Firm Name, Amount, Currency. CRUD, list, search.
- NOCs: unique Indent No., NOC Name, multiple attachments. CRUD, list, search.
- Documents: display name, original filename, category, multiple tags, optional Reference No. Preview (PDF/image), download (all, incl. Excel), rename, delete. Unique storage filenames.
- Tags: add during and after upload; suggest existing; dedupe by case and surrounding spaces.
- Search: across contract/NOC identifiers and names, document names, filenames, tags, Reference No. Filters: project, firm, category, file type, tag, amount range, currency. Paginated; previews on demand; results link to parent record.
- Excel export of all or filtered contracts and NOCs, separate Documents sheet. No embedded attachments.
- Backup/restore of DB + files together in one file, with confirmation. Same format on desktop and phone, so a backup moves records between them. Delete confirmations explain attachment loss.
- Phone app: upload from files or camera, open files in the phone's apps, share, optional fingerprint lock.
- Phone and computer keep separate records; no sync. Backup/restore moves them. The same data folder must not be open on both at once.
- Phone data folder lives in shared storage (default Documents/Contract Desk), so records survive uninstall. Needs "All files access", or the owner picks the folder. Android 11 or newer.
- Out of scope this version: OCR, content extraction, content search, live sync between devices.

## Evidence on Hand

No real contracts, firms, or documents supplied. Any sample data is synthetic and must be labelled as such.

## Product Principles

1. Finding beats filing: search is the front door.
2. Identifiers are sacred: exact Contract No., Indent No., Reference No. matches always rank first.
3. Dense but calm: thousands of records must scan quickly without noise.
4. Never lose a file: destructive actions confirm and say what goes with them.
5. Local and offline, always.
