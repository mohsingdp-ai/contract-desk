import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { setupDb } from '../core/schema.js';
import { wrapWasmDb } from '../core/wasm-db.js';

export function openDb(dataDir) {
  fs.mkdirSync(path.join(dataDir, 'files'), { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'contracts.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  setupDb(db);
  // Closing merges the WAL into contracts.db, so a closed app leaves one complete file that can be copied (e.g. to the phone).
  process.once('exit', () => db.isOpen && db.close());
  return db;
}

// Test engine (DB_ENGINE=wasm): the phone's SQLite build (@sqlite.org/sqlite-wasm) running the same shared rules.
// In Node it only has in-memory databases, so it loads contracts.db at start and writes it back after every
// committed change; restarts and tests that read the file still work. Not for real use: whole-file copies.
export async function openWasmDb(dataDir) {
  const { default: init } = await import('@sqlite.org/sqlite-wasm');
  const sqlite3 = await init();
  fs.mkdirSync(path.join(dataDir, 'files'), { recursive: true });
  const file = path.join(dataDir, 'contracts.db');
  const wdb = new sqlite3.oo1.DB(':memory:');
  if (fs.existsSync(file)) {
    const bytes = new Uint8Array(fs.readFileSync(file));
    const p = sqlite3.wasm.allocFromTypedArray(bytes);
    const flags = sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE;
    wdb.checkRc(sqlite3.capi.sqlite3_deserialize(wdb, 'main', p, bytes.length, bytes.length, flags));
  }
  const save = () => {
    fs.writeFileSync(file + '.tmp', sqlite3.capi.sqlite3_js_db_export(wdb));
    fs.renameSync(file + '.tmp', file);
  };
  const db = wrapWasmDb(sqlite3, wdb, save);
  db.close = () => wdb.close(); // before a restore swaps contracts.db
  setupDb(db);
  return db;
}
