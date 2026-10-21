// Gives a @sqlite.org/sqlite-wasm database (oo1 DB) the small part of the node:sqlite API the shared rules use:
// prepare(sql).get/all/run with positional values, and exec. Synchronous, like node:sqlite.
// onCommit (optional) runs after every change that is committed, e.g. to save a copy of the database.
export function wrapWasmDb(sqlite3, wdb, onCommit = () => {}) {
  const rows = (sql, values) => wdb.exec({ sql, bind: values.length ? values : undefined, rowMode: 'object', returnValue: 'resultRows' });
  const committed = () => sqlite3.capi.sqlite3_get_autocommit(wdb) && onCommit();
  return {
    exec(sql) {
      wdb.exec(sql);
      committed();
    },
    prepare: (sql) => ({
      all: (...values) => rows(sql, values),
      get: (...values) => rows(sql, values)[0],
      run(...values) {
        rows(sql, values);
        // node:sqlite returns plain numbers here; the wasm build returns the row id as a BigInt.
        const result = { changes: wdb.changes(), lastInsertRowid: Number(sqlite3.capi.sqlite3_last_insert_rowid(wdb)) };
        committed();
        return result;
      },
    }),
  };
}
