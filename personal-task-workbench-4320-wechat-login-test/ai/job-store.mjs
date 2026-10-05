import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const stores = new Map();

// Separate from notebook.json: model checkpoints must not rewrite/synchronize
// the entire notebook. SQLite also makes receipt + manifest commits atomic
// across process interruption and separate processes sharing the same profile.
export function createJobStore(file) {
  const key = resolve(file);
  function store() {
    if (!stores.has(key)) {
      mkdirSync(dirname(key), { recursive: true });
      const { DatabaseSync } = require('node:sqlite');
      const connection = new DatabaseSync(key);
      try {
        connection.exec('PRAGMA busy_timeout=1500; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
        connection.exec('CREATE TABLE IF NOT EXISTS organization_docs (id TEXT PRIMARY KEY, document TEXT NOT NULL)');
        stores.set(key, { connection, chain: Promise.resolve() });
      } catch (error) { connection.close(); throw error; }
    }
    return stores.get(key);
  }
  const collection = (connection, name) => {
    if (name !== 'ai_runs') throw new Error('Unsupported organization collection');
    return { doc: (id) => ({
      get: async () => {
        const row = connection.prepare('SELECT document FROM organization_docs WHERE id=?').get(id);
        return { data: row ? [JSON.parse(row.document)] : [] };
      },
      set: async (document) => {
        connection.prepare('INSERT INTO organization_docs (id, document) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET document=excluded.document')
          .run(id, JSON.stringify(document));
        return {};
      },
    }) };
  };
  return {
    collection: (name) => collection(store().connection, name),
    runTransaction(callback) {
      const current = store();
      const operation = current.chain.then(async () => {
        const connection = current.connection;
        connection.exec('BEGIN IMMEDIATE');
        try {
          const result = await callback({ collection: (name) => collection(connection, name) });
          connection.exec('COMMIT');
          return result;
        } catch (error) {
          connection.exec('ROLLBACK');
          throw error;
        }
      });
      current.chain = operation.catch(() => {});
      return operation;
    },
    async close() {
      const current = stores.get(key);
      if (!current) return;
      await current.chain;
      if (stores.get(key) === current) { current.connection.close(); stores.delete(key); }
    },
  };
}
