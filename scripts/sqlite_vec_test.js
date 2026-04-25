const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');
const db = new Database(':memory:');
try {
  sqliteVec.load(db);
  const v = db.prepare('SELECT vec_version() AS version').get();
  console.log('OK_VERSION:' + v.version);
  db.exec('CREATE VIRTUAL TABLE t USING vec0(id INTEGER PRIMARY KEY, e float[4])');
  db.prepare('INSERT INTO t(id, e) VALUES (?, ?)').run(1, Buffer.from(new Float32Array([0.1,0.2,0.3,0.4]).buffer));
  db.prepare('INSERT INTO t(id, e) VALUES (?, ?)').run(2, Buffer.from(new Float32Array([0.9,0.8,0.7,0.6]).buffer));
  const q = Buffer.from(new Float32Array([0.11,0.21,0.31,0.41]).buffer);
  const rows = db.prepare('SELECT id, distance FROM t WHERE e MATCH ? AND k=2 ORDER BY distance').all(q);
  console.log('OK_SEARCH:' + JSON.stringify(rows));
} catch (e) {
  console.log('FAIL:' + e.message);
}
process.exit(0);
