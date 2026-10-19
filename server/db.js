import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const CATEGORIES = [
  'Bank Payment Documents',
  'Commercial Invoice',
  'Packing List',
  'Bill of Lading / Airway Bill',
  'Goods Declaration (GD)',
  'Other Documents',
];

// Tag keys of one document, as searchable text.
const TAGS_OF = (docId) =>
  `coalesce((SELECT group_concat(t.key, ' | ') FROM document_tags dt JOIN tags t ON t.id = dt.tag_id WHERE dt.document_id = ${docId}), '')`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS contracts (
  id           INTEGER PRIMARY KEY,
  contract_no  TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (contract_no = trim(contract_no) AND contract_no <> ''),
  project_name TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
  firm_name    TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
  amount       REAL NOT NULL CHECK (amount >= 0),
  currency     TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ'))
);
CREATE INDEX IF NOT EXISTS contracts_project ON contracts (project_name);
CREATE INDEX IF NOT EXISTS contracts_firm ON contracts (firm_name);
CREATE INDEX IF NOT EXISTS contracts_currency_amount ON contracts (currency, amount);
CREATE INDEX IF NOT EXISTS contracts_updated ON contracts (updated_at);

CREATE TABLE IF NOT EXISTS nocs (
  id         INTEGER PRIMARY KEY,
  indent_no  TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (indent_no = trim(indent_no) AND indent_no <> ''),
  noc_name   TEXT NOT NULL COLLATE NOCASE CHECK (noc_name <> ''),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ'))
);
CREATE INDEX IF NOT EXISTS nocs_name ON nocs (noc_name);
CREATE INDEX IF NOT EXISTS nocs_updated ON nocs (updated_at);

-- Each document belongs to exactly one Contract or one NOC (never both, never neither).
-- Contract documents must have a category; NOC documents have none.
CREATE TABLE IF NOT EXISTS documents (
  id            INTEGER PRIMARY KEY,
  contract_id   INTEGER REFERENCES contracts (id) ON DELETE CASCADE,
  noc_id        INTEGER REFERENCES nocs (id) ON DELETE CASCADE,
  display_name  TEXT NOT NULL COLLATE NOCASE CHECK (display_name <> ''),
  original_name TEXT NOT NULL COLLATE NOCASE,
  storage_name  TEXT NOT NULL UNIQUE,
  file_path     TEXT NOT NULL UNIQUE,
  mime_type     TEXT NOT NULL,
  file_type     TEXT NOT NULL CHECK (file_type IN ('pdf', 'image', 'excel')),
  size_bytes    INTEGER NOT NULL CHECK (size_bytes >= 0),
  category      TEXT CHECK (category IN (${CATEGORIES.map((c) => `'${c}'`).join(', ')})),
  reference_no  TEXT COLLATE NOCASE CHECK (reference_no IS NULL OR (reference_no = trim(reference_no) AND reference_no <> '')),
  uploaded_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ')),
  CHECK ((contract_id IS NULL) <> (noc_id IS NULL)),
  CHECK ((contract_id IS NOT NULL) = (category IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS documents_contract ON documents (contract_id, category);
CREATE INDEX IF NOT EXISTS documents_noc ON documents (noc_id);
CREATE INDEX IF NOT EXISTS documents_reference ON documents (reference_no);
CREATE INDEX IF NOT EXISTS documents_display ON documents (display_name);
CREATE INDEX IF NOT EXISTS documents_original ON documents (original_name);
CREATE INDEX IF NOT EXISTS documents_type ON documents (file_type);
CREATE INDEX IF NOT EXISTS documents_category ON documents (category);
CREATE INDEX IF NOT EXISTS documents_uploaded ON documents (uploaded_at);

-- "key" is the normalised form (trimmed, single-spaced, lower-cased) so "Urgent", " urgent " and "URGENT" are one tag.
CREATE TABLE IF NOT EXISTS tags (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL CHECK (name = trim(name) AND name <> ''),
  key  TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS document_tags (
  document_id INTEGER NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  tag_id      INTEGER NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
  PRIMARY KEY (document_id, tag_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS document_tags_tag ON document_tags (tag_id, document_id);

-- Substring search index over each document's names, Reference No. and tags (trigram = any 3+ characters).
-- Triggers keep it in step with documents and document_tags, including cascade deletes.
CREATE VIRTUAL TABLE IF NOT EXISTS doc_search USING fts5(display_name, original_name, reference_no, tags, tokenize = 'trigram');
CREATE TRIGGER IF NOT EXISTS documents_search_ins AFTER INSERT ON documents BEGIN
  INSERT INTO doc_search (rowid, display_name, original_name, reference_no, tags)
  VALUES (new.id, new.display_name, new.original_name, coalesce(new.reference_no, ''), '');
END;
CREATE TRIGGER IF NOT EXISTS documents_search_upd AFTER UPDATE OF display_name, original_name, reference_no ON documents BEGIN
  UPDATE doc_search SET display_name = new.display_name, original_name = new.original_name, reference_no = coalesce(new.reference_no, '')
  WHERE rowid = new.id;
END;
CREATE TRIGGER IF NOT EXISTS documents_search_del AFTER DELETE ON documents BEGIN
  DELETE FROM doc_search WHERE rowid = old.id;
END;
CREATE TRIGGER IF NOT EXISTS document_tags_search_ins AFTER INSERT ON document_tags BEGIN
  UPDATE doc_search SET tags = ${TAGS_OF('new.document_id')} WHERE rowid = new.document_id;
END;
CREATE TRIGGER IF NOT EXISTS document_tags_search_del AFTER DELETE ON document_tags BEGIN
  UPDATE doc_search SET tags = ${TAGS_OF('old.document_id')} WHERE rowid = old.document_id;
END;
`;

export function openDb(dataDir) {
  fs.mkdirSync(path.join(dataDir, 'files'), { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'contracts.db'));
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  // Build (or repair) the search index for databases created before it existed.
  const { docs, indexed } = db.prepare('SELECT (SELECT count(*) FROM documents) AS docs, (SELECT count(*) FROM doc_search) AS indexed').get();
  if (docs !== indexed) {
    db.exec(`DELETE FROM doc_search;
      INSERT INTO doc_search (rowid, display_name, original_name, reference_no, tags)
      SELECT d.id, d.display_name, d.original_name, coalesce(d.reference_no, ''), ${TAGS_OF('d.id')}
      FROM documents d;`);
  }
  return db;
}

export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export const tagKey = (name) => name.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
