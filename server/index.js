import express from 'express';
import multer from 'multer';
import ExcelJS from 'exceljs';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, randomBytes, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { openDb, tx, tagKey, CATEGORIES } from './db.js';

const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
const PORT = Number(process.env.PORT || 4780);
// Phone access over Wi-Fi is off unless a passcode is set; then the app also listens on the network.
const LAN_PASSCODE = process.env.LAN_PASSCODE || '';
if (LAN_PASSCODE && LAN_PASSCODE.length < 6) {
  console.error('LAN_PASSCODE must be at least 6 characters.');
  process.exit(1);
}
const HOST = LAN_PASSCODE ? '0.0.0.0' : '127.0.0.1';
const FILES_DIR = path.join(DATA_DIR, 'files');
const DIST_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');

const db = openDb(DATA_DIR);

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

class HttpError extends Error {
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
const removeFiles = (names) => {
  for (const n of names) {
    try {
      fs.rmSync(path.join(FILES_DIR, n), { force: true });
    } catch (err) {
      // Left for the startup sweep to clean up.
      console.error('Could not remove file', n, err.message);
    }
  }
};

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

// ---------- tags ----------

function normaliseTags(input) {
  const list = Array.isArray(input) ? input : typeof input === 'string' ? input.split(',') : [];
  const seen = new Map();
  for (const raw of list) {
    const name = str(raw).replace(/\s+/g, ' ');
    if (name && !seen.has(tagKey(name))) seen.set(tagKey(name), name);
  }
  return [...seen.entries()];
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

// ---------- input validation ----------

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

function docMetaInput(m, parentType, fallbackName) {
  const display_name = str(m.display_name) || fallbackName;
  const reference_no = str(m.reference_no) || null;
  let category = null;
  if (parentType === 'contract') {
    category = str(m.category);
    if (!CATEGORIES.includes(category)) bad(`Choose a valid category for "${display_name}"`);
  }
  return { display_name, reference_no, category };
}

// ---------- app ----------

const app = express();
app.disable('x-powered-by');

// Only answer requests addressed to this machine (or, with Wi-Fi access on, to a raw IP / .local name),
// which blocks DNS-rebinding; and refuse writes coming from other websites.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const allowedHost = (h) => LOCAL_HOSTS.has(h) || (!!LAN_PASSCODE && (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || /^\[[0-9a-f:.]+\]$/i.test(h) || /\.local$/i.test(h)));
app.use((req, res, next) => {
  if (!allowedHost((req.headers.host || '').replace(/:\d+$/, ''))) return res.status(403).send('Forbidden');
  const origin = req.headers.origin;
  if (origin && !['GET', 'HEAD'].includes(req.method)) {
    let ok = false;
    try {
      const o = new URL(origin);
      ok = o.host === req.headers.host || LOCAL_HOSTS.has(o.hostname);
    } catch {}
    if (!ok) return res.status(403).send('Forbidden');
  }
  next();
});
app.use(express.json());

// ---------- passcode (only when Wi-Fi access is on; this computer itself never needs it) ----------

const sameSecret = (a, b) => timingSafeEqual(createHash('sha256').update(String(a)).digest(), createHash('sha256').update(String(b)).digest());
const isLoopback = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const readCookie = (req, name) => (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1) || '';
// Session cookie = HMAC(secret kept in the data folder, passcode): survives restarts, and changing the passcode logs every phone out.
const SESSION = LAN_PASSCODE
  ? (() => {
      const keyFile = path.join(DATA_DIR, 'session.key');
      if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
      return createHmac('sha256', fs.readFileSync(keyFile)).update(LAN_PASSCODE).digest('hex');
    })()
  : '';
const failedLogins = new Map(); // ip -> { count, until }
const giveSession = (res) => res.cookie('cd_session', SESSION, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 864e5, path: '/' });

// Addresses a phone on the same network can reach (skips virtual adapters like Docker and VMs).
const lanAddresses = () =>
  Object.entries(os.networkInterfaces())
    .filter(([name]) => !/^(docker|br-|veth|virbr|vmnet|vboxnet)/.test(name))
    .flatMap(([, nets]) => nets.filter((n) => n.family === 'IPv4' && !n.internal).map((n) => n.address));

app.post('/api/login', (req, res) => {
  if (!LAN_PASSCODE) throw new HttpError(404, 'Not found');
  const ip = req.socket.remoteAddress;
  const f = failedLogins.get(ip) || { count: 0, until: 0 };
  if (f.until > Date.now()) throw new HttpError(429, 'Too many wrong passcodes. Try again in 5 minutes.');
  if (!sameSecret(str(req.body?.passcode), LAN_PASSCODE)) {
    if (++f.count >= 5) (f.until = Date.now() + 5 * 60_000), (f.count = 0);
    failedLogins.set(ip, f);
    throw new HttpError(401, 'Wrong passcode');
  }
  failedLogins.delete(ip);
  giveSession(res);
  res.json({ ok: true });
});

// Scan-to-connect: the computer shows a QR code holding a one-time link that unlocks the scanning phone.
// Codes work once and expire after 10 minutes, so a photo of an old code is useless.
const PAIR_TTL = 10 * 60_000;
const pairCodes = new Map(); // code -> expiry time

app.post('/api/pair', async (req, res) => {
  if (!LAN_PASSCODE) throw new HttpError(404, 'Wi-Fi access is off');
  if (!isLoopback(req)) throw new HttpError(403, 'Phones can only be connected from the computer running the app');
  for (const [c, until] of pairCodes) if (until < Date.now()) pairCodes.delete(c);
  const code = randomBytes(24).toString('base64url');
  const expiresAt = Date.now() + PAIR_TTL;
  pairCodes.set(code, expiresAt);
  const links = await Promise.all(
    lanAddresses().map(async (ip) => {
      const url = `http://${ip}:${PORT}/pair/${code}`;
      return { url, svg: await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }) };
    }),
  );
  res.json({ links, expiresAt });
});

app.get('/pair/:code', (req, res) => {
  const until = LAN_PASSCODE && pairCodes.get(req.params.code);
  pairCodes.delete(req.params.code); // one use only, even if expired
  if (!until || until < Date.now()) return res.redirect('/?pair=failed');
  giveSession(res);
  res.redirect('/');
});

app.use('/api', (req, res, next) => {
  if (!LAN_PASSCODE || isLoopback(req) || sameSecret(readCookie(req, 'cd_session'), SESSION)) return next();
  res.status(401).json({ error: 'Passcode required', login: true });
});

app.get('/api/meta', (req, res) => {
  res.json({ categories: CATEGORIES, dataDir: DATA_DIR, fileTypes: Object.keys(FILE_TYPES), lan: !!LAN_PASSCODE, onThisComputer: isLoopback(req) });
});

app.get('/api/facets', (req, res) => {
  const col = (sql) => db.prepare(sql).all().map((r) => r.v);
  res.json({
    projects: col(`SELECT DISTINCT project_name AS v FROM contracts WHERE project_name <> '' ORDER BY v`),
    firms: col(`SELECT DISTINCT firm_name AS v FROM contracts WHERE firm_name <> '' ORDER BY v`),
    currencies: col(`SELECT DISTINCT currency AS v FROM contracts ORDER BY v`),
    tags: db
      .prepare(`SELECT t.name, count(*) AS count FROM tags t JOIN document_tags dt ON dt.tag_id = t.id GROUP BY t.id ORDER BY t.key`)
      .all(),
    counts: db
      .prepare(`SELECT (SELECT count(*) FROM contracts) AS contracts, (SELECT count(*) FROM nocs) AS nocs, (SELECT count(*) FROM documents) AS documents`)
      .get(),
  });
});

// Contracts
app.get('/api/contracts', (req, res) => res.json(listContracts(readFilters(req.query))));

app.post('/api/contracts', (req, res) => {
  const vals = contractInput(req.body);
  const { lastInsertRowid } = db
    .prepare('INSERT INTO contracts (contract_no, project_name, firm_name, amount, currency) VALUES (?, ?, ?, ?, ?)')
    .run(...vals);
  res.status(201).json(getContract(lastInsertRowid));
});

function getContract(id) {
  const c = db.prepare(`SELECT c.*, ${DOC_COUNT_COLS} FROM contracts c WHERE c.id = ?`).get(id);
  if (!c) throw new HttpError(404, 'Contract not found');
  return { ...c, documents: listDocs({ contractId: c.id }, { all: true }).items };
}

app.get('/api/contracts/:id', (req, res) => res.json(getContract(req.params.id)));

app.put('/api/contracts/:id', (req, res) => {
  const vals = contractInput(req.body);
  const r = db
    .prepare(
      `UPDATE contracts SET contract_no = ?, project_name = ?, firm_name = ?, amount = ?, currency = ?,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ') WHERE id = ?`,
    )
    .run(...vals, req.params.id);
  if (!r.changes) throw new HttpError(404, 'Contract not found');
  res.json(getContract(req.params.id));
});

// Deleting a parent: remove DB rows first (cascade), then files. A file that fails to delete
// is an orphan the startup sweep removes; a row is never left pointing at a deleted file.
function deleteParent(table, id) {
  const col = table === 'contracts' ? 'contract_id' : 'noc_id';
  const names = tx(db, () => {
    const files = db.prepare(`SELECT storage_name FROM documents WHERE ${col} = ?`).all(id).map((r) => r.storage_name);
    const r = db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
    if (!r.changes) throw new HttpError(404, 'Record not found');
    pruneTags();
    return files;
  });
  removeFiles(names);
  return { deletedDocuments: names.length };
}

app.delete('/api/contracts/:id', (req, res) => res.json(deleteParent('contracts', req.params.id)));

// NOCs
app.get('/api/nocs', (req, res) => res.json(listNocs(readFilters(req.query))));

function getNoc(id) {
  const n = db.prepare(`SELECT n.*, (SELECT count(*) FROM documents d WHERE d.noc_id = n.id) AS doc_count FROM nocs n WHERE n.id = ?`).get(id);
  if (!n) throw new HttpError(404, 'NOC not found');
  return { ...n, documents: listDocs({ nocId: n.id }, { all: true }).items };
}

app.post('/api/nocs', (req, res) => {
  const { lastInsertRowid } = db.prepare('INSERT INTO nocs (indent_no, noc_name) VALUES (?, ?)').run(...nocInput(req.body));
  res.status(201).json(getNoc(lastInsertRowid));
});

app.get('/api/nocs/:id', (req, res) => res.json(getNoc(req.params.id)));

app.put('/api/nocs/:id', (req, res) => {
  const r = db
    .prepare(`UPDATE nocs SET indent_no = ?, noc_name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ') WHERE id = ?`)
    .run(...nocInput(req.body), req.params.id);
  if (!r.changes) throw new HttpError(404, 'NOC not found');
  res.json(getNoc(req.params.id));
});

app.delete('/api/nocs/:id', (req, res) => res.json(deleteParent('nocs', req.params.id)));

// Uploads
const upload = multer({
  storage: multer.diskStorage({
    destination: FILES_DIR,
    filename: (req, file, cb) => cb(null, randomUUID() + path.extname(file.originalname).toLowerCase()),
  }),
  limits: { fileSize: 500 * 1024 * 1024, files: 100 },
  defParamCharset: 'utf8', // browsers send raw UTF-8 filenames
});

function handleUpload(parentType) {
  return [
    upload.array('files'),
    (req, res) => {
      const files = req.files || [];
      try {
        if (!files.length) bad('Choose at least one file');
        const table = parentType === 'contract' ? 'contracts' : 'nocs';
        if (!db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(req.params.id)) throw new HttpError(404, `${parentType === 'contract' ? 'Contract' : 'NOC'} not found`);
        let meta = [];
        try {
          meta = JSON.parse(req.body.meta || '[]');
        } catch {
          bad('Invalid upload details');
        }
        const ids = tx(db, () =>
          files.map((file, i) => {
            const ext = path.extname(file.originalname).toLowerCase();
            const type = FILE_TYPES[ext];
            if (!type) bad(`"${file.originalname}" is not a PDF, image or Excel file`);
            const m = meta[i] || {};
            const { display_name, reference_no, category } = docMetaInput(m, parentType, path.basename(file.originalname, path.extname(file.originalname)));
            const { lastInsertRowid } = db
              .prepare(
                `INSERT INTO documents (contract_id, noc_id, display_name, original_name, storage_name, file_path,
                   mime_type, file_type, size_bytes, category, reference_no) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              )
              .run(
                parentType === 'contract' ? req.params.id : null,
                parentType === 'noc' ? req.params.id : null,
                display_name,
                file.originalname,
                file.filename,
                path.join('files', file.filename),
                type[1],
                type[0],
                file.size,
                category,
                reference_no,
              );
            setTags(lastInsertRowid, m.tags);
            return lastInsertRowid;
          }),
        );
        res.status(201).json(ids.map(getDoc));
      } catch (err) {
        // Nothing was committed: remove every file this request wrote.
        removeFiles(files.map((f) => f.filename));
        throw err;
      }
    },
  ];
}

app.post('/api/contracts/:id/documents', ...handleUpload('contract'));
app.post('/api/nocs/:id/documents', ...handleUpload('noc'));

// Documents
app.get('/api/documents', (req, res) => res.json(listDocs(readFilters(req.query))));
app.get('/api/documents/:id', (req, res) => res.json(getDoc(req.params.id)));

app.patch('/api/documents/:id', (req, res) => {
  const doc = getDoc(req.params.id);
  const b = req.body;
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
  res.json(getDoc(doc.id));
});

app.delete('/api/documents/:id', (req, res) => {
  const doc = getDoc(req.params.id);
  tx(db, () => {
    db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id);
    pruneTags();
  });
  removeFiles([doc.storage_name]);
  res.json({ ok: true });
});

app.get('/api/documents/:id/file', (req, res, next) => {
  const doc = getDoc(req.params.id);
  const abs = path.join(DATA_DIR, doc.file_path);
  if (!fs.existsSync(abs)) throw new HttpError(404, 'The stored file is missing from the data folder');
  const ext = path.extname(doc.original_name);
  const name = doc.display_name.toLowerCase().endsWith(ext.toLowerCase()) ? doc.display_name : doc.display_name + ext;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.query.download) return res.download(abs, name);
  res.type(doc.mime_type);
  res.sendFile(abs, { headers: { 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(name)}` } }, (err) => err && next(err));
});

// Excel export (record fields + attachment counts + one row per document; no files embedded)
app.get('/api/export.xlsx', async (req, res) => {
  const f = readFilters(req.query);
  const scope = ['contracts', 'nocs'].includes(req.query.scope) ? req.query.scope : 'all';
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

  const perCategory = new Map();
  for (const d of docs) if (d.contract_id) perCategory.set(`${d.contract_id}|${d.category}`, (perCategory.get(`${d.contract_id}|${d.category}`) || 0) + 1);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Contract Desk';
  wb.created = new Date();
  const sheet = (name, columns, rows) => {
    const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = columns;
    ws.addRows(rows);
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1B1A16' } };
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
    return ws;
  };

  if (scope !== 'nocs') {
    sheet(
      'Contracts',
      [
        { header: 'Contract No.', key: 'contract_no', width: 20 },
        { header: 'Project Name', key: 'project_name', width: 28 },
        { header: 'Firm Name', key: 'firm_name', width: 28 },
        { header: 'Amount', key: 'amount', width: 16, style: { numFmt: '#,##0.00' } },
        { header: 'Currency', key: 'currency', width: 10 },
        { header: 'Attachments', key: 'doc_count', width: 13 },
        ...CATEGORIES.map((c, i) => ({ header: c, key: `cat${i}`, width: 16 })),
        { header: 'Created', key: 'created_at', width: 22 },
        { header: 'Updated', key: 'updated_at', width: 22 },
      ],
      contracts.map((c) => ({ ...c, ...Object.fromEntries(CATEGORIES.map((cat, i) => [`cat${i}`, perCategory.get(`${c.id}|${cat}`) || 0])) })),
    );
  }
  if (scope !== 'contracts') {
    sheet(
      'NOCs',
      [
        { header: 'Indent No.', key: 'indent_no', width: 16 },
        { header: 'NOC Name', key: 'noc_name', width: 36 },
        { header: 'Attachments', key: 'doc_count', width: 13 },
        { header: 'Created', key: 'created_at', width: 22 },
        { header: 'Updated', key: 'updated_at', width: 22 },
      ],
      nocs,
    );
  }
  sheet(
    'Documents',
    [
      { header: 'Document ID', key: 'id', width: 12 },
      { header: 'Parent Type', key: 'parent_type', width: 12 },
      { header: 'Contract No. / Indent No.', key: 'parent_no', width: 24 },
      { header: 'Parent Name', key: 'parent_name', width: 28 },
      { header: 'Document Name', key: 'display_name', width: 32 },
      { header: 'Original Filename', key: 'original_name', width: 32 },
      { header: 'Category', key: 'category', width: 26 },
      { header: 'Reference No.', key: 'reference_no', width: 18 },
      { header: 'Tags', key: 'tags', width: 28 },
      { header: 'File Type', key: 'file_type', width: 10 },
      { header: 'Size (bytes)', key: 'size_bytes', width: 13 },
      { header: 'Uploaded', key: 'uploaded_at', width: 22 },
      { header: 'Stored File', key: 'file_path', width: 50 },
    ],
    docs.map((d) => ({
      ...d,
      parent_type: d.parent.type === 'contract' ? 'Contract' : 'NOC',
      parent_no: d.parent.no,
      parent_name: d.parent.name,
      category: d.category || '',
      reference_no: d.reference_no || '',
      tags: d.tags.join(', '),
    })),
  );

  const stamp = new Date().toISOString().slice(0, 10);
  res.attachment(`contract-desk-export-${stamp}.xlsx`);
  res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  await wb.xlsx.write(res);
  res.end();
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// Built frontend
app.use(express.static(DIST_DIR));
app.get('/', (req, res) => res.sendFile(path.join(DIST_DIR, 'index.html'), (err) => err && res.status(404).send('Frontend not built. Run: npm run build')));

app.use((err, req, res, next) => {
  let status = err.status || 500;
  let message = err.message;
  const msg = String(err.message || '');
  if (err instanceof multer.MulterError) status = 400;
  else if (msg.includes('UNIQUE constraint failed: contracts.contract_no')) (status = 409), (message = 'That Contract No. already exists');
  else if (msg.includes('UNIQUE constraint failed: nocs.indent_no')) (status = 409), (message = 'That Indent No. already exists');
  else if (msg.includes('constraint failed')) (status = 400), (message = 'The data breaks a database rule: ' + msg);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: message });
});

// Remove stored files with no database row (left by a crash mid-upload or a failed delete).
function sweepOrphans() {
  const known = new Set(db.prepare('SELECT storage_name FROM documents').all().map((r) => r.storage_name));
  const orphans = fs.readdirSync(FILES_DIR).filter((n) => !known.has(n));
  removeFiles(orphans);
  if (orphans.length) console.log(`Removed ${orphans.length} orphaned file(s) from ${FILES_DIR}`);
  const missing = db.prepare('SELECT id, file_path FROM documents').all().filter((d) => !fs.existsSync(path.join(DATA_DIR, d.file_path)));
  if (missing.length) console.warn(`Warning: ${missing.length} document(s) point to missing files:`, missing.map((d) => d.id).join(', '));
}

sweepOrphans();
app.listen(PORT, HOST, () => {
  console.log(`Contract Desk running at http://127.0.0.1:${PORT}`);
  console.log(`Data folder: ${DATA_DIR}`);
  if (LAN_PASSCODE) {
    for (const ip of lanAddresses()) console.log(`Wi-Fi access ON (passcode required): http://${ip}:${PORT}`);
    console.log('To connect a phone without typing the passcode: open the app here and use "Connect phone".');
  }
});
