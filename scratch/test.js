const Database = require('better-sqlite3');
const db = new Database('database/cafe.db');
console.log(db.prepare("SELECT datetime('2026-05-07 04:30 PM') as d").get());
