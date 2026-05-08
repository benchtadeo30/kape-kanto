const { db } = require('../database/init');
const promos = db.prepare('SELECT id, title, promo_code, start_date, end_date FROM promos').all();
console.log(JSON.stringify(promos, null, 2));
process.exit(0);
