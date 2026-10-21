import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { openDb, openWasmDb } from './db.js';
import { createRules, errorReply, downloadName, storedName, UPLOAD_LIMITS, HttpError } from '../core/rules.js';
import { exportWorkbook, exportFileName } from '../core/export.js';
import { ROUTES } from '../core/routes.js';

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

// DB_ENGINE=wasm runs the phone's SQLite build instead, so the tests can check the shared rules on both.
const db = process.env.DB_ENGINE === 'wasm' ? await openWasmDb(DATA_DIR) : openDb(DATA_DIR);

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
// Business rules are shared with the phone app (core/); this file only adds what is desktop-specific.
const rules = createRules({
  db,
  files: {
    remove: removeFiles,
    list: () => fs.readdirSync(FILES_DIR),
    exists: (filePath) => fs.existsSync(path.join(DATA_DIR, filePath)),
  },
});
const str = (v) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());

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
  const { categories, fileTypes } = rules.meta();
  res.json({ categories, dataDir: DATA_DIR, fileTypes, lan: !!LAN_PASSCODE, onThisComputer: isLoopback(req) });
});

// Contracts, NOCs, documents, categories and facets: the route table is shared with the phone app.
for (const [method, route, handler, status = 200] of ROUTES) {
  app[method.toLowerCase()](route, (req, res) => res.status(status).json(handler(rules, req.params, req.query, req.body)));
}

// Uploads: multer streams the files to disk, then the shared rules record them (or remove them all on any problem).
const upload = multer({
  storage: multer.diskStorage({
    destination: FILES_DIR,
    filename: (req, file, cb) => cb(null, storedName(file.originalname)),
  }),
  limits: UPLOAD_LIMITS,
  defParamCharset: 'utf8', // browsers send raw UTF-8 filenames
});

const handleUpload = (parentType) => [
  upload.array('files'),
  (req, res) => {
    const stored = (req.files || []).map((f) => ({ original_name: f.originalname, storage_name: f.filename, file_path: path.join('files', f.filename), size_bytes: f.size }));
    res.status(201).json(rules.addDocuments(parentType, req.params.id, stored, req.body.meta));
  },
];

app.post('/api/contracts/:id/documents', ...handleUpload('contract'));
app.post('/api/nocs/:id/documents', ...handleUpload('noc'));

app.get('/api/documents/:id/file{/:name}', (req, res, next) => {
  const doc = rules.getDocument(req.params.id);
  const abs = path.join(DATA_DIR, doc.file_path);
  if (!fs.existsSync(abs)) throw new HttpError(404, 'The stored file is missing from the data folder');
  const name = downloadName(doc);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.query.download) return res.download(abs, name);
  res.type(doc.mime_type);
  res.sendFile(abs, { headers: { 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(name)}` } }, (err) => err && next(err));
});

// Excel export (record fields + attachment counts + one row per document; no files embedded)
app.get('/api/export.xlsx', async (req, res) => {
  const wb = exportWorkbook(rules.exportData(req.query));
  res.attachment(exportFileName());
  res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  await wb.xlsx.write(res);
  res.end();
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// Built frontend
app.use(express.static(DIST_DIR));
app.get('/', (req, res) => res.sendFile(path.join(DIST_DIR, 'index.html'), (err) => err && res.status(404).send('Frontend not built. Run: npm run build')));

app.use((err, req, res, next) => {
  const { status, message } = err instanceof multer.MulterError ? { status: 400, message: err.message } : errorReply(err);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: message });
});

// Startup cleanup of files left by a crash mid-upload or a failed delete (rule in core/rules.js).
const sweep = rules.sweepOrphans();
if (sweep.removed) console.log(`Removed ${sweep.removed} orphaned file(s) from ${FILES_DIR}`);
if (sweep.missing.length) console.warn(`Warning: ${sweep.missing.length} document(s) point to missing files:`, sweep.missing.join(', '));
// Ctrl+C / kill: exit normally so the database is closed (see openDb).
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => process.exit(0));
// Resolves once listening; the desktop app awaits this, and a busy port rejects it (e.g. EADDRINUSE).
export const ready = new Promise((resolve, reject) => {
  const server = app.listen(PORT, HOST, () => {
    console.log(`Contract Desk running at http://127.0.0.1:${PORT}`);
    console.log(`Data folder: ${DATA_DIR}`);
    if (LAN_PASSCODE) {
      for (const ip of lanAddresses()) console.log(`Wi-Fi access ON (passcode required): http://${ip}:${PORT}`);
      console.log('To connect a phone without typing the passcode: open the app here and use "Connect phone".');
    }
    resolve({ port: PORT, lanAddresses: LAN_PASSCODE ? lanAddresses() : [] });
  });
  server.on('error', reject);
});
