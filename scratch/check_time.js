const path = require('path');
const { db } = require(path.resolve(__dirname, '../database/init'));

const nowLocal = db.prepare("SELECT datetime('now', 'localtime') as t").get().t;
const nowUTC = db.prepare("SELECT datetime('now') as t").get().t;
console.log("Local Time in SQLite:", nowLocal);
console.log("UTC Time in SQLite:", nowUTC);

// Check current promos in DB
const promos = db.prepare("SELECT promo_code, start_date, end_date FROM promos WHERE promo_code IN ('FUTURE50', 'EXPIRED50', 'ACTIVE50')").all();
console.log("Promos in DB:", JSON.stringify(promos, null, 2));
