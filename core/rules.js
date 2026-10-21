// Business rules shared by the desktop server and the phone app: contracts, NOCs, documents, categories, tags,
// search and export data. Plain JS only (no Node modules): it also runs, synchronously, in the phone's database worker.
// Each platform passes in its own database (node:sqlite, or sqlite-wasm through ./wasm-db.js) and file storage:
//   files.remove(storageNames)  delete stored files; failures are only logged (the startup sweep retries)
//   files.list()                storage names currently in the files folder
//   files.exists(filePath)      whether a document's file_path is on disk
import { tx, tagKey } from './schema.js';

const FILE_TYPES = {
  '.pdf': ['pdf', 'application/pdf'],
  '.png': ['image', 'image/png'],
  '.jpg': ['image', 'image/jpeg'],
  '.jpeg': ['image', 'image/jpeg'],
  '.gif': ['image', 'image/gif'],
  '.webp': ['image', 'image/webp'],
  '.bmp': ['image', 'image/bmp'],
  '.xlsx': ['excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  '.xlsm': ['excel', 'application/vnd.ms-excel.sheet.macroEnabled.12'],
  '.xls': ['excel', 'application/vnd.ms-excel'],
  '.csv': ['excel', 'text/csv'],
};

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (msg) => {
  throw new HttpError(400, msg);
};
const str = (v) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());
const likeAny = (s) => `%${s.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
const likePrefix = (s) => `${s.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
// Same as Node's path.extname for a bare file name (uploads never carry folders).
const extname = (name) => (name.lastIndexOf('.') > 0 ? name.slice(name.lastIndexOf('.')) : '');

// HTTP status and message for an error thrown by the rules or by a database rule.
export function errorReply(err) {
  let status = err.status || 500;
  let message = err.message;
  const msg = String(err.message || '');
  if (msg.includes('UNIQUE constraint failed: contracts.contract_no')) (status = 409), (message = 'That Contract No. already exists');
  else if (msg.includes('UNIQUE constraint failed: nocs.indent_no')) (status = 409), (message = 'That Indent No. already exists');
  else if (msg.includes('UNIQUE constraint failed: categories.name')) (status = 409), (message = 'A category with that name already exists');
  else if (msg.includes('constraint failed')) (status = 400), (message = 'The data breaks a database rule: ' + msg);
  return { status, message };
}

// File name for opening or downloading a document: its display name, with the original extension.
export function downloadName(doc) {
  const ext = extname(doc.original_name);
  return doc.display_name.toLowerCase().endsWith(ext.toLowerCase()) ? doc.display_name : doc.display_name + ext;
}

// ---------- filters & queries ----------

function readFilters(q) {
  const s = (k) => str(q[k]);
  const num = (k) => {
    if (s(k) === '') return null;
    const n = Number(s(k));
    return Number.isFinite(n) ? n : bad(`${k} must be a number`);
  };
  return {
    q: s('q'),
    project: s('project'),
    firm: s('firm'),
    currency: s('currency').toUpperCase(),
    min: num('min'),
    max: num('max'),
    category: s('category'),
    fileType: s('file_type'),
    tag: s('tag'),
    sort: s('sort'),
    page: Math.max(1, parseInt(s('page')) || 1),
    pageSize: Math.min(200, Math.max(1, parseInt(s('page_size')) || 25)),
  };
}

const hasContractOnlyFilter = (f) => !!(f.project || f.firm || f.currency || f.min != null || f.max != null);
// Not correlated with the outer row, so SQLite builds the matching-document set once per query.
const TAG_MATCH = `d.id IN (SELECT dt.document_id FROM document_tags dt JOIN tags t ON t.id = dt.tag_id WHERE t.key`;

function docFilterWhere(f) {
  const w = [];
  const p = [];
  if (f.category) w.push('d.category = ?'), p.push(f.category);
  if (f.fileType) w.push('d.file_type = ?'), p.push(f.fileType);
  if (f.tag) w.push(`${TAG_MATCH} = ?)`), p.push(tagKey(f.tag));
  return { w, p };
}

function contractFilterWhere(f, w, p) {
  if (f.project) w.push('c.project_name = ?'), p.push(f.project);
  if (f.firm) w.push('c.firm_name = ?'), p.push(f.firm);
  if (f.currency) w.push('c.currency = ?'), p.push(f.currency);
  if (f.min != null) w.push('c.amount >= ?'), p.push(f.min);
  if (f.max != null) w.push('c.amount <= ?'), p.push(f.max);
}

function contractWhere(f) {
  const w = [];
  const p = [];
  if (f.q) {
    w.push(`(c.contract_no LIKE ? ESCAPE '\\' OR c.project_name LIKE ? ESCAPE '\\' OR c.firm_name LIKE ? ESCAPE '\\')`);
    p.push(likeAny(f.q), likeAny(f.q), likeAny(f.q));
  }
  contractFilterWhere(f, w, p);
  const doc = docFilterWhere(f);
  if (doc.w.length) {
    w.push(`EXISTS (SELECT 1 FROM documents d WHERE d.contract_id = c.id AND ${doc.w.join(' AND ')})`);
    p.push(...doc.p);
  }
  return { sql: w.length ? `WHERE ${w.join(' AND ')}` : '', p };
}

function nocWhere(f) {
  const w = [];
  const p = [];
  if (hasContractOnlyFilter(f)) w.push('0'); // NOCs have no project/firm/amount, so those filters exclude them.
  if (f.q) {
    w.push(`(n.indent_no LIKE ? ESCAPE '\\' OR n.noc_name LIKE ? ESCAPE '\\')`);
    p.push(likeAny(f.q), likeAny(f.q));
  }
  const doc = docFilterWhere(f);
  if (doc.w.length) {
    w.push(`EXISTS (SELECT 1 FROM documents d WHERE d.noc_id = n.id AND ${doc.w.join(' AND ')})`);
    p.push(...doc.p);
  }
  return { sql: w.length ? `WHERE ${w.join(' AND ')}` : '', p };
}

function docWhere(f) {
  const w = [];
  const p = [];
  if (f.q && [...f.q].length >= 3) {
    // Indexed substring search; a quoted phrase makes the trigram index match the text exactly as typed.
    w.push('d.id IN (SELECT rowid FROM doc_search WHERE doc_search MATCH ?)');
    p.push(`"${f.q.replaceAll('"', '""')}"`);
  } else if (f.q) {
    // 1–2 characters are too short for the trigram index: plain scan.
    w.push(`(d.display_name LIKE ? ESCAPE '\\' OR d.original_name LIKE ? ESCAPE '\\' OR d.reference_no LIKE ? ESCAPE '\\' OR ${TAG_MATCH} LIKE ? ESCAPE '\\'))`);
    p.push(likeAny(f.q), likeAny(f.q), likeAny(f.q), likeAny(tagKey(f.q)));
  }
  if (hasContractOnlyFilter(f)) {
    w.push('d.contract_id IS NOT NULL');
    contractFilterWhere(f, w, p);
  }
  const doc = docFilterWhere(f);
  w.push(...doc.w);
  p.push(...doc.p);
  if (f.contractId) w.push('d.contract_id = ?'), p.push(f.contractId);
  if (f.nocId) w.push('d.noc_id = ?'), p.push(f.nocId);
  return { sql: w.length ? `WHERE ${w.join(' AND ')}` : '', p };
}

const CONTRACT_SORT = {
  recent: 'c.updated_at DESC, c.id DESC',
  no: 'c.contract_no, c.id',
  amount_desc: 'c.amount DESC, c.id',
  amount_asc: 'c.amount, c.id',
};
const NOC_SORT = { recent: 'n.updated_at DESC, n.id DESC', no: 'n.indent_no, n.id' };
const DOC_COUNT_COLS = `(SELECT count(*) FROM documents d WHERE d.contract_id = c.id) AS doc_count`;

function page(f, total, items) {
  return { items, total, page: f.page, pageSize: f.pageSize, pages: Math.max(1, Math.ceil(total / f.pageSize)) };
}

const DOC_SELECT = `
  SELECT d.*, c.contract_no, c.project_name, c.firm_name, n.indent_no, n.noc_name,
    (SELECT json_group_array(name) FROM (
       SELECT t.name FROM document_tags dt JOIN tags t ON t.id = dt.tag_id WHERE dt.document_id = d.id ORDER BY t.key)) AS tags`;
const DOC_FROM = `FROM documents d LEFT JOIN contracts c ON c.id = d.contract_id LEFT JOIN nocs n ON n.id = d.noc_id`;

function docRow(r) {
  return {
    id: r.id,
    contract_id: r.contract_id,
    noc_id: r.noc_id,
    display_name: r.display_name,
    original_name: r.original_name,
    storage_name: r.storage_name,
    file_path: r.file_path,
    mime_type: r.mime_type,
    file_type: r.file_type,
    size_bytes: r.size_bytes,
    category: r.category,
    reference_no: r.reference_no,
    uploaded_at: r.uploaded_at,
    tags: JSON.parse(r.tags),
    rank: r.rank,
    parent: r.contract_id
      ? { type: 'contract', id: r.contract_id, no: r.contract_no, name: r.project_name, firm: r.firm_name }
      : { type: 'noc', id: r.noc_id, no: r.indent_no, name: r.noc_name },
  };
}

// ---------- input validation ----------

function normaliseTags(input) {
  const list = Array.isArray(input) ? input : typeof input === 'string' ? input.split(',') : [];
  const seen = new Map();
  for (const raw of list) {
    const name = str(raw).replace(/\s+/g, ' ');
    if (name && !seen.has(tagKey(name))) seen.set(tagKey(name), name);
  }
  return [...seen.entries()];
}

function contractInput(b) {
  const contract_no = str(b.contract_no);
  if (!contract_no) bad('Contract No. is required');
  const amount = Number(b.amount);
  if (str(b.amount) === '' || !Number.isFinite(amount) || amount < 0) bad('Amount must be a number of 0 or more');
  const currency = str(b.currency).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) bad('Currency must be a 3-letter code such as USD');
  return [contract_no, str(b.project_name), str(b.firm_name), Math.round(amount * 100) / 100, currency];
}

function nocInput(b) {
  const indent_no = str(b.indent_no);
  if (!indent_no) bad('Indent No. is required');
  const noc_name = str(b.noc_name);
  if (!noc_name) bad('NOC Name is required');
  return [indent_no, noc_name];
}

const categoryName = (v) => {
  const name = str(v).replace(/\s+/g, ' ');
  if (!name) bad('Category name is required');
  if (name.length > 60) bad('Keep category names to 60 characters or fewer');
  return name;
};

// Remove stored files with no database row (left by a crash mid-upload or a failed delete).
// Only names this app generates (random UUID + extension) are ever removed, so a data folder chosen
// inside e.g. Documents never loses the owner's own files.
const STORED_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.[a-z0-9]+)?$/;
// Name for a newly stored file: random UUID + the original lower-case extension (what STORED_NAME matches).
export const storedName = (originalName) => crypto.randomUUID() + extname(originalName).toLowerCase();
// Upload limits, per request.
export const UPLOAD_LIMITS = { fileSize: 500 * 1024 * 1024, files: 100 };

// ---------- actions ----------

export function createRules({ db, files }) {
  function listContracts(f, { all = false } = {}) {
    const { sql, p } = contractWhere(f);
    const total = db.prepare(`SELECT count(*) AS n FROM contracts c ${sql}`).get(...p).n;
    // Exact Contract No. first, then Contract No. prefix, then exact project/firm, then everything else.
    const rank = f.q
      ? `CASE WHEN c.contract_no = ? THEN 0 WHEN c.contract_no LIKE ? ESCAPE '\\' THEN 1 WHEN c.project_name = ? OR c.firm_name = ? THEN 2 ELSE 3 END`
      : '0';
    const rp = f.q ? [f.q, likePrefix(f.q), f.q, f.q] : [];
    const limit = all ? [-1, 0] : [f.pageSize, (f.page - 1) * f.pageSize];
    const items = db
      .prepare(
        `SELECT c.*, ${DOC_COUNT_COLS}, ${rank} AS rank FROM contracts c ${sql}
         ORDER BY rank, ${CONTRACT_SORT[f.sort] || CONTRACT_SORT.recent} LIMIT ? OFFSET ?`,
      )
      .all(...rp, ...p, ...limit);
    return page(f, total, items);
  }

  function listNocs(f, { all = false } = {}) {
    const { sql, p } = nocWhere(f);
    const total = db.prepare(`SELECT count(*) AS n FROM nocs n ${sql}`).get(...p).n;
    const rank = f.q
      ? `CASE WHEN n.indent_no = ? THEN 0 WHEN n.indent_no LIKE ? ESCAPE '\\' THEN 1 WHEN n.noc_name = ? THEN 2 ELSE 3 END`
      : '0';
    const rp = f.q ? [f.q, likePrefix(f.q), f.q] : [];
    const limit = all ? [-1, 0] : [f.pageSize, (f.page - 1) * f.pageSize];
    const items = db
      .prepare(
        `SELECT n.*, (SELECT count(*) FROM documents d WHERE d.noc_id = n.id) AS doc_count, ${rank} AS rank
         FROM nocs n ${sql} ORDER BY rank, ${NOC_SORT[f.sort] || NOC_SORT.recent} LIMIT ? OFFSET ?`,
      )
      .all(...rp, ...p, ...limit);
    return page(f, total, items);
  }

  function listDocs(f, { all = false } = {}) {
    const { sql, p } = docWhere(f);
    const total = db.prepare(`SELECT count(*) AS n ${DOC_FROM} ${sql}`).get(...p).n;
    // Exact Reference No. or exact tag first, then prefix matches on Reference No. / names, then the rest.
    const rank = f.q
      ? `CASE WHEN d.reference_no = ? OR ${TAG_MATCH} = ?) THEN 0
              WHEN d.reference_no LIKE ? ESCAPE '\\' OR d.display_name LIKE ? ESCAPE '\\' OR d.original_name LIKE ? ESCAPE '\\' THEN 1
              ELSE 2 END`
      : '0';
    const rp = f.q ? [f.q, tagKey(f.q), likePrefix(f.q), likePrefix(f.q), likePrefix(f.q)] : [];
    const limit = all ? [-1, 0] : [f.pageSize, (f.page - 1) * f.pageSize];
    // Rank and page on ids first; build tag lists and parent fields only for the rows shown.
    const items = db
      .prepare(
        `WITH hit AS (SELECT d.id, ${rank} AS rank ${DOC_FROM} ${sql}
                      ORDER BY rank, d.uploaded_at DESC, d.id DESC LIMIT ? OFFSET ?)
         ${DOC_SELECT}, hit.rank FROM hit JOIN documents d ON d.id = hit.id
         LEFT JOIN contracts c ON c.id = d.contract_id LEFT JOIN nocs n ON n.id = d.noc_id
         ORDER BY hit.rank, d.uploaded_at DESC, d.id DESC`,
      )
      .all(...rp, ...p, ...limit)
      .map(docRow);
    return page(f, total, items);
  }

  function getDoc(id) {
    const r = db.prepare(`${DOC_SELECT}, 0 AS rank ${DOC_FROM} WHERE d.id = ?`).get(id);
    if (!r) throw new HttpError(404, 'Document not found');
    return docRow(r);
  }

  function setTags(docId, input) {
    db.prepare('DELETE FROM document_tags WHERE document_id = ?').run(docId);
    for (const [key, name] of normaliseTags(input)) {
      db.prepare('INSERT INTO tags (name, key) VALUES (?, ?) ON CONFLICT (key) DO NOTHING').run(name, key);
      const { id } = db.prepare('SELECT id FROM tags WHERE key = ?').get(key);
      db.prepare('INSERT INTO document_tags (document_id, tag_id) VALUES (?, ?)').run(docId, id);
    }
  }

  const pruneTags = () => db.exec('DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM document_tags)');

  const categoryNames = () => db.prepare('SELECT name FROM categories ORDER BY position, id').all().map((r) => r.name);

  function docMetaInput(m, parentType, fallbackName) {
    const display_name = str(m.display_name) || fallbackName;
    const reference_no = str(m.reference_no) || null;
    let category = null;
    if (parentType === 'contract') {
      // Case-insensitive match, stored with the category's own spelling.
      category = db.prepare('SELECT name FROM categories WHERE name = ?').get(str(m.category))?.name;
      if (!category) bad(`Choose a valid category for "${display_name}"`);
    }
    return { display_name, reference_no, category };
  }

  const getCategory = (id) => {
    const cat = db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
    if (!cat) throw new HttpError(404, 'Category not found');
    return cat;
  };
  const listCategories = () =>
    db.prepare(`SELECT c.id, c.name, c.position, (SELECT count(*) FROM documents d WHERE d.category = c.name) AS doc_count FROM categories c ORDER BY c.position, c.id`).all();

  function getContract(id) {
    const c = db.prepare(`SELECT c.*, ${DOC_COUNT_COLS} FROM contracts c WHERE c.id = ?`).get(id);
    if (!c) throw new HttpError(404, 'Contract not found');
    return { ...c, documents: listDocs({ contractId: c.id }, { all: true }).items };
  }

  function getNoc(id) {
    const n = db.prepare(`SELECT n.*, (SELECT count(*) FROM documents d WHERE d.noc_id = n.id) AS doc_count FROM nocs n WHERE n.id = ?`).get(id);
    if (!n) throw new HttpError(404, 'NOC not found');
    return { ...n, documents: listDocs({ nocId: n.id }, { all: true }).items };
  }

  // Deleting a parent: remove DB rows first (cascade), then files. A file that fails to delete
  // is an orphan the startup sweep removes; a row is never left pointing at a deleted file.
  function deleteParent(table, id) {
    const col = table === 'contracts' ? 'contract_id' : 'noc_id';
    const names = tx(db, () => {
      const stored = db.prepare(`SELECT storage_name FROM documents WHERE ${col} = ?`).all(id).map((r) => r.storage_name);
      const r = db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
      if (!r.changes) throw new HttpError(404, 'Record not found');
      pruneTags();
      return stored;
    });
    files.remove(names);
    return { deletedDocuments: names.length };
  }

  return {
    meta: () => ({
      categories: categoryNames(),
      fileTypes: Object.keys(FILE_TYPES),
      lastBackup: db.prepare(`SELECT value FROM app_state WHERE key = 'last_backup'`).get()?.value || null,
    }),
    // When a backup was last made (or, after a restore, when the restored backup was made): drives the reminder.
    noteBackup(at) {
      db.prepare(`INSERT INTO app_state (key, value) VALUES ('last_backup', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(at);
    },

    // Categories (editable per-contract checklist)
    listCategories,
    addCategory(name) {
      db.prepare('INSERT INTO categories (name, position) VALUES (?, (SELECT coalesce(max(position), 0) + 1 FROM categories))').run(categoryName(name));
      return listCategories();
    },
    // Rename (documents follow through ON UPDATE CASCADE) and/or move one step up or down.
    updateCategory(id, b) {
      tx(db, () => {
        const cat = getCategory(id);
        if (b?.name !== undefined) db.prepare('UPDATE categories SET name = ? WHERE id = ?').run(categoryName(b.name), cat.id);
        if (b?.move === 'up' || b?.move === 'down') {
          const all = listCategories();
          const i = all.findIndex((c) => c.id === cat.id);
          const j = b.move === 'up' ? i - 1 : i + 1;
          if (all[j]) {
            // Renumber in the new order so equal or gapped positions can never confuse the swap.
            [all[i], all[j]] = [all[j], all[i]];
            all.forEach((c, k) => db.prepare('UPDATE categories SET position = ? WHERE id = ?').run(k + 1, c.id));
          }
        }
      });
      return listCategories();
    },
    // A category that still has documents is only removed after they move to another category: no file is ever lost.
    deleteCategory(id, moveTo) {
      tx(db, () => {
        const cat = getCategory(id);
        if (db.prepare('SELECT count(*) AS n FROM categories').get().n <= 1) throw new HttpError(409, 'Keep at least one category');
        const { n } = db.prepare('SELECT count(*) AS n FROM documents WHERE category = ?').get(cat.name);
        if (n) {
          const target = moveTo && db.prepare('SELECT * FROM categories WHERE id = ?').get(moveTo);
          if (!target || target.id === cat.id) throw new HttpError(409, `"${cat.name}" still has ${n} document${n > 1 ? 's' : ''}. Choose a category to move ${n > 1 ? 'them' : 'it'} to.`);
          db.prepare('UPDATE documents SET category = ? WHERE category = ?').run(target.name, cat.name);
        }
        db.prepare('DELETE FROM categories WHERE id = ?').run(cat.id);
      });
      return listCategories();
    },

    facets() {
      const col = (sql) => db.prepare(sql).all().map((r) => r.v);
      return {
        projects: col(`SELECT DISTINCT project_name AS v FROM contracts WHERE project_name <> '' ORDER BY v`),
        firms: col(`SELECT DISTINCT firm_name AS v FROM contracts WHERE firm_name <> '' ORDER BY v`),
        currencies: col(`SELECT DISTINCT currency AS v FROM contracts ORDER BY v`),
        tags: db
          .prepare(`SELECT t.name, count(*) AS count FROM tags t JOIN document_tags dt ON dt.tag_id = t.id GROUP BY t.id ORDER BY t.key`)
          .all(),
        counts: db
          .prepare(`SELECT (SELECT count(*) FROM contracts) AS contracts, (SELECT count(*) FROM nocs) AS nocs, (SELECT count(*) FROM documents) AS documents`)
          .get(),
      };
    },

    // Contracts
    listContracts: (query) => listContracts(readFilters(query)),
    getContract,
    createContract(b) {
      const vals = contractInput(b);
      const { lastInsertRowid } = db
        .prepare('INSERT INTO contracts (contract_no, project_name, firm_name, amount, currency) VALUES (?, ?, ?, ?, ?)')
        .run(...vals);
      return getContract(lastInsertRowid);
    },
    updateContract(id, b) {
      const vals = contractInput(b);
      const r = db
        .prepare(
          `UPDATE contracts SET contract_no = ?, project_name = ?, firm_name = ?, amount = ?, currency = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ') WHERE id = ?`,
        )
        .run(...vals, id);
      if (!r.changes) throw new HttpError(404, 'Contract not found');
      return getContract(id);
    },
    deleteContract: (id) => deleteParent('contracts', id),

    // NOCs
    listNocs: (query) => listNocs(readFilters(query)),
    getNoc,
    createNoc(b) {
      const { lastInsertRowid } = db.prepare('INSERT INTO nocs (indent_no, noc_name) VALUES (?, ?)').run(...nocInput(b));
      return getNoc(lastInsertRowid);
    },
    updateNoc(id, b) {
      const r = db
        .prepare(`UPDATE nocs SET indent_no = ?, noc_name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ') WHERE id = ?`)
        .run(...nocInput(b), id);
      if (!r.changes) throw new HttpError(404, 'NOC not found');
      return getNoc(id);
    },
    deleteNoc: (id) => deleteParent('nocs', id),

    // Records files the platform has already stored. stored: [{ original_name, storage_name, file_path, size_bytes }];
    // metaJson: per-file details from the upload form. All or nothing: on any problem, every stored file is removed.
    addDocuments(parentType, parentId, stored, metaJson) {
      try {
        if (!stored.length) bad('Choose at least one file');
        const table = parentType === 'contract' ? 'contracts' : 'nocs';
        if (!db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(parentId)) throw new HttpError(404, `${parentType === 'contract' ? 'Contract' : 'NOC'} not found`);
        let meta = [];
        try {
          meta = JSON.parse(metaJson || '[]');
        } catch {
          bad('Invalid upload details');
        }
        const ids = tx(db, () =>
          stored.map((file, i) => {
            const ext = extname(file.original_name);
            const type = FILE_TYPES[ext.toLowerCase()];
            if (!type) bad(`"${file.original_name}" is not a PDF, image or Excel file`);
            const m = meta[i] || {};
            const { display_name, reference_no, category } = docMetaInput(m, parentType, file.original_name.slice(0, file.original_name.length - ext.length));
            const { lastInsertRowid } = db
              .prepare(
                `INSERT INTO documents (contract_id, noc_id, display_name, original_name, storage_name, file_path,
                   mime_type, file_type, size_bytes, category, reference_no) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              )
              .run(
                parentType === 'contract' ? parentId : null,
                parentType === 'noc' ? parentId : null,
                display_name,
                file.original_name,
                file.storage_name,
                file.file_path,
                type[1],
                type[0],
                file.size_bytes,
                category,
                reference_no,
              );
            setTags(lastInsertRowid, m.tags);
            return lastInsertRowid;
          }),
        );
        return ids.map(getDoc);
      } catch (err) {
        // Nothing was committed: remove every file this upload stored.
        files.remove(stored.map((f) => f.storage_name));
        throw err;
      }
    },

    // Documents
    listDocuments: (query) => listDocs(readFilters(query)),
    getDocument: getDoc,
    updateDocument(id, b) {
      const doc = getDoc(id);
      tx(db, () => {
        const merged = {
          display_name: b.display_name ?? doc.display_name,
          reference_no: b.reference_no !== undefined ? b.reference_no : doc.reference_no,
          category: b.category ?? doc.category,
        };
        if (!str(merged.display_name)) bad('Display name cannot be empty');
        const m = docMetaInput(merged, doc.parent.type, doc.display_name);
        db.prepare('UPDATE documents SET display_name = ?, reference_no = ?, category = ? WHERE id = ?').run(m.display_name, m.reference_no, m.category, doc.id);
        if (b.tags !== undefined) setTags(doc.id, b.tags);
        pruneTags();
      });
      return getDoc(doc.id);
    },
    deleteDocument(id) {
      const doc = getDoc(id);
      tx(db, () => {
        db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id);
        pruneTags();
      });
      files.remove([doc.storage_name]);
      return { ok: true };
    },

    // Everything the Excel export shows (record fields + attachment counts + one row per document), filtered like the lists.
    exportData(query) {
      const f = readFilters(query);
      const scope = ['contracts', 'nocs'].includes(query.scope) ? query.scope : 'all';
      const contracts = scope === 'nocs' ? [] : listContracts(f, { all: true }).items;
      const nocs = scope === 'contracts' ? [] : listNocs(f, { all: true }).items;
      const cw = contractWhere(f);
      const nw = nocWhere(f);
      const docs = db
        .prepare(
          `${DOC_SELECT}, 0 AS rank ${DOC_FROM}
           WHERE ${scope === 'nocs' ? '0' : `d.contract_id IN (SELECT c.id FROM contracts c ${cw.sql})`}
              OR ${scope === 'contracts' ? '0' : `d.noc_id IN (SELECT n.id FROM nocs n ${nw.sql})`}
           ORDER BY d.contract_id IS NULL, c.contract_no, n.indent_no, d.category, d.uploaded_at`,
        )
        .all(...(scope === 'nocs' ? [] : cw.p), ...(scope === 'contracts' ? [] : nw.p))
        .map(docRow);
      return { scope, contracts, nocs, docs, categories: categoryNames() };
    },

    // Startup check: removes leftover stored files and lists documents whose file is missing.
    sweepOrphans() {
      const known = new Set(db.prepare('SELECT storage_name FROM documents').all().map((r) => r.storage_name));
      const orphans = files.list().filter((n) => STORED_NAME.test(n) && !known.has(n));
      files.remove(orphans);
      const missing = db.prepare('SELECT id, file_path FROM documents').all().filter((d) => !files.exists(d.file_path)).map((d) => d.id);
      return { removed: orphans.length, missing };
    },
  };
}
