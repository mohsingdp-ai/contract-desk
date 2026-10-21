// Phone only: the one Web Worker that owns the phone database (sqlite-wasm, "opfs-sahpool" storage) and answers the
// app's requests with the shared rules, synchronously, like the desktop server. The screens talk to it by messages
// (phone.js). Folder I/O (the saved copy in Documents/Contract Desk) happens on the main thread, which has the native bridge.
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { setupDb, tx } from '../../core/schema.js';
import { wrapWasmDb } from '../../core/wasm-db.js';
import { createRules, errorReply } from '../../core/rules.js';
import { callRoute } from '../../core/routes.js';
import { COUNTS_SQL } from '../../core/backup.js';

const NAME = '/contracts.db';
// gen counts committed changes; saved records which folder file (and gen) the phone last saved or opened (decision-2).
const SYNC_STATE = `CREATE TABLE IF NOT EXISTS sync_state (id INTEGER PRIMARY KEY CHECK (id = 1), gen INTEGER NOT NULL DEFAULT 0, saved TEXT);
  INSERT OR IGNORE INTO sync_state (id) VALUES (1);`;

let sqlite3, pool, wdb, db, rules;
let folderFiles = new Set(); // 'files/<name>' present in the data folder, for the startup sweep
const post = (msg, transfer) => self.postMessage(msg, transfer);

function open() {
  wdb = new pool.OpfsSAHPoolDb(NAME);
  let dirty = false;
  const inner = wrapWasmDb(sqlite3, wdb, () => dirty && ((dirty = false), post({ type: 'changed' })));
  // Every change also bumps gen, in the same transaction, so a change the app was killed before saving is never mistaken
  // for one already in the folder. A statement outside a transaction gets its own.
  const bump = () => (wdb.exec('UPDATE sync_state SET gen = gen + 1 WHERE id = 1'), (dirty = true));
  db = {
    exec: inner.exec,
    prepare(sql) {
      const stmt = inner.prepare(sql);
      return {
        ...stmt,
        run: (...values) => {
          if (!sqlite3.capi.sqlite3_get_autocommit(wdb)) {
            const r = stmt.run(...values);
            bump();
            return r;
          }
          return tx(db, () => {
            const r = stmt.run(...values);
            bump();
            return r;
          });
        },
      };
    },
  };
  wdb.exec(SYNC_STATE);
  setupDb(db);
  rules = createRules({
    db,
    files: {
      remove: (names) => names.length && post({ type: 'remove', names }),
      list: () => [...folderFiles].map((p) => p.slice('files/'.length)),
      exists: (filePath) => folderFiles.has(filePath.replaceAll('\\', '/')),
    },
  });
}

const state = () => {
  const s = wdb.selectObject('SELECT gen, saved FROM sync_state WHERE id = 1');
  return { gen: s.gen, saved: s.saved ? JSON.parse(s.saved) : null };
};

// A copy of a database file, opened in memory: its record counts if it is a whole, healthy Contract Desk database, else null.
function inMemory(bytes) {
  const copy = new Uint8Array(bytes);
  copy[18] = copy[19] = 1; // a desktop file is in WAL mode, which an in-memory copy can't open
  const mem = new sqlite3.oo1.DB(':memory:');
  try {
    const p = sqlite3.wasm.allocFromTypedArray(copy);
    const flags = sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE;
    mem.checkRc(sqlite3.capi.sqlite3_deserialize(mem, 'main', p, copy.length, copy.length, flags));
    return mem;
  } catch (err) {
    mem.close();
    throw err;
  }
}
function inspect(bytes) {
  let mem;
  try {
    mem = inMemory(bytes);
    if (mem.selectValue('PRAGMA integrity_check') !== 'ok') return null;
    const counts = mem.selectObject(COUNTS_SQL); // throws without the app's tables
    setupDb(wrapWasmDb(sqlite3, mem)); // what opening it will do, tried on the copy: importing it can't trip over it
    return counts;
  } catch {
    return null; // e.g. not a database, or without the contracts table
  } finally {
    mem?.close();
  }
}
const healthy = (bytes) => !!inspect(bytes);

const ops = {
  async init() {
    try {
      if (typeof FileSystemSyncAccessHandle === 'undefined') throw new Error('no FileSystemSyncAccessHandle');
      sqlite3 = await sqlite3InitModule();
      pool = await sqlite3.installOpfsSAHPoolVfs({ name: 'contract-desk' });
    } catch (err) {
      return { webview: true, detail: String(err?.message || err) };
    }
    // Constraint failures are normal here (e.g. a duplicate Contract No.); don't log each one.
    const warn = sqlite3.config.warn;
    sqlite3.config.warn = (...a) => a[0] !== 'sqlite3_step() rc=' && warn(...a);
    open();
    return state();
  },
  healthy: ({ bytes }) => healthy(bytes),
  // Replace the phone database with a folder copy (desktop WAL files too: importDb switches the header to rollback mode).
  import({ bytes, saved }) {
    if (!healthy(bytes)) throw new Error('The contracts.db in that folder is damaged or not a Contract Desk database. Nothing was changed.');
    wdb.close();
    try {
      pool.importDb(NAME, new Uint8Array(bytes));
    } finally {
      open();
    }
    ops.setSaved({ saved: { ...saved, gen: state().gen } });
    return state();
  },
  // A checked backup replaces the phone database. The copy is prepared first, in memory, so the database that lands is
  // already complete: its last-backup time (when the backup was made) and a change counter one above the saved marker,
  // i.e. "the folder copy doesn't have these records yet". A kill at any point leaves either the old database or this
  // one, and with this one the next start saves it to the folder before tidying files (never the other way round).
  restore({ bytes, saved, at }) {
    const mem = inMemory(bytes);
    try {
      const m = wrapWasmDb(sqlite3, mem);
      m.exec(SYNC_STATE);
      setupDb(m);
      createRules({ db: m, files: {} }).noteBackup(at);
      const { gen } = mem.selectObject('SELECT gen FROM sync_state WHERE id = 1');
      m.prepare('UPDATE sync_state SET gen = ?, saved = ? WHERE id = 1').run(gen + 1, JSON.stringify({ ...saved, gen }));
      bytes = sqlite3.capi.sqlite3_js_db_export(mem);
    } finally {
      mem.close();
    }
    wdb.close();
    try {
      pool.importDb(NAME, bytes);
    } finally {
      open();
    }
    return state();
  },
  export() {
    const { gen } = state();
    const bytes = sqlite3.capi.sqlite3_js_db_export(wdb);
    return { bytes, gen };
  },
  // A backup: the database and the documents it lists, from the same moment.
  backupData() {
    const { bytes } = ops.export();
    return { bytes, docs: wdb.selectObjects('SELECT storage_name, file_path FROM documents'), counts: wdb.selectObject(COUNTS_SQL) };
  },
  // What a restore would replace (now) and bring (backup); backup is null when the database in the file is damaged.
  checkBackup: ({ bytes }) => ({ now: wdb.selectObject(COUNTS_SQL), backup: inspect(bytes) }),
  noteBackup: ({ at }) => rules.noteBackup(at),
  setSaved({ saved }) {
    wdb.exec({ sql: 'UPDATE sync_state SET saved = ? WHERE id = 1', bind: [JSON.stringify(saved)] });
    return state();
  },
  sweep({ names }) {
    folderFiles = new Set(names.map((n) => `files/${n}`));
    return rules.sweepOrphans();
  },
  filePaths: () => wdb.selectObjects('SELECT file_path, size_bytes FROM documents'),
  exportData: ({ query }) => rules.exportData(query), // the workbook itself is built on the main thread (phone.js)
  // Files already written to files/ by phone.js; on any problem the rules record nothing and remove them.
  addDocuments({ parentType, parentId, stored, meta }) {
    try {
      return rules.addDocuments(parentType, parentId, stored, meta);
    } catch (err) {
      throw new Error(errorReply(err).message);
    }
  },
  request: ({ method, url, body }) => (url === '/api/meta' ? { status: 200, data: rules.meta() } : callRoute(rules, method, url, body)),
};

self.onmessage = async ({ data: { id, op, ...args } }) => {
  try {
    const result = await ops[op](args);
    post({ id, result }, result?.bytes ? [result.bytes.buffer] : []);
  } catch (err) {
    post({ id, error: String(err?.message || err) });
  }
};
