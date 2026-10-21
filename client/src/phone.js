// Phone app (Android, Capacitor) only. The database lives in a worker (phone-worker.js); this side keeps a saved copy of
// it in the data folder (default Documents/Contract Desk, same layout as desktop: contracts.db + files/), which survives
// uninstall. Rules for the copy are in decision-2: save ~2 s after the last change via contracts.db.tmp + rename; at start
// the folder copy wins unless the phone has newer unsaved changes to that same file.
// Native calls go to the small Folder plugin (android/.../FolderPlugin.java). A folder is { path } (All files access: plain
// file I/O) or { path, tree } (permission refused: everything through the system picker's content:// link).
import { storedName, downloadName, UPLOAD_LIMITS } from '../../core/rules.js';
import { backupFileName, backupManifest, damaged, readBackup, sha256Hasher, tarEnd, tarHeader, tarPad } from '../../core/backup.js';
import { version } from '../../package.json';

const cap = typeof window !== 'undefined' ? window.Capacitor : undefined;
export const isPhone = !!cap?.isNativePlatform?.();
const native = (method, options = {}) => cap.nativePromise('Folder', method, options);

const DEFAULT_FOLDER = '/storage/emulated/0/Documents/Contract Desk';
const DB = 'contracts.db';
const TMP = 'contracts.db.tmp';
const PIECE = 4 * 1024 * 1024; // whole-file bridge calls crash on big files (decision-1): always 4 MB pieces
const SAVE_DELAY = 2000;

let worker;
let folder = null; // the data folder in use
let phoneState = { gen: 0, saved: null }; // from the worker: change counter + last saved/opened folder file
export let status = { name: 'starting', message: '' };
let markReady;
const ready = new Promise((r) => (markReady = r));
function setStatus(name, message = '') {
  status = { name, message };
  if (name === 'ready') markReady();
  window.dispatchEvent(new Event('phone-status'));
}

// ---------- worker ----------

let seq = 0;
const waiting = new Map();
function call(op, args = {}, transfer = []) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, { resolve, reject });
    worker.postMessage({ id, op, ...args }, transfer);
  });
}
function onWorkerMessage({ data }) {
  if (data.type === 'changed') return scheduleSave();
  if (data.type === 'remove') return removeFiles(data.names);
  const w = waiting.get(data.id);
  waiting.delete(data.id);
  data.error ? w.reject(new Error(data.error)) : w.resolve(data.result);
}

// Same contract as fetch-based api() on the desktop: resolves with the JSON, throws Error(message).
export async function request(method, url, body) {
  await ready;
  const r = await call('request', { method, url, body });
  if (r.error) throw new Error(r.error);
  return url === '/api/meta' ? { ...r.data, dataDir: folder.path, lan: false, onThisComputer: false } : r.data;
}

// ---------- folder I/O ----------

const where = (f) => f.tree || f.path;
const treeId = (tree) => decodeURIComponent(tree.slice(tree.indexOf('/tree/') + 6));
// A file in a folder as a file:// or content:// link (for the phone's own apps), and as a URL the WebView streams.
// ponytail: child links are built the way Android's own storage provider names them; the picker only accepts that provider.
const fileUri = (f, rel) =>
  f.tree ? `${f.tree}/document/${encodeURIComponent(`${treeId(f.tree)}/${rel}`)}` : `file://${`${f.path}/${rel}`.split('/').map(encodeURIComponent).join('/')}`;
const fileSrc = (f, rel) => cap.convertFileSrc(fileUri(f, rel));
export const docSrc = (filePath) => fileSrc(folder, filePath.replaceAll('\\', '/'));

async function read(f, name) {
  const res = await fetch(fileSrc(f, name), { cache: 'no-store' });
  if (!res.ok) throw new Error(`Could not read ${name} in ${f.path} (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}
const stat = (f, name) => native('stat', { folder: where(f), name });
// Which file this is: size + SHA-256 of its bytes. Not the modified time: on the S24+ (Android 16) the time reported
// for contracts.db after a rename was sometimes the old file's, which made the app re-open the folder copy and drop
// changes it had not saved yet.
const sha256 = async (bytes) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
const fileKey = async (bytes) => `${bytes.length}|${await sha256(bytes)}`;
const base64 = (bytes) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result.slice(r.result.indexOf(',') + 1));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(new Blob([bytes]));
  });

async function writePieces(f, name, bytes, append = false) {
  for (let at = 0; at === 0 || at < bytes.length; at += PIECE) {
    await native('write', { folder: where(f), name, data: await base64(bytes.subarray(at, at + PIECE)), append: append || at > 0 });
  }
}

function removeFiles(names, f = folder) {
  for (const n of names) native('remove', { folder: where(f), name: `files/${n}` }).catch((err) => console.error('Could not remove file', n, err));
}

// ---------- documents ----------

// Same contract as uploadFiles() on the desktop. Each file goes to files/ in 4 MB pieces, then the rules record them all
// at once. On any problem nothing is recorded and every file this upload wrote is removed (the rules remove theirs).
export async function upload(url, files, meta, onProgress) {
  await ready;
  const [, kind, id] = url.match(/^\/api\/(contracts|nocs)\/(\d+)\/documents$/);
  const mb = (n) => `${Math.ceil(n / 1048576)} MB`;
  if (files.length > UPLOAD_LIMITS.files) throw new Error(`Add at most ${UPLOAD_LIMITS.files} files at a time`);
  const big = files.find((file) => file.size > UPLOAD_LIMITS.fileSize);
  if (big) throw new Error(`"${big.name}" is ${mb(big.size)}; one file can be at most ${mb(UPLOAD_LIMITS.fileSize)}`);
  const f = folder;
  const total = files.reduce((n, file) => n + file.size, 0) || 1;
  const stored = [];
  let done = 0;
  for (const file of files) {
    const name = storedName(file.name);
    stored.push({ original_name: file.name, storage_name: name, file_path: `files/${name}`, size_bytes: file.size });
    try {
      for (let at = 0; at === 0 || at < file.size; at += PIECE) {
        const piece = file.slice(at, at + PIECE);
        await native('write', { folder: where(f), name: `files/${name}`, data: await base64(piece), append: at > 0 });
        onProgress((done += piece.size) / total);
      }
    } catch (err) {
      removeFiles(stored.map((s) => s.storage_name), f);
      throw new Error(`Could not save "${file.name}" in ${f.path}: ${err.message}`);
    }
  }
  return call('addDocuments', { parentType: kind === 'contracts' ? 'contract' : 'noc', parentId: Number(id), stored, meta: JSON.stringify(meta) });
}

// The phone's own apps: "Open with…" (PDF reader, spreadsheet app), Downloads and the share sheet. Outside the app a file
// keeps its display name; characters Android's shared storage refuses become "_".
const relPath = (doc) => doc.file_path.replaceAll('\\', '/');
const outName = (doc) => downloadName(doc).replace(/[\\/:*?"<>|]/g, '_');
export async function openDoc(doc) {
  try {
    await cap.nativePromise('FileOpener', 'open', { filePath: fileUri(folder, relPath(doc)), contentType: doc.mime_type });
  } catch (err) {
    throw new Error(/activity not found/i.test(err.message) ? `No app on this phone opens ${doc.original_name.split('.').pop().toUpperCase()} files` : err.message);
  }
}
export const saveCopy = async (doc) => (await native('saveToDownloads', { folder: where(folder), name: relPath(doc), as: outName(doc), mime: doc.mime_type })).name;
export const shareDoc = (doc) => native('share', { folder: where(folder), name: relPath(doc), as: outName(doc), mime: doc.mime_type });

// ---------- saving the folder copy ----------

let timer;
let saving = Promise.resolve();
function scheduleSave() {
  clearTimeout(timer);
  timer = setTimeout(() => save().catch((err) => (console.error('Saving to the data folder failed; retrying', err), scheduleSave())), SAVE_DELAY);
}
// Saves never overlap. A crash mid-save leaves contracts.db as it was (only the .tmp is half-written).
// The new file is noted as "pending" before it is written: if the app dies after the replace but before the marker is
// final, the next start still knows that file is the phone's own, and changes made since are saved, not dropped.
function save() {
  const run = async () => {
    if (!folder) return;
    const f = folder;
    const { bytes, gen } = await call('export');
    const key = await fileKey(bytes);
    phoneState = await call('setSaved', { saved: { ...phoneState.saved, pending: { folder: f, key, gen } } });
    await writePieces(f, TMP, bytes);
    await native('rename', { folder: where(f), from: TMP, to: DB });
    phoneState = await call('setSaved', { saved: { folder: f, key, gen } });
  };
  return (saving = saving.then(run, run));
}

// ---------- opening a folder ----------

// With All files access the chosen folder is also noted in shared storage, so a reinstall opens it again
// (the phone database, which remembers it otherwise, is wiped on uninstall). Picker links can't survive uninstall anyway.
const POINTER = { path: '/storage/emulated/0/Documents' };
const POINTER_NAME = '.contract-desk-folder';
function rememberFolder(path) {
  base64(new TextEncoder().encode(path))
    .then((data) => native('write', { folder: POINTER.path, name: POINTER_NAME, data, append: false }))
    .catch((err) => console.error('Could not note the data folder', err));
}
// Keeps the note in step with the folder in use, also one chosen with the picker while All files access was off.
async function syncPointer() {
  if (!folder || !folder.path.startsWith('/storage/') || !(await hasAccess())) return;
  const noted = await read(POINTER, POINTER_NAME).then((b) => new TextDecoder().decode(b).trim(), () => '');
  if (noted !== folder.path) rememberFolder(folder.path);
}
async function rememberedFolder() {
  try {
    const path = new TextDecoder().decode(await read(POINTER, POINTER_NAME)).trim();
    if (path.startsWith('/storage/') && (await stat({ path }, DB)).exists) return { path };
  } catch {}
  return null; // missing or unreadable: the default folder
}

// Decision-2's start-up rule, plus recovery from a save interrupted between writing the .tmp and renaming it.
// The folder copy wins (it is imported) when the phone has no saved marker yet (new install or reinstall), the folder is
// another one (just chosen), or its file changed since the last save (e.g. copied from the computer).
async function attach(f) {
  await native('prepare', { folder: where(f) }); // creates the folder and files/ if missing
  // Changes the desktop has not yet merged into contracts.db would be missed: refuse rather than open old records.
  if ((await stat(f, `${DB}-wal`)).size > 0) {
    throw new Error(`The records in ${f.path} are still open in Contract Desk on a computer (contracts.db-wal). Close Contract Desk there, copy the folder again, then try again.`);
  }
  const saved = phoneState.saved;
  // The phone's own copy of this folder: the last finished save, or one that was being written when the app died.
  const mine = async (bytes) => {
    const key = await fileKey(bytes);
    return [saved, saved?.pending].find((m) => m?.key === key && m.folder?.path === f.path);
  };
  let file = await stat(f, DB);
  const tmp = await stat(f, TMP);
  if (tmp.exists) {
    const bytes = await read(f, TMP);
    const newer = !file.exists || tmp.mtime > file.mtime;
    if ((await mine(bytes)) || (newer && (await call('healthy', { bytes })))) {
      await native('rename', { folder: where(f), from: TMP, to: DB });
      file = await stat(f, DB);
    } else await native('remove', { folder: where(f), name: TMP });
  }
  const bytes = file.exists && (await read(f, DB));
  const ours = bytes && (await mine(bytes));
  if (!file.exists) {
    folder = f;
    await save(); // empty folder: the phone's records go there
  } else if (!ours) {
    // New install or reinstall, another folder, or a file changed elsewhere (e.g. copied from the computer).
    phoneState = await call('import', { bytes, saved: { folder: f, key: await fileKey(bytes) } }, [bytes.buffer]);
    folder = f;
  } else {
    folder = f;
    if (ours !== saved || where(ours.folder) !== where(f)) phoneState = await call('setSaved', { saved: { folder: f, key: ours.key, gen: ours.gen } });
    if (phoneState.gen > ours.gen) await save(); // changes the folder copy does not have yet (killed before or during a save)
  }
  await syncPointer();
  const { names } = await native('list', { folder: where(f), dir: 'files' });
  await call('sweep', { names });
  setStatus('ready');
}

const hasAccess = async () => (await native('hasAllFilesAccess')).granted;

// One at a time: coming back from the Settings page also fires visibilitychange.
let connecting = null;
const connect = () => (connecting ||= reconnect().finally(() => (connecting = null)));
async function reconnect() {
  const access = await hasAccess();
  const f = phoneState.saved?.folder || (access ? (await rememberedFolder()) || { path: DEFAULT_FOLDER } : null);
  if (!f || (!f.tree && !access)) return setStatus('setup', f ? 'All files access is off.' : '');
  try {
    await attach(f);
  } catch (err) {
    folder = null;
    setStatus('setup', err.message);
  }
}

export async function start() {
  try {
    worker = new Worker(new URL('./phone-worker.js', import.meta.url), { type: 'module' });
  } catch {
    return setStatus('webview');
  }
  worker.onmessage = onWorkerMessage;
  worker.onerror = () => status.name === 'starting' && setStatus('webview');
  const s = await call('init');
  if (s.webview) return setStatus('webview', s.detail);
  phoneState = s;
  await connect();
  // Coming back to the app: the owner may have turned All files access on or off in Settings.
  document.addEventListener('visibilitychange', async () => {
    if (document.hidden) return;
    if (status.name === 'setup') connect();
    else if (status.name === 'ready') {
      if (!folder.tree && !(await hasAccess())) setStatus('setup', 'All files access was turned off.');
      else syncPointer(); // access may have just been turned on for a folder chosen with the picker
    }
  });
}

export async function requestAccess() {
  await native('requestAllFilesAccess');
  await connect();
}

// What the data folder takes (database + documents) and what is free on the phone, for the storage line and warning.
export const LOW_SPACE = 500 * 1024 * 1024;
export async function space() {
  await ready;
  const [db, docs, { free }] = await Promise.all([stat(folder, DB), call('filePaths'), native('freeSpace', { path: folder.path })]);
  // In picker mode stat can fail and give no size: then the line shows only the free space.
  return { used: Number.isFinite(db.size) ? db.size + docs.reduce((n, d) => n + d.size_bytes, 0) : null, free };
}

const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const describe = (c) => `${count(c.contracts, 'contract')}, ${count(c.nocs, 'NOC')}, ${count(c.documents, 'document')}`;

// The system folder picker. Returns true when the app switched to the chosen folder.
export async function chooseFolder() {
  const pick = await native('pickFolder');
  if (!pick.uri) return false; // cancelled
  const f = (await hasAccess()) ? { path: pick.path } : { path: pick.path, tree: pick.uri };
  const current = folder || phoneState.saved?.folder;
  if (current?.path === f.path) {
    // The same folder (e.g. picked again after All files access was turned off): keep using it, nothing to ask.
    if (status.name === 'ready' && where(f) === where(current)) return false;
    await attach(f);
    return true;
  }
  await native('prepare', { folder: where(f) });
  const hasRecords = (await stat(f, DB)).exists || (await stat(f, TMP)).exists;
  if (status.name === 'ready') await save(); // the current folder keeps everything up to now
  if (hasRecords) {
    if (current && !confirm(`Open the records in this folder?\n\n${f.path} already holds Contract Desk records. Contract Desk will use them from now on.\n\nYour current records stay where they are, in:\n${current.path}`)) return false;
    await attach(f);
    return true;
  }
  const { counts } = (await call('request', { method: 'GET', url: '/api/facets' })).data;
  if (counts.contracts + counts.nocs + counts.documents) {
    const from = current;
    if (!confirm(`Move my records here?\n\nYour records (${describe(counts)}) and their files are copied to:\n${f.path}\n\nThe old folder is left as it is.`)) return false;
    for (const d of await call('filePaths')) {
      const name = d.file_path.replaceAll('\\', '/');
      const { bytes } = await native('copy', { from: where(from), to: where(f), name }).catch((err) => {
        throw new Error(`Could not copy ${name} from ${from.path}: ${err.message}. Your records were not moved.`);
      });
      if (bytes !== d.size_bytes) throw new Error(`The copy of ${name} is incomplete. Your records were not moved.`);
    }
  }
  await attach(f); // no contracts.db there yet: the phone's records are saved into it
  return true;
}

// Excel export: the same workbook as the desktop (core/export.js), built here; ExcelJS loads only when asked. Written in
// 4 MB pieces to the app's cache folder, then handed to Android's share menu (a spreadsheet app, Drive, Files…).
export async function shareExport(query) {
  const [{ exportWorkbook, exportFileName }, data] = await Promise.all([import('../../core/export.js'), call('exportData', { query })]);
  const bytes = new Uint8Array(await exportWorkbook(data).xlsx.writeBuffer());
  const { path } = await native('cacheFolder');
  const name = exportFileName();
  await writePieces({ path }, name, bytes);
  await native('share', { folder: path, name, as: name, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

// ---------- backup and restore (one format with the desktop: core/backup.js) ----------

const BATCH = 200; // documents per native call: few bridge round trips, still regular progress
const TAR = 'application/x-tar';
const join = async (...parts) => new Uint8Array(await new Blob(parts).arrayBuffer());
// Size and SHA-256 of files in a folder, worked out by the phone itself (the bytes never cross the bridge).
async function hashFiles(f, names) {
  const out = [];
  for (let i = 0; i < names.length; i += BATCH) out.push(...(await native('hashFiles', { folder: where(f), names: names.slice(i, i + BATCH) })).files);
  return out;
}

// Built in the app's cache: small parts (headers, the database) go over the bridge in 4 MB pieces, and each document is
// copied by the phone itself. Then it is saved to Downloads (outside the app, so it survives uninstall) and handed to
// the share menu (Drive, email, a computer…) so it can leave the phone. Returns the name it got in Downloads.
export async function backup(onProgress = () => {}) {
  await ready;
  const f = folder;
  const { bytes: dbBytes, docs, counts } = await call('backupData');
  const files = { 'contracts.db': { size: dbBytes.length, sha256: await sha256(dbBytes) } };
  const paths = docs.map((d) => d.file_path.replaceAll('\\', '/'));
  const items = []; // [name in the backup, path in the folder, size]
  (await hashFiles(f, paths)).forEach((h, i) => {
    if (!h.exists) return; // a document whose file is already missing is left out rather than stopping the backup
    const name = `files/${docs[i].storage_name}`;
    files[name] = { size: h.size, sha256: h.sha256 };
    items.push([name, paths[i], h.size]);
  });
  const manifest = new TextEncoder().encode(backupManifest({ appVersion: version, from: 'phone', counts, files }));
  const out = { path: (await native('cacheFolder')).path };
  const name = backupFileName();
  await writePieces(out, name, await join(tarHeader('manifest.json', manifest.length), manifest, tarPad(manifest.length), tarHeader('contracts.db', dbBytes.length)));
  await writePieces(out, name, dbBytes, true);
  let tail = tarPad(dbBytes.length); // the entry before's padding, sent with the next header
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    const parts = [];
    for (const [entry, rel, size] of batch) {
      parts.push({ data: await base64(await join(tail, tarHeader(entry, size))) }, { folder: where(f), name: rel });
      tail = tarPad(size);
    }
    const { sizes } = await native('append', { to: out.path, name, parts });
    const changed = batch.find(([, , size], j) => sizes[2 * j + 1] !== size);
    if (changed) throw new Error(`${changed[0]} changed while it was being backed up. Try again.`);
    onProgress(Math.min(1, (i + BATCH) / items.length));
  }
  await writePieces(out, name, await join(tail, tarEnd()), true);
  const saved = await native('saveToDownloads', { folder: out.path, name, as: name, mime: TAR });
  await call('noteBackup', { at: new Date().toISOString() });
  await native('share', { folder: out.path, name, as: name, mime: TAR, move: true });
  return saved.name;
}

let staged = null; // a checked backup waiting for the owner's yes: { bytes, manifest, written }

// Restore, step 1: reads the chosen file in 4 MB pieces and checks all of it (every entry's size and SHA-256, the
// database's integrity) before anything is replaced. Document files not already here go to files/ as they come: their
// names are new, so no current record uses them; if the check fails they are removed again. (A file of the same name
// that is here but differs is the same document, damaged: the backup's copy replaces it.) Answers what would be replaced.
export async function checkRestore(file) {
  await ready;
  cancelRestore();
  const f = folder;
  const written = []; // new files, removed again if the restore does not go ahead
  let here; // name in files/ -> 'same' (already holds the backup's bytes), 'differs' or 'new'
  let dbBytes;
  async function* pieces() {
    for (let at = 0; at < file.size; at += PIECE) yield new Uint8Array(await file.slice(at, at + PIECE).arrayBuffer());
  }
  try {
    const manifest = await readBackup(pieces(), async (name, size, sha, manifest) => {
      const hash = sha256Hasher();
      const parts = []; // the database is kept in memory, to import
      let write = null; // where a document's pieces go, unless the same file is already here
      if (name !== 'contracts.db') {
        if (!here) {
          const names = Object.keys(manifest.files).filter((n) => n !== 'contracts.db');
          const h = await hashFiles(f, names);
          here = new Map(names.map((n, i) => [n, !h[i].exists ? 'new' : h[i].sha256 === manifest.files[n].sha256 ? 'same' : 'differs']));
        }
        if (here.get(name) === 'new') written.push(name);
        let first = true;
        if (here.get(name) !== 'same') write = async (piece) => (await native('write', { folder: where(f), name, data: await base64(piece), append: !first }), (first = false));
        if (write && !size) await write(new Uint8Array(0));
      }
      return async (piece) => {
        if (piece) {
          hash.update(piece);
          return write ? write(piece) : name === 'contracts.db' && parts.push(piece.slice());
        }
        if (hash.hex() !== sha) throw damaged(`${name} does not match`);
        if (name === 'contracts.db') dbBytes = await join(...parts);
      };
    });
    const { now, backup } = await call('checkBackup', { bytes: dbBytes });
    if (!backup) throw damaged('its database is damaged');
    staged = { bytes: dbBytes, manifest, written };
    return { made: manifest.made, from: manifest.from, now, backup };
  } catch (err) {
    removeFiles(written.map((n) => n.slice('files/'.length)), f);
    throw err;
  }
}

// Step 2, after the owner said yes: the phone database is replaced, then saved to the data folder the usual way
// (.tmp + rename), so the folder keeps the current records until the new ones are complete there. If the app dies
// before that, the next start opens the folder's (current) records again. Files only the replaced records had go after.
export async function applyRestore() {
  const { bytes, manifest } = staged;
  staged = null;
  phoneState = await call('import', { bytes, saved: { folder } });
  await call('noteBackup', { at: manifest.made }); // what is in the app now was backed up then
  await save();
  const { names } = await native('list', { folder: where(folder), dir: 'files' });
  await call('sweep', { names });
}

export function cancelRestore() {
  if (staged) removeFiles(staged.written.map((n) => n.slice('files/'.length)));
  staged = null;
}
