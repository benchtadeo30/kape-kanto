const sqlite3 = require('better-sqlite3');
const db = new sqlite3('database/cafe.db');
const result = db.prepare("UPDATE promos SET start_date = '2026-05-15 00:00:00' WHERE id = 2").run();
console.log(result);
process.exit(0);
