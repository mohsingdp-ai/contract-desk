# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

React frontend, Node.js backend, local SQLite database. Original files in a configurable local data folder; records and file metadata in SQLite. Runs on localhost, offline after install. No login, no cloud, no Turso.

## Users

One person (the owner), on a desktop or laptop, managing their own import/trade paperwork. Personal tool, not shared.

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
- Backup/restore of DB + files together, with confirmation. Delete confirmations explain attachment loss.
- Out of scope this version: OCR, content extraction, content search.

## Evidence on Hand

No real contracts, firms, or documents supplied. Any sample data is synthetic and must be labelled as such.

## Product Principles

1. Finding beats filing: search is the front door.
2. Identifiers are sacred: exact Contract No., Indent No., Reference No. matches always rank first.
3. Dense but calm: thousands of records must scan quickly without noise.
4. Never lose a file: destructive actions confirm and say what goes with them.
5. Local and offline, always.
